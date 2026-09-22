import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { RemoteHostProfile } from "@shared/remote-host";

export type SshHostProfile = Omit<RemoteHostProfile, "label"> & { label?: string };

export type SshTunnelOptions = {
  host: SshHostProfile;
  localPort: number;
  remotePort: number;
  /** Address on the remote side. Kept loopback-only by default. */
  remoteHost?: string;
  /** Password authentication is carried through OpenSSH's askpass hook, never argv. */
  password?: string;
  /** Time to wait for the forwarded service to accept a TCP connection. */
  connectTimeoutMs?: number;
  sshBinary?: string;
  env?: NodeJS.ProcessEnv;
  onOutput?: (text: string) => void;
  onState?: (state: SshTunnelState) => void;
  signal?: AbortSignal;
  /** Reuse an already authenticated SSH connection instead of handshaking again. */
  controlPath?: string;
};

export type SshCommandOptions = {
  host: SshHostProfile;
  command: string;
  password?: string;
  sshBinary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onOutput?: (text: string) => void;
  /** Bytes sent to the remote command's stdin, used for the Agent runtime archive. */
  input?: Buffer;
  signal?: AbortSignal;
  /** Reuse an already authenticated SSH connection instead of handshaking again. */
  controlPath?: string;
};

export type SshTunnelState =
  | { status: "idle" }
  | { status: "starting" }
  | { status: "online" }
  | { status: "stopped" }
  | { status: "error"; message: string };

/**
 * Build arguments for a local SSH port forward.
 *
 * The command deliberately relies on the user's OpenSSH host-key policy and forces
 * strict checking. The first connection should be enrolled separately (for example by
 * running ssh-keyscan after the user has verified the fingerprint), never by silently
 * accepting a key from a GUI-launched child process.
 */
export function buildSshTunnelArgs(options: SshTunnelOptions): string[] {
  const { host, localPort, remotePort } = options;
  if (!Number.isInteger(localPort) || localPort < 1 || localPort > 65_535) {
    throw new Error("SSH 本地端口无效");
  }
  if (!Number.isInteger(remotePort) || remotePort < 1 || remotePort > 65_535) {
    throw new Error("SSH 远程端口无效");
  }
  if (!host.host.trim()) throw new Error("SSH 主机不能为空");
  if (host.port !== undefined && (!Number.isInteger(host.port) || host.port < 1 || host.port > 65_535)) {
    throw new Error("SSH 主机端口无效");
  }

  const destination = host.user?.trim() ? `${host.user.trim()}@${host.host.trim()}` : host.host.trim();
  const args = [
    "-N",
    "-T",
    "-o",
    `BatchMode=${options.controlPath || !options.password ? "yes" : "no"}`,
    "-o",
    "ExitOnForwardFailure=yes",
    "-o",
    "StrictHostKeyChecking=yes",
    "-o",
    "ServerAliveInterval=30",
    "-o",
    "ServerAliveCountMax=3",
    "-o",
    "ConnectTimeout=10",
  ];
  if (host.port !== undefined) args.push("-p", String(host.port));
  if (host.identityFile?.trim()) args.push("-i", host.identityFile.trim());
  if (host.knownHostsFile?.trim()) args.push("-o", `UserKnownHostsFile=${host.knownHostsFile.trim()}`);
  if (options.controlPath) args.push("-S", options.controlPath, "-o", "ControlMaster=no");
  args.push("-L", `${localPort}:${options.remoteHost?.trim() || "127.0.0.1"}:${remotePort}`, destination);
  return args;
}

async function waitForForward(child: ChildProcess, port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  while (Date.now() < deadline) {
    if (child.exitCode !== null || child.signalCode !== null) {
      throw new Error("SSH 隧道进程提前退出");
    }
    try {
      await new Promise<void>((resolve, reject) => {
        const socket = createConnection({ host: "127.0.0.1", port });
        socket.once("connect", () => {
          socket.destroy();
          resolve();
        });
        socket.once("error", (error) => {
          socket.destroy();
          reject(error);
        });
      });
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }
  throw new Error(`SSH 隧道未能连接本地转发端口（${port}）`);
}

/**
 * Owns one SSH forwarding process. It is intentionally unaware of Electron and of the
 * remote FastVibe protocol: the tunnel is only a transport, so it can later be reused by
 * the desktop client and by tests without pulling the renderer or the engine into it.
 */
export class SshTunnel {
  #options: SshTunnelOptions;
  #child: ChildProcess | null = null;
  #askpassFile: string | null = null;
  #state: SshTunnelState = { status: "idle" };
  #stopping = false;

  constructor(options: SshTunnelOptions) {
    this.#options = options;
  }

  get state(): SshTunnelState {
    return this.#state;
  }

  get running(): boolean {
    return this.#child !== null && this.#state.status === "online";
  }

  async start(): Promise<void> {
    if (this.#child) return;
    if (this.#options.signal?.aborted) throw new Error("远程连接已取消");
    const binary = this.#options.sshBinary?.trim() || "ssh";
    const args = buildSshTunnelArgs(this.#options);
    this.#stopping = false;
    this.#setState({ status: "starting" });

    const env = { ...(this.#options.env ?? process.env) };
    if (this.#options.password && !this.#options.controlPath) {
      this.#askpassFile = createAskpass();
      env.SSH_ASKPASS = this.#askpassFile;
      env.SSH_ASKPASS_REQUIRE = "force";
      env.DISPLAY ||= "fastvibe-ssh";
      env.FASTVIBE_SSH_PASSWORD = this.#options.password;
    }
    const child = spawn(binary, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env,
      windowsHide: true,
    });
    this.#child = child;
    child.stdout?.setEncoding("utf8");
    child.stderr?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string | Buffer) => this.#options.onOutput?.(String(chunk)));
    child.stderr?.on("data", (chunk: string | Buffer) => this.#options.onOutput?.(String(chunk)));
    child.once("error", (error) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#removeAskpass();
      this.#setState({ status: "error", message: error.message });
    });
    child.once("exit", (code, signal) => {
      if (this.#child !== child) return;
      this.#child = null;
      this.#removeAskpass();
      if (this.#stopping) {
        if (this.#state.status !== "error") this.#setState({ status: "stopped" });
        return;
      }
      const detail = signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`;
      this.#setState({ status: "error", message: `SSH 隧道已断开（${detail}）` });
    });

    const onAbort = (): void => {
      this.#stopping = true;
      if (this.#child === child) child.kill();
    };
    this.#options.signal?.addEventListener("abort", onAbort, { once: true });
    try {
      // `spawn` succeeding only means the local process was created. Wait for the local
      // forwarding socket so callers do not race the SSH handshake with their WebSocket.
      await waitForForward(child, this.#options.localPort, this.#options.connectTimeoutMs ?? 10_000);
      if (this.#options.signal?.aborted) throw new Error("远程连接已取消");
      if (this.#child !== child) throw new Error("SSH 隧道在启动时已断开");
      this.#setState({ status: "online" });
    } catch (error: unknown) {
      this.#stopping = true;
      const failure = this.#options.signal?.aborted
        ? new Error("远程连接已取消")
        : error instanceof Error ? error : new Error(String(error));
      this.#setState({ status: "error", message: failure.message });
      if (this.#child === child) child.kill();
      throw failure;
    } finally {
      this.#options.signal?.removeEventListener("abort", onAbort);
    }
  }

  async stop(): Promise<void> {
    const child = this.#child;
    if (!child) {
      this.#removeAskpass();
      if (this.#state.status !== "idle") this.#setState({ status: "stopped" });
      return;
    }
    this.#stopping = true;
    child.kill();
    await new Promise<void>((resolve) => {
      if (this.#child !== child) {
        resolve();
        return;
      }
      child.once("exit", () => resolve());
      setTimeout(() => {
        if (this.#child === child) child.kill("SIGKILL");
        resolve();
      }, 2_000).unref();
    });
  }

  #removeAskpass(): void {
    if (!this.#askpassFile) return;
    try { unlinkSync(this.#askpassFile); } catch { /* already removed */ }
    this.#askpassFile = null;
  }

  #setState(state: SshTunnelState): void {
    this.#state = state;
    this.#options.onState?.(state);
  }
}

export async function runSshCommand(options: SshCommandOptions): Promise<string> {
  if (options.signal?.aborted) throw new Error("远程连接已取消");
  const binary = options.sshBinary?.trim() || "ssh";
  const host = options.host;
  const destination = host.user?.trim() ? `${host.user.trim()}@${host.host.trim()}` : host.host.trim();
  const args = options.controlPath
    ? ["-S", options.controlPath, "-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no"]
    : ["-T", "-o", `BatchMode=${options.password ? "no" : "yes"}`, "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10"];
  if (!options.controlPath && host.port !== undefined) args.push("-p", String(host.port));
  if (!options.controlPath && host.identityFile?.trim()) args.push("-i", host.identityFile.trim());
  if (!options.controlPath && host.knownHostsFile?.trim()) args.push("-o", `UserKnownHostsFile=${host.knownHostsFile.trim()}`);
  args.push(destination, options.command);

  const env = { ...(options.env ?? process.env) };
  let askpassFile: string | null = null;
  if (options.password && !options.controlPath) {
    askpassFile = createAskpass();
    env.SSH_ASKPASS = askpassFile;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY ||= "fastvibe-ssh";
    env.FASTVIBE_SSH_PASSWORD = options.password;
  }
  const child = spawn(binary, args, { stdio: ["pipe", "pipe", "pipe"], env, windowsHide: true });
  let output = "";
  const emit = (chunk: string | Buffer) => {
    const text = String(chunk);
    output += text;
    options.onOutput?.(text);
  };
  if (options.input) child.stdin?.end(options.input);
  else child.stdin?.end();
  child.stdout?.setEncoding("utf8");
  child.stderr?.setEncoding("utf8");
  child.stdout?.on("data", emit);
  child.stderr?.on("data", emit);
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (fn: () => void): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        options.signal?.removeEventListener("abort", onAbort);
        fn();
      };
      const onAbort = (): void => {
        child.kill("SIGTERM");
        finish(() => reject(new Error("远程连接已取消")));
      };
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error("SSH 远程初始化超时")));
      }, options.timeoutMs ?? 20_000);
      options.signal?.addEventListener("abort", onAbort, { once: true });
      child.once("error", (error) => finish(() => reject(error)));
      child.once("exit", (code, signal) => {
        if (options.signal?.aborted) {
          finish(() => reject(new Error("远程连接已取消")));
          return;
        }
        if (code === 0) finish(() => resolve());
        else finish(() => reject(new Error(`SSH 远程初始化失败（${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}）`)));
      });
    });
  } finally {
    if (askpassFile) {
      try { unlinkSync(askpassFile); } catch { /* already removed */ }
    }
  }
  return output;
}

function createAskpass(): string {
  const file = join(tmpdir(), `fastvibe-ssh-askpass-${process.pid}-${randomUUID()}.sh`);
  writeFileSync(file, '#!/bin/sh\nprintf \'%s\\n\' "$FASTVIBE_SSH_PASSWORD"\n', { mode: 0o700 });
  chmodSync(file, 0o700);
  return file;
}

export type SshMaster = {
  /** Control socket later commands and the tunnel attach to, so they skip the handshake. */
  socket: string;
  close: () => Promise<void>;
};

/**
 * One authenticated SSH connection that later commands and the port forward reuse.
 *
 * A reconnect used to open a fresh SSH process for the probe, the version check, the
 * bootstrap and the tunnel. Each one repeated the handshake, and a password host asked
 * again every time. The remote Agent stays running either way; this only keeps the
 * transport from starting over.
 */
export async function startSshMaster(options: {
  host: RemoteHostProfile;
  password?: string;
  sshBinary?: string;
  env?: NodeJS.ProcessEnv;
  signal?: AbortSignal;
}): Promise<SshMaster> {
  if (options.signal?.aborted) throw new Error("远程连接已取消");
  const host = options.host;
  if (!host.host.trim()) throw new Error("SSH 主机不能为空");
  const destination = host.user?.trim() ? `${host.user.trim()}@${host.host.trim()}` : host.host.trim();
  // OpenSSH rejects a control socket whose path exceeds the platform's sun_path, and macOS
  // tmpdir is already most of that budget. /tmp keeps it short.
  const socket = `/tmp/fv-${process.pid}-${randomUUID().slice(0, 8)}`;
  const args = [
    "-M", "-S", socket, "-N", "-T",
    "-o", "ControlPersist=no",
    "-o", `BatchMode=${options.password ? "no" : "yes"}`,
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
  ];
  if (host.port !== undefined) args.push("-p", String(host.port));
  if (host.identityFile?.trim()) args.push("-i", host.identityFile.trim());
  if (host.knownHostsFile?.trim()) args.push("-o", `UserKnownHostsFile=${host.knownHostsFile.trim()}`);
  args.push(destination);

  const env = { ...(options.env ?? process.env) };
  let askpassFile: string | null = null;
  if (options.password) {
    askpassFile = createAskpass();
    env.SSH_ASKPASS = askpassFile;
    env.SSH_ASKPASS_REQUIRE = "force";
    env.DISPLAY ||= "fastvibe-ssh";
    env.FASTVIBE_SSH_PASSWORD = options.password;
  }
  const child = spawn(options.sshBinary?.trim() || "ssh", args, { stdio: ["ignore", "pipe", "pipe"], env, windowsHide: true });
  let stderr = "";
  child.stderr?.setEncoding("utf8");
  child.stderr?.on("data", (chunk: string | Buffer) => { stderr += String(chunk); });
  const removeAskpass = () => {
    if (!askpassFile) return;
    try { unlinkSync(askpassFile); } catch { /* already removed */ }
    askpassFile = null;
  };
  try {
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        finish(() => reject(new Error("SSH 连接超时")));
      }, 20_000);
      const onAbort = () => {
        child.kill("SIGTERM");
        finish(() => reject(new Error("远程连接已取消")));
      };
      options.signal?.addEventListener("abort", onAbort, { once: true });
      const finish = (result: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearInterval(ready);
        options.signal?.removeEventListener("abort", onAbort);
        result();
      };
      const ready = setInterval(() => {
        if (!existsSync(socket)) return;
        finish(resolve);
      }, 50);
      child.once("error", (error) => {
        clearInterval(ready);
        finish(() => reject(error));
      });
      child.once("exit", (code, signal) => {
        clearInterval(ready);
        const detail = stderr.trim().split("\n").at(-1);
        finish(() => reject(new Error(detail || `SSH 连接失败（${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}）`)));
      });
    });
  } catch (error) {
    removeAskpass();
    try { unlinkSync(socket); } catch { /* not created */ }
    throw error;
  }
  removeAskpass();
  let closed = false;
  return {
    socket,
    close: async () => {
      if (closed) return;
      closed = true;
      await new Promise<void>((resolve) => {
        const exit = spawn(options.sshBinary?.trim() || "ssh", ["-S", socket, "-O", "exit", destination], { stdio: "ignore", windowsHide: true });
        const timer = setTimeout(() => { exit.kill("SIGTERM"); resolve(); }, 2_000);
        exit.once("exit", () => { clearTimeout(timer); resolve(); });
        exit.once("error", () => { clearTimeout(timer); resolve(); });
      });
      if (child.exitCode === null && !child.killed) child.kill("SIGTERM");
      try { unlinkSync(socket); } catch { /* already removed */ }
    },
  };
}
