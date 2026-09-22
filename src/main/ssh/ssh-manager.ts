import { randomBytes } from "node:crypto";
import { createServer } from "node:net";
import type { FastVibePaths } from "../engine/paths.ts";
import type { RemoteHostConnectionState, RemoteHostProfile } from "../../shared/remote-host.ts";
import { readSshHosts, removeSshHost, saveSshHost } from "./ssh-hosts.ts";
import { loadAgentRuntime, agentRuntimeTarget } from "./agent-runtime.ts";
import { runSshCommand, SshTunnel, startSshMaster, type SshMaster } from "./ssh-tunnel.ts";

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

/**
 * SSH host profiles on disk.
 *
 * Connection lifecycle (tunnel, protocol client, one-host proxy) lives on
 * `RemoteConnectionManager`. This class keeps the constructor shape index still
 * constructs, and the hosts/saveHost/removeHost surface it still calls.
 */
export class SshManager {
  #deps: SshManagerDeps;

  constructor(deps: SshManagerDeps) {
    this.#deps = deps;
  }

  hosts() { return readSshHosts(this.#deps.paths.sshHostsFile); }
  saveHost(host: RemoteHostProfile) { return saveSshHost(this.#deps.paths.sshHostsFile, host); }
  removeHost(id: string) { return removeSshHost(this.#deps.paths.sshHostsFile, id); }
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
  signal?: AbortSignal;
}): Promise<{ port: number; close: () => Promise<void>; configSyncToken: string }> {
  const { profile, agentRuntime, log, onOutput, signal } = options;
  throwIfAborted(signal);
  if (profile.authMethod === "password" && !profile.password) throw new Error("请填写 SSH 密码");
  if (profile.authMethod === "identity-file" && !profile.identityFile) throw new Error("请填写私钥路径");
  const localPort = profile.localPort ?? await freePort();
  throwIfAborted(signal);
  const remotePort = profile.servicePort ?? 7777;
  const password = profile.authMethod === "password" ? profile.password : undefined;
  const output = (text: string): void => {
    for (const line of text.split(/\r?\n/).map((item) => item.trim()).filter(Boolean)) {
      log.info(`[ssh:${profile.id}] ${line}`);
      onOutput?.(line);
    }
  };
  output("正在连接 SSH…");
  let master: SshMaster | null = null;
  try {
    master = await startSshMaster({ host: profile, password, signal });
  } catch (error) {
    throwIfAborted(signal);
    output(`SSH 复用连接不可用，改为单独连接：${error instanceof Error ? error.message : String(error)}`);
  }
  const controlPath = master?.socket;
  const tunnel = new SshTunnel({
    host: profile,
    localPort,
    remotePort,
    password,
    controlPath,
    onOutput: output,
    signal,
  });
  const closeTransport = async () => {
    await tunnel.stop().catch(() => undefined);
    await master?.close().catch(() => undefined);
  };
  try {
    throwIfAborted(signal);
    output("检查常驻 Agent…");
    const resident = await runSshCommand({
      host: profile,
      password,
      controlPath,
      command: residentAgentProbeCommand(remotePort, agentRuntime.version),
      timeoutMs: 20_000,
      onOutput: (text) => outputWithoutSyncToken(text, output),
      signal,
    }).catch(() => "");
    throwIfAborted(signal);
    const residentToken = extractSyncToken(resident);
    if (residentToken) {
      output("常驻 Agent 可直接使用，跳过部署");
      output("正在建立 SSH 端口转发…");
      await tunnel.start();
      throwIfAborted(signal);
      let residentClosed = false;
      return {
        port: localPort,
        configSyncToken: residentToken,
        close: async () => {
          if (residentClosed) return;
          residentClosed = true;
          await closeTransport();
        },
      };
    }
    output("常驻 Agent 不在运行，开始初始化…");
    output("正在检测远程系统…");
    const probe = await runSshCommand({
      host: profile,
      password,
      controlPath,
      command: "uname -s; uname -m",
      timeoutMs: 20_000,
      onOutput: output,
      signal,
    });
    throwIfAborted(signal);
    const [uname, machine] = probe.trim().split(/\s+/);
    const target = agentRuntimeTarget(uname ?? "", machine ?? "");
    output(`远程系统：${uname} ${machine}，检查已部署的 Agent…`);
    const installed = await runSshCommand({
      host: profile,
      password,
      controlPath,
      command: installedVersionCommand(),
      timeoutMs: 20_000,
      onOutput: output,
      signal,
    });
    throwIfAborted(signal);
    if (installed.trim() === agentRuntime.version) {
      output(`远程已有 ${agentRuntime.version} Agent，跳过上传`);
    } else {
      output(`准备 ${target} Agent…`);
      const runtime = await loadAgentRuntime(agentRuntime, target, output);
      throwIfAborted(signal);
      output(`正在上传并部署 Agent（${formatBytes(runtime.archive.length)}）…`);
      await runSshCommand({
        host: profile,
        password,
        controlPath,
        command: deployCommand(agentRuntime.version),
        input: runtime.archive,
        timeoutMs: 300_000,
        onOutput: output,
        signal,
      });
    }
    throwIfAborted(signal);
    output("正在启动远程 Agent…");
    const bootstrap = await runSshCommand({
      host: profile,
      password,
      controlPath,
      command: buildAgentBootstrapCommand(remotePort, agentRuntime.version, target, randomBytes(32).toString("hex")),
      timeoutMs: 180_000,
      onOutput: (text) => outputWithoutSyncToken(text, output),
      signal,
    });
    const configSyncToken = extractSyncToken(bootstrap);
    if (!configSyncToken) throw new Error("远程 Agent 未返回配置同步凭据");
    throwIfAborted(signal);
    output("正在建立 SSH 端口转发…");
    await tunnel.start();
    throwIfAborted(signal);
    let closed = false;
    return {
      port: localPort,
      configSyncToken,
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

function deployCommand(version: string): string {
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
  const release = `~/.fastvibe-agent/releases/${safeVersion}`;
  return `mkdir -p ${release} && tar -xzf - -C ${release} && ln -sfn ${release} ~/.fastvibe-agent/current && echo '预编译 Agent 已部署'`;
}

/**
 * One round trip that decides whether the resident Agent can be reused.
 *
 * Prints the sync token only when this exact version is installed, a process of
 * that release is listening on the port, and that process holds the token. Anything
 * less prints nothing, and the caller falls back to the full deploy.
 */
export function residentAgentProbeCommand(port: number, version: string): string {
  const safePort = String(Math.trunc(port));
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
  const script = [
    `PORT=${safePort}`,
    `VERSION='${safeVersion}'`,
    'ROOT="$HOME/.fastvibe-agent"',
    'PIDFILE="$ROOT/agent-$PORT.pid"',
    'MAIN="$ROOT/releases/$VERSION/out/main/agent.js"',
    '[ -f "$MAIN" ] || exit 0',
    'INSTALLED=$(awk -F\'"\' \'/"version"/ { print $4; exit }\' "$ROOT/current/manifest.json" 2>/dev/null)' ,
    '[ "$INSTALLED" = "$VERSION" ] || exit 0',
    ...agentProcessHelpers(),
    'pid=$(agent_pid)',
    '[ -n "$pid" ] && [ -r "/proc/$pid/cmdline" ] || exit 0',
    'PATHS=$(tr \'\\000\' " " < "/proc/$pid/cmdline" 2>/dev/null)',
    'case "$PATHS" in *"/.fastvibe-agent/releases/$VERSION/"*) ;; *) exit 0 ;; esac',
    'TOKEN=$(agent_token "$pid")',
    '[ -n "$TOKEN" ] || exit 0',
    'printf "FASTVIBE_AGENT_SYNC_TOKEN=%s\\n" "$TOKEN"',
    'echo "常驻 Agent 正在运行"',
  ].join("\n");
  return `sh -lc ${shellQuote(script)}`;
}

/**
 * Find the Agent we started, and read the token from that process.
 *
 * `ss -ltnp` hides the pid unless the caller is privileged, so a reconnect that only
 * looked there concluded the Agent was gone and started another one. The pidfile is
 * written by the bootstrap and does not need that privilege. The token is read by the
 * process's own Node, because a shell variable cannot hold the NUL bytes in environ.
 */
function agentProcessHelpers(): string[] {
  return [
    'agent_pid() {',
    '  p=$(cat "$PIDFILE" 2>/dev/null || true)',
    '  if [ -n "$p" ] && [ -d "/proc/$p" ]; then printf "%s\\n" "$p"; return; fi',
    '  if command -v ss >/dev/null 2>&1; then p=$(ss -ltnp 2>/dev/null | awk -v p=":$PORT" \'index($4, p) && $4 ~ p"$" { if (match($0, /pid=[0-9]+/)) { print substr($0, RSTART+4, RLENGTH-4); exit } }\'); if [ -n "$p" ]; then printf "%s\\n" "$p"; return; fi; fi',
    '  if command -v fuser >/dev/null 2>&1; then fuser -n tcp "$PORT" 2>/dev/null | tr -cs "0-9" "\\n" | grep -E "^[0-9]+$" | head -n 1; fi',
    '}',
    'agent_token() {',
    '  exe=$(readlink "/proc/$1/exe" 2>/dev/null || true)',
    '  [ -n "$exe" ] || return 0',
    `  "$exe" -e 'const fs=require("fs");const b=fs.readFileSync(process.argv[1]);const k="FASTVIBE_AGENT_SYNC_TOKEN=";const i=b.indexOf(k);if(i<0)process.exit(0);const s=b.slice(i+k.length);const z=s.indexOf(0);process.stdout.write(z<0?s:s.slice(0,z))' "/proc/$1/environ" 2>/dev/null || true`,
    '}',
  ];
}

/** Read the version already unpacked on the host. Empty output means nothing is installed. */
function installedVersionCommand(): string {
  return `manifest="$HOME/.fastvibe-agent/current/manifest.json"; if [ -f "$manifest" ] && [ -f "$HOME/.fastvibe-agent/current/out/main/agent.js" ]; then awk -F'"' '/"version"/ { print $4; exit }' "$manifest"; fi`;
}

/**
 * Start the versioned Agent on the remote machine.
 *
 * `--port=` matches the headless parser (`option("--port")` looks for that prefix).
 * An already-running process is reused only when it is this version's binary; an older
 * FastVibe Agent on the same port is restarted. Anything else listening is left alone.
 */
export function buildAgentBootstrapCommand(port: number, version: string, target: "linux-x64" | "linux-arm64" = "linux-x64", syncToken = ""): string {
  const safePort = String(Math.trunc(port));
  const safeVersion = version.replace(/[^0-9A-Za-z._-]/g, "_");
  const safeTarget = target === "linux-arm64" ? "linux-arm64" : "linux-x64";
  const safeSyncToken = /^[a-f0-9]{64}$/.test(syncToken) ? syncToken : "";
  const script = [
    `PORT=${safePort}`,
    `VERSION='${safeVersion}'`,
    `TARGET='${safeTarget}'`,
    'ROOT="$HOME/.fastvibe-agent"',
    'MAIN="$ROOT/releases/$VERSION/out/main/agent.js"',
    'PIDFILE="$ROOT/agent-$PORT.pid"',
    'LOG="/tmp/fastvibe-agent-$PORT.log"',
    `SYNC_TOKEN_INPUT='${safeSyncToken}'`,
    'SYNC_TOKEN_FILE="$ROOT/releases/$VERSION/.config-sync-token"',
    'SYNC_TOKEN=""',
    'TOKEN_CREATED=0',
    'umask 077',
    'if [ -s "$SYNC_TOKEN_FILE" ]; then SYNC_TOKEN=$(cat "$SYNC_TOKEN_FILE"); elif [ -n "$SYNC_TOKEN_INPUT" ]; then printf "%s\\n" "$SYNC_TOKEN_INPUT" > "$SYNC_TOKEN_FILE"; SYNC_TOKEN="$SYNC_TOKEN_INPUT"; TOKEN_CREATED=1; fi',
    'if [ ! -f "$MAIN" ]; then echo "FastVibe Agent runtime upload is incomplete" >&2; exit 127; fi',
    "node_version() { awk -F'\"' '/\"node\"/ { print $4; exit }' \"$ROOT/releases/$VERSION/manifest.json\"; }",
    "usable_node() { candidate=\"$1\"; [ -x \"$candidate\" ] || return 1; \"$candidate\" -e \"const [major, minor] = process.versions.node.split('.').map(Number); if (major < 22 || (major === 22 && minor < 5)) process.exit(1); require('node:sqlite')\" >/dev/null 2>&1; }",
    'NODE=""',
    'SYSTEM_NODE=$(command -v node || command -v nodejs || true)',
    'if usable_node "$SYSTEM_NODE"; then NODE="$SYSTEM_NODE"; echo "Using system Node.js: $NODE"; fi',
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
    '    URL="https://nodejs.org/dist/v${NODE_VERSION}/node-v${NODE_VERSION}-${TARGET}.tar.gz"',
    '    if command -v curl >/dev/null 2>&1; then curl -fsSL --retry 2 "$URL" -o "$TMP/node.tar.gz" || { echo "Node.js 下载失败" >&2; rm -rf "$TMP"; exit 127; }; elif command -v wget >/dev/null 2>&1; then wget -q --tries=2 "$URL" -O "$TMP/node.tar.gz" || { echo "Node.js 下载失败" >&2; rm -rf "$TMP"; exit 127; }; else echo "远程主机缺少 curl 或 wget，无法安装 Node.js" >&2; rm -rf "$TMP"; exit 127; fi',
    '    rm -rf "$NODE_ROOT" && tar -xzf "$TMP/node.tar.gz" -C "$ROOT" && rm -rf "$TMP" || { echo "Node.js 解压失败" >&2; rm -rf "$TMP" "$NODE_ROOT"; exit 127; }',
    '    if ! usable_node "$NODE"; then echo "安装的 Node.js 无法运行" >&2; exit 127; fi',
    '    echo "Node.js 安装完成"',
    '  fi',
    'fi',
    'paths_for() { if [ ! -r "/proc/$1/cmdline" ]; then return 1; fi; tr \'\\000\' " " < "/proc/$1/cmdline"; echo " "; readlink "/proc/$1/exe" 2>/dev/null || true; }',
    ...agentProcessHelpers(),
    'port_busy() { command -v ss >/dev/null 2>&1 && ss -ltn 2>/dev/null | awk -v p=":$PORT" \'index($4, p) && $4 ~ p"$" { found=1 } END { exit !found }\'; }',
    'LISTENER=$(agent_pid)',
    'if [ -n "$LISTENER" ]; then',
    '  PATHS=$(paths_for "$LISTENER" || true)',
    '  case "$PATHS" in',
    '    *"/.fastvibe-agent/releases/$VERSION/"*) RUNNING_TOKEN=$(agent_token "$LISTENER"); if [ "$TOKEN_CREATED" = "0" ] && [ -n "$SYNC_TOKEN" ] && [ "$RUNNING_TOKEN" = "$SYNC_TOKEN" ]; then echo "FastVibe Agent $VERSION is already running"; echo "$LISTENER" > "$PIDFILE"; printf "FASTVIBE_AGENT_SYNC_TOKEN=%s\\n" "$SYNC_TOKEN"; exit 0; fi; echo "Restarting FastVibe Agent to refresh config sync (pid $LISTENER)"; kill "$LISTENER" 2>/dev/null || true; n=0; while [ $n -lt 50 ] && [ -d "/proc/$LISTENER" ]; do n=$((n+1)); sleep 0.1; done; if [ -d "/proc/$LISTENER" ]; then kill -9 "$LISTENER" 2>/dev/null || true; fi ;;',
    '    *"/.fastvibe-agent/"*) echo "Restarting FastVibe Agent on port $PORT (pid $LISTENER)"; kill "$LISTENER" 2>/dev/null || true; n=0; while [ $n -lt 50 ] && [ -d "/proc/$LISTENER" ]; do n=$((n+1)); sleep 0.1; done; if [ -d "/proc/$LISTENER" ]; then kill -9 "$LISTENER" 2>/dev/null || true; fi ;;',
    '    *) echo "Port $PORT is already in use by another process (pid $LISTENER)" >&2; exit 1 ;;',
    '  esac',
    'elif port_busy; then',
    '  echo "Port $PORT is already in use" >&2; exit 1',
    'fi',
    'FASTVIBE_AGENT_SYNC_TOKEN="$SYNC_TOKEN" nohup "$NODE" "$MAIN" --headless --port=$PORT >"$LOG" 2>&1 </dev/null &',
    'echo $! > "$PIDFILE"',
    'echo "FastVibe Agent started in the background"',
    'if [ -n "$SYNC_TOKEN" ]; then printf "FASTVIBE_AGENT_SYNC_TOKEN=%s\\n" "$SYNC_TOKEN"; fi',
  ].join("\n");
  return `sh -lc ${shellQuote(script)}`;
}

function outputWithoutSyncToken(text: string, output: (message: string) => void): void {
  const visible = text
    .split(/\r?\n/)
    .filter((line) => !/^FASTVIBE_AGENT_SYNC_TOKEN=[a-f0-9]{64}$/.test(line.trim()))
    .join("\n");
  if (visible.trim()) output(visible);
}

function extractSyncToken(output: string): string | undefined {
  return /^FASTVIBE_AGENT_SYNC_TOKEN=([a-f0-9]{64})$/m.exec(output)?.[1];
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
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
