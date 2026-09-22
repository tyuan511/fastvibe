import { chmodSync, existsSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import { createConnection } from "node:net";
import type { RemoteHostProfile, RemoteHostTestResult, SshErrorCode } from "@shared/remote-host";

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
  /** Bytes of `input` handed to ssh so far, for an upload progress bar. */
  onInputProgress?: (sent: number, total: number) => void;
  signal?: AbortSignal;
  /** Reuse an already authenticated SSH connection instead of handshaking again. */
  controlPath?: string;
};

/** An SSH failure OpenSSH explained well enough to decide what to do next. */
export class SshError extends Error {
  readonly code: SshErrorCode;
  constructor(message: string, code: SshErrorCode) {
    super(message);
    this.name = "SshError";
    this.code = code;
  }
}

/**
 * Read OpenSSH's own stderr for a failure worth acting on.
 *
 * Order matters: a changed key also prints "Host key verification failed", and must never
 * be mistaken for an unknown one — the unknown case is the only one the GUI offers to trust.
 */
export function classifySshFailure(text: string): SshErrorCode | undefined {
  if (/REMOTE HOST IDENTIFICATION HAS CHANGED|Host key for .* has changed/i.test(text)) return "host-key-changed";
  if (/Host key verification failed|No \S+ host key is known for/i.test(text)) return "host-key-unknown";
  if (/Permission denied|Too many authentication failures|Authentication failed|no more authentication methods/i.test(text)) return "auth-failed";
  return undefined;
}

/** The OpenSSH line that explains a failure: the last non-empty one it printed. */
function lastLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
}

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

  const destination = sshDestination(host);
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
  args.push(...explicitHostArgs(host));
  if (!options.controlPath) args.push(...passwordPromptArgs(options.password));
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

/** Wait for a forward the control master listens on; no child of ours to watch. */
async function waitForMasterForward(port: number, timeoutMs: number, signal?: AbortSignal): Promise<void> {
  const deadline = Date.now() + Math.max(250, timeoutMs);
  while (Date.now() < deadline) {
    if (signal?.aborted) throw new Error("远程连接已取消");
    const up = await new Promise<boolean>((resolve) => {
      const socket = createConnection({ host: "127.0.0.1", port });
      socket.once("connect", () => { socket.destroy(); resolve(true); });
      socket.once("error", () => { socket.destroy(); resolve(false); });
    });
    if (up) return;
    await new Promise((resolve) => setTimeout(resolve, 50));
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
  /** A forward added to the control master (`-O forward`), which owns it from then on. */
  #muxForward = false;

  constructor(options: SshTunnelOptions) {
    this.#options = options;
  }

  get state(): SshTunnelState {
    return this.#state;
  }

  get running(): boolean {
    return (this.#child !== null || this.#muxForward) && this.#state.status === "online";
  }

  async start(): Promise<void> {
    if (this.#child || this.#muxForward) return;
    if (this.#options.signal?.aborted) throw new Error("远程连接已取消");
    if (this.#options.controlPath) {
      await this.#startOnMaster(this.#options.controlPath);
      return;
    }
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

  /**
   * Ask the control master to listen, instead of running a client of our own.
   *
   * A mux client ignores `-N`: it opens a login session, which reads EOF from the
   * ignored stdin and exits at once — the forward stays up on the master, but the tunnel
   * looked "exited early" whenever that won the race with the port probe. `-O forward`
   * is the multiplexing way to say the same thing: it returns once the master listens.
   */
  async #startOnMaster(controlPath: string): Promise<void> {
    this.#stopping = false;
    this.#setState({ status: "starting" });
    try {
      await this.#control(controlPath, "forward");
      this.#muxForward = true;
      await waitForMasterForward(this.#options.localPort, this.#options.connectTimeoutMs ?? 10_000, this.#options.signal);
      if (this.#options.signal?.aborted) throw new Error("远程连接已取消");
      this.#setState({ status: "online" });
    } catch (error) {
      const failure = this.#options.signal?.aborted
        ? new Error("远程连接已取消")
        : error instanceof Error ? error : new Error(String(error));
      await this.stop().catch(() => undefined);
      this.#setState({ status: "error", message: failure.message });
      throw failure;
    }
  }

  /** `ssh -S <socket> -O forward|cancel -L <spec> <dest>`, resolved on exit 0. */
  #control(controlPath: string, operation: "forward" | "cancel"): Promise<void> {
    const binary = this.#options.sshBinary?.trim() || "ssh";
    const spec = `${this.#options.localPort}:${this.#options.remoteHost?.trim() || "127.0.0.1"}:${this.#options.remotePort}`;
    const args = ["-S", controlPath, "-O", operation, "-L", spec, sshDestination(this.#options.host)];
    return new Promise((resolve, reject) => {
      const child = spawn(binary, args, { stdio: ["ignore", "pipe", "pipe"], env: this.#options.env ?? process.env, windowsHide: true });
      let text = "";
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
      child.stderr?.setEncoding("utf8").on("data", (chunk: string) => { text += chunk; });
      const timer = setTimeout(() => child.kill("SIGTERM"), 10_000);
      child.once("error", (error) => { clearTimeout(timer); reject(error); });
      child.once("exit", (code) => {
        clearTimeout(timer);
        if (text.trim()) this.#options.onOutput?.(text);
        if (code === 0) resolve();
        else reject(new Error(lastLine(text) || `SSH 端口转发失败（exit ${code ?? "unknown"}）`));
      });
    });
  }

  async stop(): Promise<void> {
    if (this.#muxForward && this.#options.controlPath) {
      this.#muxForward = false;
      this.#stopping = true;
      // The master may already be gone (it takes its forwards with it); either way ends it.
      await this.#control(this.#options.controlPath, "cancel").catch(() => undefined);
      if (this.#state.status !== "error") this.#setState({ status: "stopped" });
      return;
    }
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

export type SshProbeResult = RemoteHostTestResult;

/**
 * A host read from `~/.ssh/config` is passed to OpenSSH by alias alone.
 *
 * The user, port and key parsed from that file are for display: OpenSSH resolves them
 * itself — `Match` blocks, first-value-wins, `Host *` defaults — and an explicit `-p` or
 * `user@` built from our reading of the file would override its answer with a worse one.
 */
function fromSshConfig(host: SshHostProfile): boolean {
  return host.source === "config";
}

/** `user@host`, or the bare host when no user is set (or the config decides it). */
export function sshDestination(host: SshHostProfile): string {
  const user = fromSshConfig(host) ? "" : host.user?.trim();
  return user ? `${user}@${host.host.trim()}` : host.host.trim();
}

/** `-p` / `-i` / known-hosts options FastVibe adds on top of the user's own ssh config. */
export function explicitHostArgs(host: SshHostProfile): string[] {
  const args: string[] = [];
  if (!fromSshConfig(host)) {
    if (host.port !== undefined) args.push("-p", String(host.port));
    if (host.identityFile?.trim()) args.push("-i", host.identityFile.trim());
  }
  if (host.knownHostsFile?.trim()) args.push("-o", `UserKnownHostsFile=${host.knownHostsFile.trim()}`);
  return args;
}

/**
 * Answer "can this machine log in to that host" in one round trip.
 *
 * Deliberately stops at the login: no Agent deploy, no port forward, nothing written to
 * the remote machine. The test exists to separate "my key is not loaded" from "the
 * tunnel came up but the remote Agent is not running", and it can only do that if it
 * performs *less* than a connect does.
 *
 * A failure is a value, not a rejection: the callers are a settings row and a toast, and
 * neither has anywhere to put an exception.
 */
export async function probeSshHost(options: {
  host: SshHostProfile;
  password?: string;
  sshBinary?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  signal?: AbortSignal;
  /** Run on the host after the login; its output comes back as `output`. Nothing by default. */
  command?: string;
}): Promise<SshProbeResult & { output?: string }> {
  const target = sshDestination(options.host);
  const seen: string[] = [];
  let output: string;
  try {
    output = await runSshCommand({
      host: options.host,
      command: options.command ?? "exit 0",
      ...(options.password ? { password: options.password } : {}),
      ...(options.sshBinary ? { sshBinary: options.sshBinary } : {}),
      ...(options.env ? { env: options.env } : {}),
      timeoutMs: options.timeoutMs ?? 15_000,
      ...(options.signal ? { signal: options.signal } : {}),
      onOutput: (text) => {
        for (const line of text.split(/\r?\n/)) {
          const trimmed = line.trim();
          if (trimmed) seen.push(trimmed);
        }
      },
    });
  } catch (error) {
    // OpenSSH writes its own reason to stderr before exiting 255, and that line says far
    // more than our exit-code wrapper (`Permission denied (publickey).`, `Connection
    // refused`, `Host key verification failed.`). Ours is the fallback, not the answer —
    // a timeout or a cancel prints nothing at all, and then there is nothing better.
    const errorCode = error instanceof SshError ? error.code : undefined;
    return {
      ok: false,
      target,
      error: seen.at(-1) || (error instanceof Error ? error.message : String(error)),
      ...(errorCode ? { errorCode } : {}),
    };
  }
  return options.command === undefined ? { ok: true, target } : { ok: true, target, output };
}

export async function runSshCommand(options: SshCommandOptions): Promise<string> {
  if (options.signal?.aborted) throw new Error("远程连接已取消");
  const binary = options.sshBinary?.trim() || "ssh";
  const host = options.host;
  const destination = sshDestination(host);
  const args = options.controlPath
    ? ["-S", options.controlPath, "-T", "-o", "BatchMode=yes", "-o", "ControlMaster=no"]
    : ["-T", "-o", `BatchMode=${options.password ? "no" : "yes"}`, "-o", "StrictHostKeyChecking=yes", "-o", "ConnectTimeout=10", ...passwordPromptArgs(options.password)];
  if (!options.controlPath) args.push(...explicitHostArgs(host));
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
  if (options.input) writeInput(child.stdin, options.input, options.onInputProgress);
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
        if (code === 0) {
          finish(() => resolve());
          return;
        }
        const message = `SSH 远程初始化失败（${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}）`;
        // 255 is OpenSSH's own failure; anything else is the remote command's exit code,
        // and a remote script is free to print "Permission denied" about its own files.
        const failure = code === 255 ? classifySshFailure(output) : undefined;
        finish(() => reject(failure ? new SshError(lastLine(output) || message, failure) : new Error(message)));
      });
    });
  } finally {
    if (askpassFile) {
      try { unlinkSync(askpassFile); } catch { /* already removed */ }
    }
  }
  return output;
}

/**
 * The askpass answers every prompt with the same saved password, so a second or third
 * prompt can only be refused again — while costing the server's failure delay each time.
 */
function passwordPromptArgs(password: string | undefined): string[] {
  return password ? ["-o", "NumberOfPasswordPrompts=1"] : [];
}

/**
 * Stream `input` into ssh in chunks, honouring backpressure, so the bytes that have left
 * this process can be counted. A single `end(buffer)` would be one opaque write.
 */
function writeInput(stdin: NodeJS.WritableStream | null, input: Buffer, onProgress?: (sent: number, total: number) => void): void {
  if (!stdin) return;
  const CHUNK = 256 * 1024;
  let offset = 0;
  stdin.on("error", () => undefined); // ssh exiting early is reported by its exit code
  const pump = (): void => {
    while (offset < input.length) {
      const next = input.subarray(offset, Math.min(offset + CHUNK, input.length));
      offset += next.length;
      const more = stdin.write(next);
      onProgress?.(offset, input.length);
      if (!more) {
        stdin.once("drain", pump);
        return;
      }
    }
    stdin.end();
  };
  pump();
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
  const destination = sshDestination(host);
  // OpenSSH rejects a control socket whose path exceeds the platform's sun_path, and macOS
  // tmpdir is already most of that budget. /tmp keeps it short.
  const socket = `/tmp/fv-${process.pid}-${randomUUID().slice(0, 8)}`;
  const args = [
    "-M", "-S", socket, "-N", "-T",
    "-o", "ControlPersist=no",
    "-o", `BatchMode=${options.password ? "no" : "yes"}`,
    ...passwordPromptArgs(options.password),
    "-o", "StrictHostKeyChecking=yes",
    "-o", "ServerAliveInterval=30",
    "-o", "ServerAliveCountMax=3",
    "-o", "ConnectTimeout=10",
  ];
  args.push(...explicitHostArgs(host));
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
        const detail = lastLine(stderr) || `SSH 连接失败（${signal ? `signal ${signal}` : `exit ${code ?? "unknown"}`}）`;
        const failure = classifySshFailure(stderr);
        finish(() => reject(failure ? new SshError(detail, failure) : new Error(detail)));
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
