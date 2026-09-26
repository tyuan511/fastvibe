import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { FastVibePaths } from "../engine/paths.ts";
import type { RemoteHostConnectionActivity, RemoteHostConnectionState, RemoteHostProfile, RemoteHostTestResult, RemoteTransferProgress, SshHostKeyScan } from "../../shared/remote-host.ts";
import { readSshHosts, redactSshHosts, removeSshHost, saveSshHost, type SecretBox, type SshHostSnapshot } from "./ssh-hosts.ts";
import { captureHostKey, writeTrustedHostKey, type CapturedHostKey } from "./ssh-known-hosts.ts";
import { loadAgentRuntime, agentRuntimeTarget, agentRuntimeRemoteDownloadCommand, agentRuntimeUploadCommand, sha256Helper, type AgentRuntimeSource, type AgentRuntimeTarget } from "./agent-runtime.ts";
import { downloadHelpers, loginEnvironment, NODE_MIRROR, remoteShellCommand, shellQuote } from "./remote-shell.ts";
import { probeSshHost, runSshCommand, SshError, SshTunnel, startSshMaster, type SshMaster } from "./ssh-tunnel.ts";

export type SshManagerDeps = {
  paths: FastVibePaths;
  onState: (state: RemoteHostConnectionState) => void;
  onPush: (channel: string, payload: unknown) => void;
  log: { info(message: string): void; warn(message: string): void };
  /** OS keychain for saved passwords; without one they stay in the 0600 file. */
  secrets?: SecretBox;
  /** Precompiled Linux Agent package source and release metadata. */
  agentRuntime: AgentRuntimeSource;
};

/**
 * SSH host profiles on disk.
 *
 * Connection lifecycle (tunnel, protocol client, one-host proxy) lives on
 * `RemoteConnectionManager`. This class keeps the constructor shape index still
 * constructs, and the hosts/saveHost/removeHost surface it still calls.
 */
export class SshManager {
  #deps: SshManagerDeps;
  /** The last fingerprint shown per host, so a trust writes exactly what the user saw. */
  #scans = new Map<string, CapturedHostKey>();

  constructor(deps: SshManagerDeps) {
    this.#deps = deps;
  }

  /** Every profile with its secrets, for Main. A renderer gets `publicHosts()`. */
  hosts(): SshHostSnapshot { return readSshHosts(this.#deps.paths.sshHostsFile, this.#deps.secrets); }
  publicHosts(): SshHostSnapshot { return redactSshHosts(this.hosts()); }
  saveHost(host: RemoteHostProfile): SshHostSnapshot {
    return redactSshHosts(saveSshHost(this.#deps.paths.sshHostsFile, host, this.#deps.secrets));
  }
  removeHost(id: string): SshHostSnapshot {
    this.#scans.delete(id);
    return redactSshHosts(removeSshHost(this.#deps.paths.sshHostsFile, id, this.#deps.secrets));
  }

  profile(id: string): RemoteHostProfile | undefined {
    const hosts = this.hosts();
    return [...hosts.saved, ...hosts.discovered].find((item) => item.id === id);
  }

  /**
   * Try to log in to one saved/discovered host, and report what happened.
   *
   * Shares the profile lookup with `connect` — a host id resolves the same way in both —
   * but stops there: no Agent deploy, no tunnel, no `remoteConnections` entry, so testing
   * a host cannot disturb a connection that is already up. The login runs the read-only
   * status half of the connect preflight, so the answer also says what of FastVibe is
   * on the host.
   */
  async test(id: string): Promise<RemoteHostTestResult> {
    const profile = this.profile(id);
    if (!profile) throw new Error("SSH 主机不存在");
    const { output, ...result } = await probeSshHost({
      host: profile,
      ...(profile.authMethod === "password" && profile.password ? { password: profile.password } : {}),
      command: agentPreflightCommand(this.#deps.agentRuntime),
    });
    if (!result.ok || output === undefined) return result;
    const status = parsePreflight(output);
    return {
      ...result,
      agent: {
        ...(status.installed ? { installed: status.installed } : {}),
        ...(status.running ? { running: status.running } : {}),
      },
    };
  }

  /** Record the key the host presents, for the user to compare before trusting it. */
  async scanHostKey(id: string): Promise<SshHostKeyScan> {
    const profile = this.profile(id);
    if (!profile) throw new Error("SSH 主机不存在");
    const scan = { ...(await captureHostKey(profile)), hostId: id };
    this.#scans.set(id, scan);
    const { lines: _lines, ...visible } = scan;
    return visible;
  }

  /**
   * Add the scanned key to known_hosts, only if it is the one the user confirmed.
   *
   * The renderer names the fingerprints it showed; a scan that has since been replaced
   * (another click, another answer from the network) no longer matches and is refused.
   */
  trustHostKey(id: string, fingerprints: string[]): void {
    const scan = this.#scans.get(id);
    if (!scan) throw new Error("请先读取主机指纹");
    const shown = [...fingerprints].sort().join(",");
    const scanned = scan.keys.map((key) => key.fingerprint).sort().join(",");
    if (!shown || shown !== scanned) throw new Error("主机指纹已变化，请重新确认");
    writeTrustedHostKey(scan);
    this.#scans.delete(id);
    this.#deps.log.info(`[ssh:${id}] trusted host key ${scanned} in ${scan.knownHostsFile}`);
  }

  /** Stop the resident Agent on a host. The caller disconnects first. */
  async stopAgent(id: string): Promise<string> {
    const profile = this.profile(id);
    if (!profile) throw new Error("SSH 主机不存在");
    if (profile.authMethod === "password" && !profile.password) throw new Error("请填写 SSH 密码");
    const output = await runSshCommand({
      host: profile,
      ...(profile.authMethod === "password" && profile.password ? { password: profile.password } : {}),
      command: agentStopCommand(),
      timeoutMs: 20_000,
    });
    return output.split(/\r?\n/).map((line) => line.trim()).filter(Boolean).at(-1) ?? "";
  }
}

const CANCELLED = "远程连接已取消";

/**
 * Open only the SSH transport for the App Server gateway.
 *
 * The gateway needs many independent forwards and hands the resulting port to
 * RemoteConnectionManager, which owns protocol identity, calls and events. No
 * application request crosses this function.
 */
export async function openSshAppTransport(options: {
  profile: RemoteHostProfile;
  agentRuntime: SshManagerDeps["agentRuntime"];
  log: { info(message: string): void; warn(message: string): void };
  onOutput?: (message: string) => void;
  /** The transfer in progress, or null once the connect has moved on to its next step. */
  onProgress?: (progress: RemoteTransferProgress | null) => void;
  /** The current coarse step, including non-transfer work that can take a while. */
  onActivity?: (activity: RemoteHostConnectionActivity) => void;
  signal?: AbortSignal;
}): Promise<{ port: number; close: () => Promise<void>; configSyncToken: string; home?: string }> {
  const { profile, agentRuntime, log, onOutput, onProgress, onActivity, signal } = options;
  throwIfAborted(signal);
  if (profile.authMethod === "password" && !profile.password) throw new Error("请填写 SSH 密码");
  if (profile.authMethod === "identity-file" && !profile.identityFile) throw new Error("请填写私钥路径");
  // A fixed port someone else already listens on would pass the tunnel's readiness probe
  // (it only checks that the port accepts), and the client would talk to that process.
  const localPort = profile.localPort ? await assertPortFree(profile.localPort) : await freePort();
  throwIfAborted(signal);
  const password = profile.authMethod === "password" ? profile.password : undefined;
  const progress = transferProgress(onProgress);
  const output = (text: string): void => {
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      progress.clear();
      log.info(`[ssh:${profile.id}] ${line}`);
      onOutput?.(line);
    }
  };
  /**
   * What a remote script prints, line by line: progress lines feed the bar, the sync token
   * never reaches the log, and everything else is shown. Lines are reassembled first — a
   * chunk from ssh can end mid-line, and half a progress line would be logged as text.
   */
  const remote = (onLine?: (line: string) => void): ((text: string) => void) => {
    let pending = "";
    return (text) => {
      pending += text;
      const lines = pending.split(/\r?\n/);
      pending = lines.pop() ?? "";
      for (const raw of lines) {
        const line = raw.trim();
        if (!line) continue;
        const match = /^FASTVIBE_PROGRESS (\S+) (\d+) ?(\d*)$/.exec(line);
        if (match) {
          if (isTransferPhase(match[1])) progress.report(match[1], Number(match[2]), match[3] ? Number(match[3]) : undefined);
          continue;
        }
        if (/^FASTVIBE_AGENT_SYNC_TOKEN=[a-f0-9]{64}$/.test(line)) continue;
        onLine?.(line);
        output(line);
      }
    };
  };
  onActivity?.("connecting");
  output("正在连接 SSH…");
  let master: SshMaster | null = null;
  try {
    master = await startSshMaster({ host: profile, password, signal });
  } catch (error) {
    throwIfAborted(signal);
    // A refused credential or an untrusted host key fails every later connection the same
    // way — and a password retried once per step is how a host's fail2ban gets tripped.
    if (error instanceof SshError) throw error;
    output(`SSH 复用连接不可用，改为单独连接：${error instanceof Error ? error.message : String(error)}`);
  }
  const controlPath = master?.socket;
  // Built once the Agent's port is known: it is whatever the remote OS handed out, read
  // back from the Agent's state file by the preflight or the bootstrap.
  let tunnel: SshTunnel | null = null;
  const forward = async (remotePort: number): Promise<void> => {
    output(`正在建立 SSH 端口转发（远程端口 ${remotePort}）…`);
    tunnel = new SshTunnel({ host: profile, localPort, remotePort, password, controlPath, onOutput: output, signal });
    await tunnel.start();
  };
  const closeTransport = async () => {
    await tunnel?.stop().catch(() => undefined);
    await master?.close().catch(() => undefined);
  };
  try {
    throwIfAborted(signal);
    onActivity?.("checking");
    output("检查远程系统与常驻 Agent…");
    // One round trip answers everything the connect needs before deciding what to do:
    // the platform, the installed runtime release and hash, the home directory, and —
    // when this exact release is already running — its token, which skips deployment.
    const preflight = parsePreflight(await runSshCommand({
      host: profile,
      password,
      controlPath,
      command: agentPreflightCommand(agentRuntime),
      timeoutMs: 20_000,
      onOutput: remote(),
      signal,
    }));
    throwIfAborted(signal);
    const home = preflight.home;
    // A pinned `servicePort` the resident Agent is not on means a restart, not a reuse.
    const portMatches = !profile.servicePort || profile.servicePort === preflight.port;
    if (preflight.token && preflight.port && portMatches) {
      output("常驻 Agent 可直接使用，跳过部署");
      onActivity?.("forwarding");
      await forward(preflight.port);
      throwIfAborted(signal);
      let residentClosed = false;
      return {
        port: localPort,
        configSyncToken: preflight.token,
        ...(home ? { home } : {}),
        close: async () => {
          if (residentClosed) return;
          residentClosed = true;
          await closeTransport();
        },
      };
    }
    const target = agentRuntimeTarget(preflight.os, preflight.arch);
    output(`远程系统：${preflight.os} ${preflight.arch}，常驻 Agent 不在运行，开始初始化…`);
    const artifact = agentRuntime.targets[target];
    if (!artifact) throw new Error(`当前构建不包含 ${target} 的 Agent runtime（${agentRuntime.release}）`);
    if (preflight.installed === agentRuntime.release && preflight.installedHash === artifact.runtimeHash) {
      output(`远程已有 ${agentRuntime.release} Agent，跳过上传`);
    } else {
      output(`准备 ${target} Agent…`);
      // The host fetches the release itself, and only falls back to a download here plus
      // an upload through SSH when it cannot. This desktop is often not the machine with
      // the good link — a laptop on a hotel network pushing a hundred megabytes to a
      // server in a data centre is the case that motivated it — and the archive is a
      // public release asset, so the host needs nothing from us to fetch it.
      //
      // Everything the remote path owns is inside one try: a host with no egress, no
      // curl/wget, or a proxy that cannot reach GitHub has to leave the connect
      // recoverable by the upload it was already doing.
      let deployed = false;
      let remoteFailure = "";
      try {
        onActivity?.("agent-download");
        await runSshCommand({
          host: profile,
          password,
          controlPath,
          command: agentRuntimeRemoteDownloadCommand(agentRuntime, target),
          timeoutMs: 900_000,
          // OpenSSH reports every failure as `exit 255`, so the wrapper's exit code says
          // nothing and the sentence worth showing is the one the host's own shell
          // printed. Keep the tail here rather than making the caller dig through
          // `output` for it.
          onOutput: remote((line) => { remoteFailure = line; }),
          signal,
        });
        deployed = true;
        output("远程主机已就绪（直接下载，无需上传）");
      } catch (error) {
        throwIfAborted(signal);
        // Only a *remote* failure is a reason to upload; a cancel has to keep winning.
        const reason = remoteFailure || (error instanceof Error ? error.message : String(error));
        output(`远程主机直接下载失败，改为本机下载后上传：${reason}`);
      }
      if (!deployed) {
        onActivity?.("agent-fetch");
        const runtime = await loadAgentRuntime(agentRuntime, target, output, (done, total) => progress.report("agent-fetch", done, total));
        throwIfAborted(signal);
        onActivity?.("agent-upload");
        output(`正在上传并部署 Agent（${formatBytes(runtime.archive.length)}）…`);
        await runSshCommand({
          host: profile,
          password,
          controlPath,
          command: agentRuntimeUploadCommand(agentRuntime, target, createHash("sha256").update(runtime.archive).digest("hex")),
          input: runtime.archive,
          onInputProgress: (sent, total) => progress.report("agent-upload", sent, total),
          timeoutMs: 300_000,
          onOutput: remote(),
          signal,
        });
      }
    }
    throwIfAborted(signal);
    onActivity?.("starting-agent");
    output("正在启动远程 Agent…");
    const bootstrap = await runSshCommand({
      host: profile,
      password,
      controlPath,
      command: buildAgentBootstrapCommand(profile.servicePort, agentRuntime, target, randomBytes(32).toString("hex")),
      // Long enough for a first deploy that also has to download Node.js from a mirror.
      timeoutMs: 900_000,
      onOutput: remote(),
      signal,
    });
    const configSyncToken = extractSyncToken(bootstrap);
    if (!configSyncToken) throw new Error("远程 Agent 未返回配置同步凭据");
    const remotePort = parsePreflight(bootstrap).port;
    if (!remotePort) throw new Error("远程 Agent 未返回监听端口");
    throwIfAborted(signal);
    onActivity?.("forwarding");
    await forward(remotePort);
    throwIfAborted(signal);
    let closed = false;
    return {
      port: localPort,
      configSyncToken,
      ...(home ? { home } : {}),
      close: async () => {
        if (closed) return;
        closed = true;
        await closeTransport();
      },
    };
  } catch (error) {
    await closeTransport();
    throw error;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new Error(CANCELLED);
}

/**
 * One round trip that tells the connect what it is dealing with.
 *
 * Prints `FASTVIBE_OS/ARCH/HOME/INSTALLED/RUNNING/PORT` unconditionally, and the sync
 * token only when this exact runtime release and hash are installed, running, answering
 * on the port its state file names, and holding a token. Anything less prints no token,
 * and the caller deploys. Nothing here installs, downloads or stops anything.
 */
export function agentPreflightCommand(source: AgentRuntimeSource): string {
  const safeRelease = source.release.replace(/[^0-9A-Za-z._-]/g, "_");
  const x64 = source.targets["linux-x64"]?.runtimeHash ?? "";
  const arm64 = source.targets["linux-arm64"]?.runtimeHash ?? "";
  if (!x64 || !arm64) throw new Error(`当前构建缺少 Agent runtime 元数据（${source.release}）`);
  const script = [
    `VERSION='${safeRelease}'`,
    `EXPECTED_X64='${x64}'`,
    `EXPECTED_ARM64='${arm64}'`,
    ...agentStatusLines(),
    'expected_hash() { case "$1" in x86_64|amd64) printf "%s" "$EXPECTED_X64" ;; aarch64|arm64) printf "%s" "$EXPECTED_ARM64" ;; esac; }',
    'resident() {',
    '  [ -f "$ROOT/releases/$VERSION/out/main/agent.js" ] || return 0',
    '  EXPECTED=$(expected_hash "$ARCH")',
    '  [ -n "$EXPECTED" ] || return 0',
    '  [ "$INSTALLED" = "$VERSION" ] || return 0',
    '  [ "$INSTALLED_HASH" = "$EXPECTED" ] || return 0',
    '  [ "$RUNNING" = "$VERSION" ] || return 0',
    '  TOKEN=$(agent_token "$pid")',
    '  [ -n "$TOKEN" ] || return 0',
    '  printf "FASTVIBE_AGENT_SYNC_TOKEN=%s\\n" "$TOKEN"',
    '  echo "常驻 Agent 正在运行"',
    '}',
    'resident',
  ].join("\n");
  return remoteShellCommand(script);
}

/**
 * Report what of FastVibe is on the host, without changing any of it.
 *
 * Shared by the connect preflight and the settings pane's 测试, so both read the same
 * facts the same way. Leaves `$pid`/`$PORT` set to the running Agent, if one answers.
 */
function agentStatusLines(): string[] {
  return [
    ...agentPaths(),
    'printf "FASTVIBE_OS=%s\\n" "$(uname -s)"',
    'printf "FASTVIBE_ARCH=%s\\n" "$(uname -m)"',
    'printf "FASTVIBE_HOME=%s\\n" "$HOME"',
    'INSTALLED=""',
    'INSTALLED_HASH=""',
    'if [ -f "$ROOT/current/manifest.json" ] && [ -f "$ROOT/current/out/main/agent.js" ]; then CURRENT=$(readlink -f "$ROOT/current" 2>/dev/null || printf "%s" "$ROOT/current"); INSTALLED=${CURRENT##*/}; INSTALLED_HASH=$(awk -F\'"\' \'/"runtimeHash"/ { print $4; exit }\' "$ROOT/current/manifest.json" 2>/dev/null); if [ -z "$INSTALLED_HASH" ]; then INSTALLED_HASH=$(awk -F\'"\' \'/"version"/ { print $4; exit }\' "$ROOT/current/manifest.json" 2>/dev/null); fi; fi',
    'printf "FASTVIBE_INSTALLED=%s\\n" "$INSTALLED"',
    'printf "FASTVIBE_INSTALLED_HASH=%s\\n" "$INSTALLED_HASH"',
    ...agentProcessHelpers(),
    'RUNNING=""',
    'find_agent',
    'if [ -n "$pid" ] && agent_ready "$pid"; then RUNNING=$(tr \'\\000\' "\\n" < "/proc/$pid/cmdline" 2>/dev/null | sed -n \'s|.*/\\.fastvibe-agent/releases/\\([^/]*\\)/.*|\\1|p\' | head -n 1); else pid=""; PORT=""; fi',
    'printf "FASTVIBE_RUNNING=%s\\n" "$RUNNING"',
    'printf "FASTVIBE_PORT=%s\\n" "$PORT"',
  ];
}

/** `stop_pid PID`: TERM, wait up to five seconds, then KILL. Never part of the preflight. */
function stopPidHelper(): string[] {
  return [
    'stop_pid() { kill "$1" 2>/dev/null || true; n=0; while [ $n -lt 50 ] && [ -d "/proc/$1" ]; do n=$((n+1)); sleep 0.1; done; if [ -d "/proc/$1" ]; then kill -9 "$1" 2>/dev/null || true; fi; }',
  ];
}

/** Where the Agent lives on the host: its releases, and the state file it writes. */
function agentPaths(): string[] {
  return [
    'ROOT="$HOME/.fastvibe-agent"',
    // Written by the Agent itself once listening (`src/agent/main.ts`): pid, port, version.
    'STATE="$HOME/.fastvibe/agent.json"',
  ];
}

/** What the connect, and the settings pane, read out of `agentPreflightCommand`. */
export function parsePreflight(output: string): { os: string; arch: string; home?: string; installed?: string; installedHash?: string; running?: string; port?: number; token?: string } {
  const field = (name: string): string => new RegExp(`^FASTVIBE_${name}=(.*)$`, "m").exec(output)?.[1]?.trim() ?? "";
  const home = field("HOME");
  const installed = field("INSTALLED");
  const installedHash = field("INSTALLED_HASH");
  const running = field("RUNNING");
  const port = Number(field("PORT"));
  const token = extractSyncToken(output);
  return {
    os: field("OS"),
    arch: field("ARCH"),
    ...(home.startsWith("/") ? { home } : {}),
    ...(installed ? { installed } : {}),
    ...(installedHash ? { installedHash } : {}),
    ...(running ? { running } : {}),
    ...(Number.isInteger(port) && port >= 1 && port <= 65_535 ? { port } : {}),
    ...(token ? { token } : {}),
  };
}

/**
 * Stop the Agent this app started, and nothing else.
 *
 * The pid comes from the Agent's own state file and must still be a `~/.fastvibe-agent`
 * process; a recycled pid belonging to anything else is left alone. The release stays
 * installed, so the next connect only has to start it again.
 */
export function agentStopCommand(): string {
  const script = [
    ...agentPaths(),
    ...agentProcessHelpers(),
    ...stopPidHelper(),
    'find_agent',
    'if [ -z "$pid" ]; then echo "远程 Agent 未在运行"; rm -f "$STATE"; exit 0; fi',
    'stop_pid "$pid"',
    'rm -f "$STATE"',
    'echo "远程 Agent 已停止"',
  ].join("\n");
  return remoteShellCommand(script);
}

/**
 * Find the Agent we started, and read the token from that process.
 *
 * The Agent records its pid and port in `$STATE` once it listens; that file is the only
 * way to find it, since the port is whatever the OS handed out. A stale file (the host
 * rebooted, the pid was recycled) is caught by requiring the pid to still be a process
 * running from `~/.fastvibe-agent`. The token is read by the process's own Node, because
 * a shell variable cannot hold the NUL bytes in environ.
 */
function agentProcessHelpers(): string[] {
  return [
    'state_field() { sed -n "s/^ *\\"$1\\": *\\([0-9][0-9]*\\).*/\\1/p" "$STATE" 2>/dev/null | head -n 1; }',
    'is_agent() { [ -n "$1" ] && [ -r "/proc/$1/cmdline" ] && tr "\\000" " " < "/proc/$1/cmdline" 2>/dev/null | grep -qF "/.fastvibe-agent/"; }',
    // Sets globals rather than printing, so the caller gets both values without a subshell.
    'find_agent() { pid=""; PORT=""; p=$(state_field pid); q=$(state_field port); if is_agent "$p" && [ -n "$q" ]; then pid=$p; PORT=$q; fi; }',
    'agent_token() {',
    '  exe=$(readlink "/proc/$1/exe" 2>/dev/null || true)',
    '  [ -n "$exe" ] || return 0',
    `  "$exe" -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);const k="FASTVIBE_AGENT_SYNC_TOKEN=";const i=b.indexOf(k);if(i<0)process.exit(0);const s=b.slice(i+k.length);const z=s.indexOf(0);process.stdout.write(z<0?s:s.slice(0,z))' "/proc/$1/environ" 2>/dev/null || true`,
    '}',
    'agent_ready() {',
    '  exe=$(readlink "/proc/$1/exe" 2>/dev/null || true)',
    '  [ -n "$exe" ] && [ -n "$PORT" ] || return 1',
    `  "$exe" -e 'const net=require("node:net");const s=net.connect({host:"127.0.0.1",port:Number(process.argv[1])});const done=c=>{s.destroy();process.exit(c)};s.once("connect",()=>done(0));s.once("error",()=>done(1));s.setTimeout(300,()=>done(1))' "$PORT" >/dev/null 2>&1`,
    '}',
  ];
}

/**
 * Start the independently versioned Agent on the remote machine.
 *
 * One resident Agent per remote user. It listens on `--port=0` — whatever free port the
 * OS hands out, so no fixed port can collide with another user or program — unless the
 * profile pins `servicePort`. Either way the Agent writes the port to its state file,
 * and this prints it back as `FASTVIBE_PORT=`. A running Agent of this runtime release
 * with the right token is reused; any other FastVibe Agent is stopped first.
 */
export function buildAgentBootstrapCommand(port: number | undefined, source: AgentRuntimeSource, target: AgentRuntimeTarget = "linux-x64", syncToken = ""): string {
  const requested = port && Number.isInteger(port) && port >= 1 && port <= 65_535 ? port : 0;
  const safeVersion = source.release.replace(/[^0-9A-Za-z._-]/g, "_");
  const safeTarget = target === "linux-arm64" ? "linux-arm64" : "linux-x64";
  const artifact = source.targets[target];
  if (!artifact) throw new Error(`当前构建不包含 ${target} 的 Agent runtime（${source.release}）`);
  const safeRuntimeHash = artifact.runtimeHash;
  const safeSyncToken = /^[a-f0-9]{64}$/.test(syncToken) ? syncToken : "";
  const script = [
    `REQUESTED_PORT=${requested}`,
    `VERSION='${safeVersion}'`,
    `TARGET='${safeTarget}'`,
    `EXPECTED_RUNTIME_HASH='${safeRuntimeHash}'`,
    ...agentPaths(),
    'MAIN="$ROOT/releases/$VERSION/out/main/agent.js"',
    // Not /tmp: that is shared, and a file another user left there (umask 077 on theirs)
    // makes the redirect below fail before Node ever starts.
    'LOG="$ROOT/agent.log"',
    `SYNC_TOKEN_INPUT='${safeSyncToken}'`,
    'SYNC_TOKEN_FILE="$ROOT/releases/$VERSION/.config-sync-token"',
    'SYNC_TOKEN=""',
    'TOKEN_CREATED=0',
    'umask 077',
    'if [ -s "$SYNC_TOKEN_FILE" ]; then SYNC_TOKEN=$(cat "$SYNC_TOKEN_FILE"); elif [ -n "$SYNC_TOKEN_INPUT" ]; then printf "%s\\n" "$SYNC_TOKEN_INPUT" > "$SYNC_TOKEN_FILE"; SYNC_TOKEN="$SYNC_TOKEN_INPUT"; TOKEN_CREATED=1; fi',
    'if [ ! -f "$MAIN" ]; then echo "FastVibe Agent runtime upload is incomplete" >&2; exit 127; fi',
    'INSTALLED_RUNTIME_HASH=$(awk -F\'"\' \'/"runtimeHash"/ { print $4; exit }\' "$ROOT/releases/$VERSION/manifest.json" 2>/dev/null)',
    'if [ -z "$INSTALLED_RUNTIME_HASH" ]; then INSTALLED_RUNTIME_HASH=$(awk -F\'"\' \'/"version"/ { print $4; exit }\' "$ROOT/releases/$VERSION/manifest.json" 2>/dev/null); fi',
    '[ "$INSTALLED_RUNTIME_HASH" = "$EXPECTED_RUNTIME_HASH" ] || { echo "FastVibe Agent runtime hash mismatch" >&2; exit 127; }',
    ...sha256Helper(),
    ...downloadHelpers(),
    "node_version() { awk -F'\"' '/\"node\"/ { print $4; exit }' \"$ROOT/releases/$VERSION/manifest.json\"; }",
    "usable_node() { candidate=\"$1\"; [ -n \"$candidate\" ] && [ -x \"$candidate\" ] || return 1; \"$candidate\" -e \"const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1); require('node:sqlite')\" >/dev/null 2>&1; }",
    // Node managers and proxy settings usually live in .bashrc/.zshrc, which `ssh host cmd`
    // never reads. Load that environment before looking for Node or downloading it; the
    // Agent started below inherits it, so its own tools get the same proxy and PATH.
    ...loginEnvironment(),
    'load_login_env',
    'NODE=""',
    'SYSTEM_NODE=$(command -v node 2>/dev/null || command -v nodejs 2>/dev/null || true)',
    'if usable_node "$SYSTEM_NODE"; then NODE="$SYSTEM_NODE"; echo "Using system Node.js: $NODE"; fi',
    // A shell probe can still come back empty — no `$SHELL`, or a startup file that never
    // touches PATH — and a download the host did not need is the expensive mistake this whole
    // block exists to avoid. These are the roots the managers actually install into; the nvm
    // glob is a guess among several usable versions, which is why it comes last.
    'if [ -z "$NODE" ]; then',
    '  for candidate in "$HOME"/.volta/bin/node "$HOME"/.asdf/shims/node "$HOME"/.local/share/mise/shims/node "$HOME"/.local/share/fnm/aliases/default/bin/node "$HOME"/.nvm/versions/node/*/bin/node "$HOME"/.local/bin/node /usr/local/bin/node /snap/bin/node; do',
    '    if usable_node "$candidate"; then NODE="$candidate"; echo "Using system Node.js: $NODE"; break; fi',
    '  done',
    'fi',
    'if [ -z "$NODE" ]; then',
    '  NODE_VERSION=$(node_version)',
    '  case "$NODE_VERSION" in v[0-9]*.[0-9]*.[0-9]*) ;; *) echo "无法读取 Agent 所需的 Node.js 版本" >&2; exit 127 ;; esac',
    '  NODE_VERSION=${NODE_VERSION#v}',
    '  NODE_ROOT="$ROOT/node-v${NODE_VERSION}-${TARGET}"',
    '  NODE="$NODE_ROOT/bin/node"',
    '  if ! usable_node "$NODE"; then',
    '    echo "未找到兼容的系统 Node.js，正在通过 SSH 安装 Node.js v$NODE_VERSION"',
    '    TMP="$ROOT/.node-${NODE_VERSION}.$$"',
    '    rm -rf "$TMP" && mkdir -p "$TMP"',
    '    NODE_FILE="node-v${NODE_VERSION}-${TARGET}.tar.gz"',
    `    NODE_OFFICIAL="https://nodejs.org/dist/v\${NODE_VERSION}"`,
    `    NODE_MIRROR=${shellQuote(NODE_MIRROR)}"/v\${NODE_VERSION}"`,
    // nodejs.org first; npmmirror only when that fails or crawls (see `downloadHelpers`).
    '    fv_download node-download "$TMP/node.tar.gz" "$NODE_OFFICIAL/$NODE_FILE" "$NODE_MIRROR/$NODE_FILE" || { echo "Node.js 下载失败" >&2; rm -rf "$TMP"; exit 127; }',
    // Checked against SHASUMS256.txt before anything is unpacked, so a truncated download
    // or a proxy's error page cannot become the Agent's runtime. The sums come from the
    // source that served the archive, falling back to the other one.
    '    NODE_USED="${FV_SOURCE%/*}"',
    '    if [ "$NODE_USED" = "$NODE_OFFICIAL" ]; then NODE_OTHER="$NODE_MIRROR"; else NODE_OTHER="$NODE_OFFICIAL"; fi',
    '    fv_download node-sums "$TMP/SHASUMS256.txt" "$NODE_USED/SHASUMS256.txt" "$NODE_OTHER/SHASUMS256.txt" >/dev/null || { echo "Node.js 校验和下载失败" >&2; rm -rf "$TMP"; exit 127; }',
    '    SUMS=$(cat "$TMP/SHASUMS256.txt")',
    '    WANT=$(printf "%s\\n" "$SUMS" | awk -v f="node-v${NODE_VERSION}-${TARGET}.tar.gz" \'$2 == f { print $1; exit }\')',
    '    GOT=$(sha256_of "$TMP/node.tar.gz")',
    '    if [ -z "$WANT" ]; then echo "Node.js 校验和缺失" >&2; rm -rf "$TMP"; exit 127; fi',
    '    if [ -z "$GOT" ]; then echo "远程主机缺少 sha256sum/shasum，跳过 Node.js 校验"; elif [ "$GOT" != "$WANT" ]; then echo "Node.js 下载内容校验失败" >&2; rm -rf "$TMP"; exit 127; fi',
    '    rm -rf "$NODE_ROOT" && tar -xzf "$TMP/node.tar.gz" -C "$ROOT" && rm -rf "$TMP" || { echo "Node.js 解压失败" >&2; rm -rf "$TMP" "$NODE_ROOT"; exit 127; }',
    '    if ! usable_node "$NODE"; then echo "安装的 Node.js 无法运行" >&2; exit 127; fi',
    '    echo "Node.js 安装完成"',
    '  fi',
    'fi',
    'paths_for() { if [ ! -r "/proc/$1/cmdline" ]; then return 1; fi; tr \'\\000\' " " < "/proc/$1/cmdline"; echo " "; readlink "/proc/$1/exe" 2>/dev/null || true; }',
    ...agentProcessHelpers(),
    ...stopPidHelper(),
    // Every deploy leaves a ~100 MB release behind. Once this runtime release is up,
    // anything no running process still executes from is only disk: another port's Agent
    // keeps its release, and the Node this runtime uses is never touched.
    'in_use() { for c in /proc/[0-9]*/cmdline; do if tr "\\000" " " < "$c" 2>/dev/null | grep -qF "$1/"; then return 0; fi; done; return 1; }',
    'prune() {',
    '  for dir in "$ROOT"/releases/*; do',
    '    [ -d "$dir" ] || continue',
    '    [ "${dir##*/}" = "$VERSION" ] && continue',
    '    in_use "$dir" && continue',
    '    rm -rf "$dir" && echo "已清理旧版本 Agent：${dir##*/}"',
    '  done',
    '  for dir in "$ROOT"/node-v*; do',
    '    [ -d "$dir" ] || continue',
    '    case "$NODE" in "$dir"/*) continue ;; esac',
    '    in_use "$dir" && continue',
    '    rm -rf "$dir" && echo "已清理未使用的 Node.js：${dir##*/}"',
    '  done',
    '  find "$ROOT" -maxdepth 1 \\( -name ".download-*" -o -name ".node-*" \\) -mmin +60 -exec rm -rf {} + 2>/dev/null || true',
    '}',
    'port_busy() { command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk -v p=":$1" \'index($4, p) && $4 ~ p"$" { found=1 } END { exit !found }\'; }',
    // Ready means: the state file names the process we started, and its port accepts.
    'wait_for_agent() { n=0; while [ $n -lt 300 ]; do if [ "$(state_field pid)" = "$1" ]; then PORT=$(state_field port); if agent_ready "$1"; then return 0; fi; fi; kill -0 "$1" 2>/dev/null || return 1; n=$((n+1)); sleep 0.2; done; return 1; }',
    // Agents from before the state file sat on a fixed port with a per-port pidfile. They
    // would otherwise stay resident forever beside the new one.
    'for f in "$ROOT"/agent-*.pid; do [ -f "$f" ] || continue; p=$(cat "$f" 2>/dev/null); if is_agent "$p"; then echo "停止旧版固定端口 Agent（pid $p）"; stop_pid "$p"; fi; rm -f "$f"; done',
    'find_agent',
    'if [ -n "$pid" ]; then',
    '  case "$(paths_for "$pid" || true)" in',
    '    *"/.fastvibe-agent/releases/$VERSION/"*)',
    '      RUNNING_TOKEN=$(agent_token "$pid")',
    '      if [ "$TOKEN_CREATED" = "0" ] && [ -n "$SYNC_TOKEN" ] && [ "$RUNNING_TOKEN" = "$SYNC_TOKEN" ] && { [ "$REQUESTED_PORT" = 0 ] || [ "$REQUESTED_PORT" = "$PORT" ]; } && wait_for_agent "$pid"; then',
    '        echo "FastVibe Agent $VERSION is already running"',
    '        printf "FASTVIBE_PORT=%s\\n" "$PORT"',
    '        printf "FASTVIBE_AGENT_SYNC_TOKEN=%s\\n" "$SYNC_TOKEN"',
    '        prune',
    '        exit 0',
    '      fi',
    '      echo "Restarting FastVibe Agent to refresh config sync (pid $pid)" ;;',
    '    *) echo "Restarting FastVibe Agent (pid $pid)" ;;',
    '  esac',
    '  stop_pid "$pid"',
    'fi',
    'if [ "$REQUESTED_PORT" != 0 ] && port_busy "$REQUESTED_PORT"; then echo "Port $REQUESTED_PORT is already in use" >&2; exit 1; fi',
    'rm -f "$STATE"',
    'FASTVIBE_VERSION="$VERSION" FASTVIBE_AGENT_SYNC_TOKEN="$SYNC_TOKEN" nohup "$NODE" "$MAIN" --headless --port=$REQUESTED_PORT --state-file="$STATE" >"$LOG" 2>&1 </dev/null &',
    'AGENT_PID=$!',
    'echo "FastVibe Agent started in the background"',
    'echo "正在等待远程 Agent 就绪…"',
    'if ! wait_for_agent "$AGENT_PID"; then echo "远程 Agent 启动失败" >&2; tail -n 20 "$LOG" >&2 || true; exit 1; fi',
    'echo "远程 Agent 已就绪（端口 $PORT）"',
    'printf "FASTVIBE_PORT=%s\\n" "$PORT"',
    'prune',
    'if [ -n "$SYNC_TOKEN" ]; then printf "FASTVIBE_AGENT_SYNC_TOKEN=%s\\n" "$SYNC_TOKEN"; fi',
  ].join("\n");
  return remoteShellCommand(script);
}

const TRANSFER_PHASES = new Set<RemoteTransferProgress["phase"]>(["agent-download", "node-download", "agent-fetch", "agent-upload"]);

function isTransferPhase(value: string): value is RemoteTransferProgress["phase"] {
  return TRANSFER_PHASES.has(value as RemoteTransferProgress["phase"]);
}

/**
 * Turn byte counts into progress events: a speed over the last second or so, and at most
 * four events a second — an upload reports every 256 KiB chunk, which is far more often
 * than a progress bar can use or a broadcast should carry.
 */
export function transferProgress(emit: ((progress: RemoteTransferProgress | null) => void) | undefined, now: () => number = Date.now) {
  let current: RemoteTransferProgress | null = null;
  let sample = { at: 0, done: 0 };
  let emittedAt = Number.NEGATIVE_INFINITY;
  return {
    report(phase: RemoteTransferProgress["phase"], done: number, total?: number): void {
      const at = now();
      if (!current || current.phase !== phase || done < current.done) sample = { at, done: 0 };
      let rate = current?.phase === phase ? current.rate : undefined;
      if (at - sample.at >= 1_000) {
        rate = Math.max(0, Math.round((done - sample.done) / ((at - sample.at) / 1_000)));
        sample = { at, done };
      }
      current = { phase, done, ...(total ? { total } : {}), ...(rate !== undefined ? { rate } : {}) };
      const finished = total !== undefined && done >= total;
      if (finished || at - emittedAt >= 250) {
        emittedAt = at;
        emit?.(current);
      }
    },
    clear(): void {
      if (!current) return;
      current = null;
      emit?.(null);
    },
  };
}

function extractSyncToken(output: string): string | undefined {
  return /^FASTVIBE_AGENT_SYNC_TOKEN=([a-f0-9]{64})$/m.exec(output)?.[1];
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

async function assertPortFree(port: number): Promise<number> {
  try {
    return await listenOnce(port);
  } catch {
    throw new Error(`本地端口 ${port} 已被占用，无法建立 SSH 转发`);
  }
}

function freePort(): Promise<number> {
  return listenOnce(0);
}

async function listenOnce(requested: number): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(requested, "127.0.0.1", () => resolve()); });
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (!port) throw new Error("无法分配本地 SSH 转发端口");
  return port;
}
