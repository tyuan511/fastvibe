import http from "node:http";
import https from "node:https";
import { Agent, Dispatcher, ProxyAgent as FetchProxyAgent, getGlobalDispatcher, setGlobalDispatcher } from "undici";
import WebSocket from "ws";
import { ProxyAgent } from "proxy-agent";
import type { AgentConnectOpts } from "agent-base";
import { startProxyRelay } from "./proxy-relay.ts";

/** Resolve each request (including redirects) through Chromium's current system/PAC
 * decision. Never turn a failed resolution or proxy connection into a direct request. */
class RoutedDispatcher extends Dispatcher {
  #agents = new Map<string, Dispatcher>();
  #closed = false;
  #revision = 0;
  readonly #resolve: (url: string) => Promise<string>;
  constructor(resolve: (url: string) => Promise<string>) { super(); this.#resolve = resolve; }

  dispatch(options: Dispatcher.DispatchOptions, handler: Dispatcher.DispatchHandler): boolean {
    const revision = this.#revision;
    void this.#resolve(new URL(options.path, String(options.origin)).href).then((proxy) => {
      if (this.#closed || revision !== this.#revision) throw new Error("Proxy configuration changed");
      let agent = this.#agents.get(proxy);
      if (!agent) {
        // undici's SOCKS5 implementation resolves domain names at the proxy.
        agent = proxy ? new FetchProxyAgent({ uri: proxy.replace(/^socks5h:/, "socks5:"), proxyTunnel: false }) : new Agent();
        this.#agents.set(proxy, agent);
      }
      agent.dispatch(options, handler);
    }).catch((error: Error) => handler.onError?.(error));
    return true;
  }

  async reset(): Promise<void> {
    this.#revision += 1;
    const agents = [...this.#agents.values()];
    this.#agents.clear();
    await Promise.all(agents.map((agent) => agent.destroy()));
  }

  override async close(): Promise<void> { this.#closed = true; await this.reset(); }
  override async destroy(): Promise<void> { await this.close(); }
}

const PROXY_ENV = ["HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "http_proxy", "https_proxy", "all_proxy", "npm_config_proxy", "npm_config_https_proxy"];
const BYPASS_ENV = ["NO_PROXY", "no_proxy", "npm_config_noproxy"];

/** Installs before the engine starts, so SDKs that capture fetch/agents see it too.
 * The relay also makes PAC and SOCKS work for npm/git and HTTP-only SDK adapters.
 * Only this process and its descendants inherit these variables, never a login shell. */
export async function installNodeProxy(resolve: (url: string) => Promise<string>) {
  let relay: Awaited<ReturnType<typeof startProxyRelay>> | undefined;
  let error: unknown;
  const resolveSafe = (url: string) => error ? Promise.reject(new Error("Proxy relay unavailable")) : resolve(url);
  const previous = {
    dispatcher: getGlobalDispatcher(), http: http.globalAgent, https: https.globalAgent,
    websocket: globalThis.WebSocket,
    env: new Map([...PROXY_ENV, ...BYPASS_ENV].map((key) => [key, process.env[key]])),
  };
  const dispatcher = new RoutedDispatcher(resolveSafe);
  let revision = 0;
  const requests = new Set<http.ClientRequest>();
  class TrackedProxyAgent extends ProxyAgent {
    #revision = revision;
    override async connect(req: http.ClientRequest, options: AgentConnectOpts): Promise<http.Agent> {
      if (this.#revision !== revision) throw new Error("Proxy configuration changed");
      requests.add(req);
      req.once("close", () => requests.delete(req));
      const target = await super.connect(req, options);
      if (this.#revision !== revision) throw new Error("Proxy configuration changed");
      return target;
    }
  }
  let agent = new TrackedProxyAgent({ getProxyForUrl: resolveSafe });
  const assignAgents = () => {
    http.globalAgent = agent;
    // ProxyAgent supports both protocols; Node's declaration only accepts https.Agent.
    https.globalAgent = agent as unknown as https.Agent;
  };
  assignAgents();
  setGlobalDispatcher(dispatcher);
  // Upgraded sockets leave HTTP connection pools. Track them explicitly, otherwise
  // Codex can keep using a pre-switch direct connection for later prompts.
  const sockets = new Set<WebSocket>();
  class RoutedWebSocket extends WebSocket {
    constructor(url: string | URL, protocols?: string | string[] | { protocols?: string | string[]; headers?: HeadersInit }) {
      const init = protocols && typeof protocols === "object" && !Array.isArray(protocols) ? protocols : undefined;
      super(url, init?.protocols ?? (init ? [] : protocols as string | string[] | undefined), {
        agent,
        headers: init?.headers ? Object.fromEntries(new Headers(init.headers).entries()) : undefined,
      });
      sockets.add(this);
      // terminate() also aborts an in-flight handshake, whose error must be observed.
      this.on("error", () => undefined);
      this.once("close", () => sockets.delete(this));
    }
  }
  const closeSockets = () => {
    revision += 1;
    for (const socket of sockets) socket.terminate();
    sockets.clear();
    for (const request of requests) request.destroy(new Error("Proxy configuration changed"));
    requests.clear();
  };
  globalThis.WebSocket = RoutedWebSocket as unknown as typeof globalThis.WebSocket;
  const startRelay = async () => {
    relay = await startProxyRelay(resolveSafe);
    for (const key of PROXY_ENV) process.env[key] = relay.url;
    error = undefined;
  };
  // If listening fails, keep the network blocked but let the settings window open.
  // A subsequent apply retries setup rather than requiring a restart.
  for (const key of PROXY_ENV) process.env[key] = "http://127.0.0.1:9";
  for (const key of BYPASS_ENV) process.env[key] = "localhost,127.0.0.1,::1";
  try { await startRelay(); } catch (cause) { error = cause; }
  const destroyAgent = (value: ProxyAgent) => {
    value.destroy(); value.httpAgent.destroy(); value.httpsAgent.destroy();
  };
  return {
    get error() { return error; },
    async reset() {
      if (!relay) await startRelay();
      closeSockets();
      const old = agent;
      agent = new TrackedProxyAgent({ getProxyForUrl: resolveSafe });
      assignAgents();
      destroyAgent(old);
      relay?.reset();
      await dispatcher.reset();
    },
    async close() {
      closeSockets();
      http.globalAgent = previous.http;
      https.globalAgent = previous.https;
      globalThis.WebSocket = previous.websocket;
      setGlobalDispatcher(previous.dispatcher);
      for (const [key, value] of previous.env) {
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
      destroyAgent(agent);
      await Promise.all([dispatcher.close(), relay?.close()]);
    },
  };
}
