import http, { type IncomingHttpHeaders } from "node:http";
import https from "node:https";
import net from "node:net";
import { randomBytes, timingSafeEqual } from "node:crypto";
import type { Duplex } from "node:stream";
import { ProxyAgent } from "proxy-agent";
import { Agent, type AgentConnectOpts } from "agent-base";
import tls from "node:tls";
import { once } from "node:events";

const CONNECT_TIMEOUT = 30_000;
const IDLE_TIMEOUT = 120_000;
const HOP_HEADERS = ["connection", "proxy-connection", "keep-alive", "proxy-authenticate", "proxy-authorization", "te", "trailer", "transfer-encoding", "upgrade"];

function headersWithoutHop(headers: IncomingHttpHeaders): IncomingHttpHeaders {
  const result = { ...headers };
  const named = (headers.connection ?? "").split(",").map((s) => s.trim().toLowerCase());
  for (const name of [...HOP_HEADERS, ...named]) delete result[name];
  return result;
}

function targetUrl(raw: string): URL {
  if (!/^https?:\/\//i.test(raw) || /[\s\\]/.test(raw)) throw new Error("Absolute HTTP URL required");
  const url = new URL(raw);
  if (!url.hostname || url.username || url.password || url.hash || url.port === "0") throw new Error("Invalid target");
  return url;
}

function upstreamUrl(raw: string): string {
  if (!raw) return "";
  const url = new URL(raw);
  if (!["http:", "https:", "socks5:", "socks5h:"].includes(url.protocol) || !url.hostname || url.hash || url.search || url.pathname !== "/" && url.pathname !== "") {
    throw new Error("Unsupported proxy");
  }
  return url.href;
}

// Consume only handshake bytes, retaining any tunneled payload in the socket.
function readBytes(socket: net.Socket, count: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const cleanup = () => { socket.off("readable", ready).off("error", failed).off("close", ended).off("end", ended); };
    const failed = (error: Error) => { cleanup(); reject(error); };
    const ended = () => failed(new Error("Proxy closed during handshake"));
    const ready = () => {
      const bytes = socket.read(count) as Buffer | null;
      if (bytes) { cleanup(); resolve(bytes); }
      else if (socket.destroyed || socket.readableEnded) ended();
    };
    socket.on("readable", ready).once("error", failed).once("close", ended).once("end", ended);
    ready();
  });
}

function socksAddress(raw: string): Buffer {
  const host = raw.replace(/^\[|\]$/g, "");
  if (net.isIPv4(host)) return Buffer.from([1, ...host.split(".").map(Number)]);
  if (net.isIPv6(host)) {
    // URL canonicalisation also converts an embedded dotted IPv4 tail to hex.
    const canonical = new URL(`http://[${host}]/`).hostname.slice(1, -1);
    const [left, right] = canonical.split("::");
    const first = left ? left.split(":") : [];
    const last = right ? right.split(":") : [];
    const words = right === undefined ? first : [...first, ...Array<string>(8 - first.length - last.length).fill("0"), ...last];
    const address = Buffer.alloc(17);
    address[0] = 4;
    words.forEach((word, index) => address.writeUInt16BE(parseInt(word, 16), 1 + index * 2));
    return address;
  }
  // Names stay names: only the upstream proxy resolves target DNS.
  const name = Buffer.from(host);
  if (!name.length || name.length > 255) throw new Error("SOCKS address too long");
  return Buffer.concat([Buffer.from([3, name.length]), name]);
}

async function socksHandshake(socket: net.Socket, proxy: URL, host: string, port: number): Promise<net.Socket> {
  await once(socket, "connect");
  const user = Buffer.from(decodeURIComponent(proxy.username));
  const pass = Buffer.from(decodeURIComponent(proxy.password));
  const address = socksAddress(host);
  if (user.length > 255 || pass.length > 255) throw new Error("SOCKS credential too long");
  const authenticated = user.length > 0 || pass.length > 0;
  socket.write(Buffer.from([5, 1, authenticated ? 2 : 0]));
  const hello = await readBytes(socket, 2);
  if (hello[0] !== 5 || hello[1] !== (authenticated ? 2 : 0)) throw new Error("SOCKS authentication refused");
  if (authenticated) {
    socket.write(Buffer.concat([Buffer.from([1, user.length]), user, Buffer.from([pass.length]), pass]));
    const response = await readBytes(socket, 2);
    if (response[0] !== 1 || response[1] !== 0) throw new Error("SOCKS authentication failed");
  }
  // Remote DNS avoids leaking target hostnames to local resolvers.
  socket.write(Buffer.concat([Buffer.from([5, 1, 0]), address, Buffer.from([port >> 8, port & 255])]));
  const reply = await readBytes(socket, 4);
  if (reply[0] !== 5 || reply[1] !== 0 || reply[2] !== 0) throw new Error("SOCKS connection refused");
  const size = reply[3] === 1 ? 4 : reply[3] === 4 ? 16 : reply[3] === 3 ? (await readBytes(socket, 1))[0] : -1;
  if (size < 0) throw new Error("Invalid SOCKS reply");
  await readBytes(socket, size + 2);
  // Node updates readable-listener state on nextTick after removing the last
  // listener. Let that finish before a caller pipes/resumes the tunnel.
  await new Promise<void>((resolve) => process.nextTick(resolve));
  return socket;
}

/** Authenticated loopback proxy. Resolution failures never fall back to DIRECT. */
export async function startProxyRelay(resolveProxy: (url: string) => Promise<string>): Promise<{ url: string; reset(): void; close(): Promise<void> }> {
  const username = randomBytes(18).toString("hex");
  const password = randomBytes(24).toString("hex");
  const credential = Buffer.from(`Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`);
  const authenticated = (value: string | undefined): boolean => {
    const actual = Buffer.from(value ?? "");
    return actual.length === credential.length && timingSafeEqual(actual, credential);
  };
  // Never use agent:false: Node constructs globalAgent.constructor in that case,
  // and the application's global agents themselves point back at this relay.
  const directHttp = new http.Agent();
  const directHttps = new https.Agent();
  let closed = false;
  const sockets = new Set<Duplex>();
  const jobs = new Set<() => void>();
  const track = <T extends Duplex>(socket: T): T => {
    sockets.add(socket);
    socket.once("close", () => sockets.delete(socket));
    socket.on("error", () => {});
    if (closed) socket.destroy();
    return socket;
  };

  const connectSocks = async (proxy: string, host: string, port: number, signal: AbortSignal) => {
    const url = new URL(proxy);
    const socket = track(net.connect({ host: url.hostname.replace(/^\[|\]$/g, ""), port: Number(url.port || 1080) }));
    const abort = () => socket.destroy(new Error("Proxy connection cancelled"));
    signal.addEventListener("abort", abort, { once: true });
    socket.once("close", () => signal.removeEventListener("abort", abort));
    if (signal.aborted) abort();
    try { return await socksHandshake(socket, url, host, port); }
    catch (error) { socket.destroy(); throw error; }
  };

  const server = http.createServer(async (req, res) => {
    if (!authenticated(req.headers["proxy-authorization"])) {
      res.writeHead(407, { "Proxy-Authenticate": 'Basic realm="FastVibe relay"', Connection: "close" }).end();
      return;
    }
    let target: URL;
    try { target = targetUrl(req.url ?? ""); } catch { res.writeHead(400, { Connection: "close" }).end(); return; }
    const controller = new AbortController();
    let outgoing: http.ClientRequest | undefined;
    let agent: ProxyAgent | Agent | undefined;
    let done = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      jobs.delete(cleanup);
      controller.abort();
      outgoing?.destroy();
      agent?.destroy();
      if (agent instanceof ProxyAgent) {
        agent.httpAgent.destroy();
        agent.httpsAgent.destroy();
      }
    };
    const fail = () => {
      if (done) return;
      if (res.headersSent) res.destroy();
      else res.writeHead(502, { Connection: "close" }).end();
      cleanup();
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT);
    timer.unref();
    jobs.add(cleanup);
    res.once("close", cleanup);
    req.once("aborted", cleanup);
    try {
      const proxy = upstreamUrl(await resolveProxy(target.href));
      if (done || closed) return;
      if (proxy.startsWith("socks")) {
        agent = new class extends Agent {
          async connect(_req: http.ClientRequest, opts: AgentConnectOpts) {
            if (!opts.host) throw new Error("Missing target host");
            const socket = await connectSocks(proxy, opts.host, Number(opts.port), controller.signal);
            if (opts.secureEndpoint) return track(tls.connect({ socket, servername: net.isIP(opts.host) ? undefined : opts.host }));
            // readBytes uses paused reads; ClientRequest expects a flowing socket.
            socket.resume();
            return socket;
          }
        }();
      } else agent = new ProxyAgent({
        httpAgent: new http.Agent(),
        httpsAgent: new https.Agent(),
        getProxyForUrl: () => proxy,
        timeout: CONNECT_TIMEOUT,
        signal: controller.signal,
        socketOptions: { signal: controller.signal },
      });
      const headers = headersWithoutHop(req.headers);
      headers.host = target.host;
      outgoing = (target.protocol === "https:" ? https : http).request(target, { method: req.method, headers, agent }, (response) => {
        clearTimeout(timer);
        res.writeHead(response.statusCode ?? 502, headersWithoutHop(response.headers));
        response.on("error", fail);
        response.on("aborted", fail);
        response.pipe(res);
      });
      outgoing.on("socket", (socket) => { track(socket); if (done) socket.destroy(); });
      outgoing.on("proxy", ({ socket }: { socket: net.Socket }) => { track(socket); if (done) socket.destroy(); });
      outgoing.on("proxyConnect", (response: { statusCode: number }) => {
        if (target.protocol === "https:" && response.statusCode !== 200) fail();
      });
      outgoing.on("error", fail);
      outgoing.setTimeout(IDLE_TIMEOUT, fail);
      req.pipe(outgoing);
    } catch { fail(); }
  });

  server.on("connection", track);
  server.on("clientError", (_error, socket) => { socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n"); });
  server.on("connect", async (req, client, head) => {
    const reject = (status: number) => client.end(`HTTP/1.1 ${status} ${status === 407 ? "Proxy Authentication Required" : status === 400 ? "Bad Request" : "Bad Gateway"}\r\n${status === 407 ? 'Proxy-Authenticate: Basic realm="FastVibe relay"\r\n' : ""}Connection: close\r\n\r\n`);
    if (!authenticated(req.headers["proxy-authorization"])) { reject(407); return; }
    let target: URL;
    let port: number;
    try {
      const raw = req.url ?? "";
      if (!/^(?:\[[0-9a-fA-F:.]+\]|[^\s/:@?#\\]+):[0-9]+$/.test(raw)) throw new Error("Invalid authority");
      port = Number(raw.slice(raw.lastIndexOf(":") + 1));
      if (port < 1 || port > 65535) throw new Error("Invalid port");
      target = targetUrl(`https://${raw}`);
    } catch { reject(400); return; }
    const host = target.hostname.replace(/^\[|\]$/g, "");
    let upstream: net.Socket | undefined;
    let request: http.ClientRequest | undefined;
    const controller = new AbortController();
    let done = false;
    let established = false;
    const cleanup = () => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      jobs.delete(cleanup);
      controller.abort();
      request?.destroy();
      upstream?.destroy();
      client.destroy();
    };
    const fail = () => {
      if (done) return;
      if (!established) reject(502);
      // Let the error response flush before closing the local socket.
      if (!established) {
        done = true;
        clearTimeout(timer);
        jobs.delete(cleanup);
        controller.abort();
        request?.destroy();
        upstream?.destroy();
      } else cleanup();
    };
    const timer = setTimeout(fail, CONNECT_TIMEOUT);
    timer.unref();
    jobs.add(cleanup);
    client.once("close", cleanup);
    client.once("error", cleanup);
    const connected = (socket: net.Socket, buffered?: Buffer) => {
      track(socket);
      if (done || closed) { socket.destroy(); return; }
      upstream = socket;
      established = true;
      clearTimeout(timer);
      client.write("HTTP/1.1 200 Connection Established\r\n\r\n");
      socket.on("error", cleanup);
      socket.once("close", cleanup);
      socket.setTimeout(IDLE_TIMEOUT, cleanup);
      if (head.length) socket.write(head);
      if (buffered?.length) client.write(buffered);
      client.pipe(socket).pipe(client);
      socket.resume();
    };
    try {
      const proxy = upstreamUrl(await resolveProxy(target.href));
      if (done || closed) return;
      if (!proxy) {
        upstream = track(net.connect({ host, port }));
        upstream.once("error", fail);
        upstream.once("connect", () => connected(upstream!));
      } else if (proxy.startsWith("socks")) {
        const socket = await connectSocks(proxy, host, port, controller.signal);
        connected(socket);
      } else {
        const url = new URL(proxy);
        const headers: Record<string, string> = { Host: `${net.isIPv6(host) ? `[${host}]` : host}:${port}` };
        if (url.username || url.password) headers["Proxy-Authorization"] = `Basic ${Buffer.from(`${decodeURIComponent(url.username)}:${decodeURIComponent(url.password)}`).toString("base64")}`;
        // A real ClientRequest makes pending CONNECT sockets cancellable, including
        // proxies that accept TCP but never answer the handshake.
        request = (url.protocol === "https:" ? https : http).request(url, { method: "CONNECT", path: headers.Host, headers, agent: url.protocol === "https:" ? directHttps : directHttp });
        request.on("socket", track);
        request.once("connect", (response, socket, buffered) => {
          if (response.statusCode !== 200) { socket.destroy(); fail(); }
          else connected(socket, buffered);
        });
        request.once("response", fail);
        request.once("error", fail);
        request.end();
      }
    } catch { fail(); }
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address() as net.AddressInfo;
  let closing: Promise<void> | undefined;
  return {
    url: `http://${username}:${password}@127.0.0.1:${address.port}`,
    reset() {
      for (const cleanup of jobs) cleanup();
      for (const socket of sockets) socket.destroy();
    },
    close() {
      if (closing) return closing;
      closed = true;
      closing = new Promise<void>((resolve, reject) => {
        server.close((error) => error ? reject(error) : resolve());
        for (const cleanup of jobs) cleanup();
        for (const socket of sockets) socket.destroy();
        directHttp.destroy();
        directHttps.destroy();
      });
      return closing;
    },
  };
}
