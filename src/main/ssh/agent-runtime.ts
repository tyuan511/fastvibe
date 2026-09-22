import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export type AgentRuntimeTarget = "linux-x64" | "linux-arm64";

export type AgentRuntimeSource = {
  version: string;
  /** Optional local directory containing fastvibe-agent-<target>.tar.gz. */
  artifactDirectory?: string;
  /** Cache downloaded archives so reconnecting does not hit GitHub again. */
  cacheDirectory?: string;
  releaseBaseUrl?: string;
};

export function agentRuntimeTarget(uname: string, machine: string): AgentRuntimeTarget {
  if (uname.trim().toLowerCase() !== "linux") throw new Error(`远程 Agent 仅支持 Linux（检测到 ${uname.trim() || "未知系统"}）`);
  const normalized = machine.trim().toLowerCase();
  if (normalized === "x86_64" || normalized === "amd64") return "linux-x64";
  if (normalized === "aarch64" || normalized === "arm64") return "linux-arm64";
  throw new Error(`暂不支持远程 Linux 架构：${machine.trim() || "未知架构"}`);
}

export function agentRuntimeFilename(target: AgentRuntimeTarget): string {
  return `fastvibe-agent-${target}.tar.gz`;
}

export function agentRuntimeUrl(source: AgentRuntimeSource, target: AgentRuntimeTarget): string {
  const base = (source.releaseBaseUrl || "https://github.com/tyuan511/fastvibe/releases/download").replace(/\/$/, "");
  return `${base}/v${encodeURIComponent(source.version)}/${agentRuntimeFilename(target)}`;
}

/**
 * Deploy the Agent by having the *remote host* fetch the release archive.
 *
 * The alternative — download here, then push the archive through SSH stdin — makes the
 * desktop's own network the only path that can work, and a host on a better link (or in
 * a data centre) has no reason to route a hundred megabytes through us. The URL is a
 * public release asset, so the host can fetch it directly; this is also why nothing here
 * needs any credential.
 *
 * The download is verified twice before it is trusted. `curl -f`/`wget` fail the shell
 * on a 404 (a tag without this target's archive) instead of writing the error page to
 * disk, and the unpacked `manifest.json` must name the expected version — a half-written
 * archive that happens to gunzip would otherwise be linked as `current` and reported as a
 * successful deploy.
 */
export function agentRuntimeRemoteDownloadCommand(source: AgentRuntimeSource, target: AgentRuntimeTarget): string {
  const script = [
    ...stagingPrelude(source),
    `URL=${shellQuote(agentRuntimeUrl(source, target))}`,
    'if command -v curl >/dev/null 2>&1; then FETCH=curl; elif command -v wget >/dev/null 2>&1; then FETCH=wget; else echo "远程主机缺少 curl 或 wget，无法直接下载 Agent 运行包" >&2; exit 127; fi',
    `echo "正在由远程主机直接下载 Agent 运行包：fastvibe-agent-${target}.tar.gz"`,
    // `-s`/`-q` keeps curl's progress meter and wget's dot bar out of the stream, which
    // reaches the GUI one push per chunk; `-S`/`-f` still print the real error on failure.
    'if [ "$FETCH" = curl ]; then curl -fsSL --connect-timeout 15 --retry 2 --retry-delay 1 --speed-limit 1024 --speed-time 30 -o "$TMP/agent.tar.gz" "$URL" || { echo "Agent 运行包下载失败" >&2; exit 127; }; else wget -q --timeout=30 --tries=2 -O "$TMP/agent.tar.gz" "$URL" || { echo "Agent 运行包下载失败" >&2; exit 127; }; fi',
    ...installStagedArchive("远程主机已直接下载并部署 Agent"),
  ].join("\n");
  return `sh -lc ${shellQuote(script)}`;
}

/**
 * Deploy an archive this desktop pushes through SSH stdin — the fallback when the host
 * cannot fetch the release itself.
 *
 * It lands in the same staging directory and passes the same checks as the remote
 * download, plus one only this path can make: the SHA-256 of the bytes the desktop sent.
 * A stream cut short by a dropped link is exactly the half-written archive that could
 * otherwise still gunzip far enough to be linked as `current`.
 */
export function agentRuntimeUploadCommand(source: AgentRuntimeSource, sha256: string): string {
  const safeSha = /^[a-f0-9]{64}$/.test(sha256) ? sha256 : "";
  const script = [
    ...stagingPrelude(source),
    'cat > "$TMP/agent.tar.gz" || { echo "Agent 运行包上传失败" >&2; exit 127; }',
    `EXPECTED_SHA='${safeSha}'`,
    ...sha256Helper(),
    'ACTUAL_SHA=$(sha256_of "$TMP/agent.tar.gz")',
    'if [ -z "$ACTUAL_SHA" ]; then echo "远程主机缺少 sha256sum/shasum，跳过校验和检查"; elif [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then echo "Agent 运行包上传不完整（校验和不匹配）" >&2; exit 127; fi',
    ...installStagedArchive("预编译 Agent 已部署"),
  ].join("\n");
  return `sh -lc ${shellQuote(script)}`;
}

/**
 * Variables and a private staging directory shared by both deploy paths.
 *
 * The release directory is the sanitized version; the manifest check compares against
 * the version as published, which is what the archive was built with (a `0.8.3-rc.1` tag
 * survives sanitization unchanged, and a version carrying build metadata that does not
 * would still not be mistaken for another).
 */
function stagingPrelude(source: AgentRuntimeSource): string[] {
  const safeVersion = source.version.replace(/[^0-9A-Za-z._-]/g, "_");
  return [
    `VERSION='${safeVersion}'`,
    `EXPECTED=${shellQuote(source.version)}`,
    'command -v tar >/dev/null 2>&1 || { echo "远程主机缺少 tar，无法解压 Agent 运行包" >&2; exit 127; }',
    'ROOT="$HOME/.fastvibe-agent"',
    'RELEASE="$ROOT/releases/$VERSION"',
    'TMP="$ROOT/.download-$$"',
    'umask 077',
    'rm -rf "$TMP" && mkdir -p "$TMP/unpacked" || exit 1',
    'cleanup() { rm -rf "$TMP"; }',
    'trap cleanup EXIT',
  ];
}

/** Verify `$TMP/agent.tar.gz`, then replace `releases/<version>` and relink `current`. */
function installStagedArchive(done: string): string[] {
  return [
    '[ -s "$TMP/agent.tar.gz" ] || { echo "Agent 运行包为空" >&2; exit 127; }',
    'tar -xzf "$TMP/agent.tar.gz" -C "$TMP/unpacked" || { echo "Agent 运行包解压失败" >&2; exit 127; }',
    '[ -f "$TMP/unpacked/out/main/agent.js" ] || { echo "Agent 运行包内容不完整" >&2; exit 127; }',
    'UNPACKED=$(awk -F\'"\' \'/"version"/ { print $4; exit }\' "$TMP/unpacked/manifest.json" 2>/dev/null)',
    // A half-written archive that happens to gunzip must not be linked as `current`.
    '[ "$UNPACKED" = "$EXPECTED" ] || { echo "Agent 运行包版本不匹配（期望 $EXPECTED）" >&2; exit 127; }',
    // The archive itself stays out of the release: `releases/<version>` holds only what
    // the Agent runs.
    'rm -rf "$RELEASE" && mkdir -p "$RELEASE" || exit 1',
    'if ! (cd "$TMP/unpacked" && tar -cf - .) | tar -xf - -C "$RELEASE"; then echo "Agent 运行包部署失败" >&2; rm -rf "$RELEASE"; exit 127; fi',
    'ln -sfn "$RELEASE" "$ROOT/current"',
    `echo ${shellQuote(done)}`,
  ];
}

/** `sha256_of FILE` prints the hex digest, or nothing when the host has no tool for it. */
export function sha256Helper(): string[] {
  return [
    'sha256_of() { if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk \'{ print $1 }\'; elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk \'{ print $1 }\'; elif command -v openssl >/dev/null 2>&1; then openssl dgst -sha256 "$1" | awk \'{ print $NF }\'; fi; }',
  ];
}

export function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export async function loadAgentRuntime(
  source: AgentRuntimeSource,
  target: AgentRuntimeTarget,
  onOutput: (message: string) => void,
): Promise<{ archive: Buffer; location: string }> {
  const filename = agentRuntimeFilename(target);
  const localPath = source.artifactDirectory ? join(source.artifactDirectory, filename) : "";
  const versionCache = source.cacheDirectory ? join(source.cacheDirectory, source.version) : "";
  const cachePath = versionCache ? join(versionCache, filename) : "";
  const existingPath = localPath && existsSync(localPath) ? localPath : cachePath && existsSync(cachePath) ? cachePath : "";
  if (existingPath) {
    onOutput(`使用本地预编译 Agent：${filename}`);
    return { archive: readFileSync(existingPath), location: existingPath };
  }

  const url = agentRuntimeUrl(source, target);
  onOutput(`下载预编译 Agent：${filename}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) {
      throw new Error(`找不到远程 Agent 运行包（HTTP ${response.status}）：${filename}`);
    }
    const declaredLength = Number(response.headers.get("content-length") || 0);
    const maxBytes = 512 * 1024 * 1024;
    if (declaredLength > maxBytes) throw new Error(`远程 Agent 运行包过大：${filename}`);
    if (!response.body) throw new Error(`无法读取远程 Agent 运行包：${filename}`);
    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let total = 0;
    for (;;) {
      const part = await reader.read();
      if (part.done) break;
      total += part.value.byteLength;
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`远程 Agent 运行包过大：${filename}`);
      }
      chunks.push(Buffer.from(part.value));
    }
    const archive = Buffer.concat(chunks);
    if (!archive.length) throw new Error(`远程 Agent 运行包为空：${filename}`);
    if (source.cacheDirectory) {
      mkdirSync(versionCache, { recursive: true });
      const temporary = `${cachePath}.${process.pid}.tmp`;
      writeFileSync(temporary, archive, { mode: 0o600 });
      renameSync(temporary, cachePath);
    }
    return { archive, location: url };
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError") throw new Error(`下载远程 Agent 运行包超时：${filename}`);
    throw error;
  } finally {
    clearTimeout(timer);
  }

}
