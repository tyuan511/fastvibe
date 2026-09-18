import { createServer } from "node:net";
import WebSocket from "ws";
import type { FastVibePaths } from "../engine/paths";
import type { RemoteHostConnectionState, RemoteHostProfile } from "@shared/remote-host";
import { readSshHosts, removeSshHost, saveSshHost } from "./ssh-hosts";
import { loadAgentRuntime, agentRuntimeTarget } from "./agent-runtime";
import { runSshCommand, SshTunnel } from "./ssh-tunnel";

export type SshManagerDeps = {
  paths: FastVibePaths;
  onState: (state: RemoteHostConnectionState) => void;
  onPush: (channel: string, payload: unknown) => void;
  log: { info(message: string): void; warn(message: string): void };
  /** Precompiled Linux Agent package source and release metadata. */
  agentRuntime: {
    version: string;
    artifactDirectory?: string;
    cacheDirectory?: string;
    releaseBaseUrl?: string;
  };
};

type LocalInvoke = () => Promise<unknown>;

/** Owns the selected SSH tunnel and proxies the shared API to the remote Agent. */
export class SshManager {
  #deps: SshManagerDeps;
  #tunnel: SshTunnel | null = null;
  #client: AgentClient | null = null;
  #output: string[] = [];
  #generation = 0;
  #state: RemoteHostConnectionState = { hostId: null, status: "disconnected" };

  constructor(deps: SshManagerDeps) {
    this.#deps = deps;
  }

  get state(): RemoteHostConnectionState { return this.#state; }
  hosts() { return readSshHosts(this.#deps.paths.sshHostsFile); }
  saveHost(host: RemoteHostProfile) { return saveSshHost(this.#deps.paths.sshHostsFile, host); }
  removeHost(id: string) {
    if (this.#state.hostId === id) void this.disconnect();
    return removeSshHost(this.#deps.paths.sshHostsFile, id);
  }

  /** Electron's transport calls this wrapper; the ordinary local table remains the fallback. */
  invoke(channel: string, payload: unknown, local: LocalInvoke): Promise<unknown> {
    const client = this.#client;
    if (!client || !proxyChannel(channel)) return local();
    return client.call(channel, payload);
  }

  async connect(hostId: string): Promise<RemoteHostConnectionState> {
    const snapshot = this.hosts();
    const profile = [...snapshot.saved, ...snapshot.discovered].find((item) => item.id === hostId);
    if (!profile) throw new Error("SSH 主机不存在");
    if (profile.authMethod === "password" && !profile.password) throw new Error("请填写 SSH 密码");
    if (profile.authMethod === "identity-file" && !profile.identityFile) throw new Error("请填写私钥路径");
    await this.disconnect();
    const generation = this.#generation;
    const localPort = profile.localPort ?? await freePort();
    if (generation !== this.#generation) return this.#state;
    const remotePort = profile.servicePort ?? 7777;
    this.#output = [];
    this.#setState({ hostId, status: "connecting", localPort, output: [] });
    const tunnel = new SshTunnel({
      host: profile,
      localPort,
      remotePort,
      password: profile.authMethod === "password" ? profile.password : undefined,
      onOutput: (text) => this.#appendOutput(text),
      onState: (state) => {
        if (generation !== this.#generation) return;
        if (state.status === "error") this.#setState({ hostId, status: "error", localPort, error: state.message });
        else if (state.status === "stopped" && this.#state.hostId === hostId) this.#setState({ hostId: null, status: "disconnected" });
      },
    });
    this.#tunnel = tunnel;
    try {
      this.#appendOutput("正在检测远程 Linux 架构…");
      const probe = await runSshCommand({
        host: profile,
        password: profile.authMethod === "password" ? profile.password : undefined,
        command: "uname -s; uname -m",
        timeoutMs: 20_000,
        onOutput: (text) => this.#appendOutput(text),
      });
      if (generation !== this.#generation) return this.#state;
      const [uname, machine] = probe.trim().split(/\s+/);
      const target = agentRuntimeTarget(uname ?? "", machine ?? "");
      const runtime = await loadAgentRuntime(this.#deps.agentRuntime, target, (message) => this.#appendOutput(message));
      if (generation !== this.#generation) return this.#state;
      await runSshCommand({
        host: profile,
        password: profile.authMethod === "password" ? profile.password : undefined,
        command: deployCommand(this.#deps.agentRuntime.version),
        input: runtime.archive,
        timeoutMs: 300_000,
        onOutput: (text) => this.#appendOutput(text),
      });
      if (generation !== this.#generation) return this.#state;
      await runSshCommand({
        host: profile,
        password: profile.authMethod === "password" ? profile.password : undefined,
        command: bootstrapCommand(remotePort),
        onOutput: (text) => this.#appendOutput(text),
      });
      if (generation !== this.#generation) return this.#state;
      await tunnel.start();
      let client!: AgentClient;
      client = await AgentClient.connect(
        localPort,
        (channel, payload) => this.#deps.onPush(channel, payload),
        () => {
          if (generation !== this.#generation) return;
          if (this.#client === client) {
            this.#client = null;
            this.#setState({ hostId, status: "error", localPort, error: "远程 Agent 连接已断开" });
          }
        },
      );
      this.#client = client;
      this.#setState({ hostId, status: "connected", localPort });
      this.#deps.log.info(`SSH tunnel connected host=${hostId} localPort=${localPort}`);
      return this.#state;
    } catch (error) {
      if (generation !== this.#generation) return this.#state;
      if (this.#client) this.#client.close();
      this.#client = null;
      if (this.#tunnel === tunnel) this.#tunnel = null;
      await tunnel.stop().catch(() => undefined);
      const message = agentConnectionError(error, remotePort);
      const detail = this.#output.at(-1);
      const visibleMessage = detail && !message.includes(detail) ? `${message}：${detail}` : message;
      this.#setState({ hostId, status: "error", localPort, error: visibleMessage, output: this.#output });
      throw new Error(visibleMessage);
    }
  }

  async disconnect(): Promise<RemoteHostConnectionState> {
    this.#generation += 1;
    this.#client?.close();
    this.#client = null;
    const tunnel = this.#tunnel;
    this.#tunnel = null;
    if (tunnel) await tunnel.stop();
    this.#setState({ hostId: null, status: "disconnected" });
    return this.#state;
  }

  #appendOutput(text: string): void {
    this.#deps.log.info(`[ssh] ${text.trimEnd()}`);
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      // macOS metadata is deliberately excluded from the archive; tolerate the same
      // harmless warning from an older remote tar instead of flooding the dialog.
      if (/^tar: Ignoring unknown extended header keyword/.test(line)) continue;
      this.#output.push(line);
    }
    this.#output = this.#output.slice(-30);
    this.#setState({ ...this.#state, output: [...this.#output] });
  }

  #setState(state: RemoteHostConnectionState): void { this.#state = state; this.#deps.onState(state); }
}

function deployCommand(version: string): string {
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
  const release = `~/.fastvibe-agent/releases/${safeVersion}`;
  return `mkdir -p ${release} && tar -xzf - -C ${release} && ln -sfn ${release} ~/.fastvibe-agent/current && echo '预编译 Agent 已部署'`;
}

function bootstrapCommand(port: number): string {
  const script = [
    "if [ ! -x ~/.fastvibe-agent/current/bin/node ] || [ ! -f ~/.fastvibe-agent/current/out/main/agent.js ]; then echo 'FastVibe Agent runtime upload is incomplete' >&2; exit 127; fi",
    `if command -v ss >/dev/null 2>&1 && ss -ltn | grep -q ':${port} '; then echo 'FastVibe Agent is already running'; exit 0; fi`,
    `nohup ~/.fastvibe-agent/current/bin/node ~/.fastvibe-agent/current/out/main/agent.js --headless --port ${port} >/tmp/fastvibe-agent-${port}.log 2>&1 </dev/null &`,
    "echo 'FastVibe Agent started in the background'",
  ].join("; ");
  return `sh -lc ${shellQuote(script)}`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function proxyChannel(channel: string): boolean {
  // Native folder picking must stay on the desktop. Remote projects use the explicit
  // projects:add-remote method after the SSH directory browser has selected a path.
  if (channel === "projects:add") return false;
  return channel.startsWith("engine:") || channel.startsWith("conversation:") || channel.startsWith("workspace:") ||
    channel.startsWith("project:") || channel.startsWith("projects:") || channel.startsWith("providers:") ||
    channel.startsWith("stats:") || channel.startsWith("settings:") || channel === "app:get-info";
}

class AgentClient {
  #socket: WebSocket;
  #onClosed: () => void;
  #nextId = 1;
  #pending = new Map<number, { resolve: (value: unknown) => void; reject: (error: Error) => void }>();

  private constructor(socket: WebSocket, onClosed: () => void) {
    this.#socket = socket;
    this.#onClosed = onClosed;
    socket.on("message", (data) => this.onMessage(String(data)));
    socket.on("close", () => {
      this.fail(new Error("远程 Agent 连接已断开"));
      this.#onClosed();
    });
    socket.on("error", (error) => this.fail(error instanceof Error ? error : new Error(String(error))));
  }

  static async connect(port: number, onPush: (channel: string, payload: unknown) => void, onClosed: () => void): Promise<AgentClient> {
    const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`);
    await new Promise<void>((resolve, reject) => {
      const fail = (error: Error) => { socket.removeAllListeners(); reject(error); };
      socket.once("error", (error) => fail(error instanceof Error ? error : new Error(String(error))));
      socket.once("open", () => socket.send(JSON.stringify({ type: "auth", token: "" })));
      socket.on("message", (data) => {
        try {
          const message = JSON.parse(String(data)) as { type?: string; ok?: boolean; error?: string };
          if (message.type !== "auth") return;
          if (message.ok === true) { socket.removeAllListeners("error"); resolve(); }
          else fail(new Error(message.error ?? "远程 Agent 鉴权失败"));
        } catch (error) { fail(error instanceof Error ? error : new Error(String(error))); }
      });
    });
    const client = new AgentClient(socket, onClosed);
    const original = client.onMessage.bind(client);
    socket.removeAllListeners("message");
    socket.on("message", (data) => {
      const message = JSON.parse(String(data)) as { push?: string; payload?: unknown };
      if (message.push) onPush(message.push, message.payload);
      else original(String(data));
    });
    return client;
  }

  call(method: string, payload: unknown): Promise<unknown> {
    const id = this.#nextId++;
    return new Promise((resolve, reject) => {
      this.#pending.set(id, { resolve, reject });
      this.#socket.send(JSON.stringify({ id, method, payload }));
    });
  }

  close(): void { this.#socket.close(); this.fail(new Error("远程 Agent 连接已关闭")); }

  private onMessage(raw: string): void {
    let message: { id?: number; ok?: boolean; result?: unknown; error?: string };
    try { message = JSON.parse(raw) as typeof message; } catch { return; }
    if (typeof message.id !== "number") return;
    const pending = this.#pending.get(message.id);
    if (!pending) return;
    this.#pending.delete(message.id);
    if (message.ok === true) pending.resolve(message.result);
    else pending.reject(new Error(message.error ?? "远程 Agent 请求失败"));
  }

  private fail(error: Error): void {
    for (const pending of this.#pending.values()) pending.reject(error);
    this.#pending.clear();
  }
}

function agentConnectionError(error: unknown, remotePort: number): string {
  const code = error && typeof error === "object" && "code" in error ? String(error.code) : "";
  const message = error instanceof Error ? error.message : String(error);
  if (code === "ECONNRESET" || code === "ECONNREFUSED" || /ECONNRESET|ECONNREFUSED/i.test(message)) {
    return `SSH 已连接，但远程 FastVibe Agent 未运行或远程 Agent 端口不是 ${remotePort}。请先启动 fastvibe-agent，或在主机配置中填写正确的远程 Agent 端口。`;
  }
  return message;
}

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("无法分配本地 SSH 转发端口");
  return port;
}
