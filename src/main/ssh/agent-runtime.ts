import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { downloadHelpers, GITHUB_MIRROR, loginEnvironment, remoteShellCommand, shellQuote } from "./remote-shell.ts";
export { shellQuote } from "./remote-shell.ts";

export type AgentRuntimeTarget = "linux-x64" | "linux-arm64";

export type AgentRuntimeArtifact = {
  /** Full content hash of the unpacked runtime, excluding manifest.json. */
  runtimeHash: string;
  archive?: string;
  archiveSha256?: string;
};

/**
 * Runtime release metadata. `release` is intentionally independent of the desktop semver
 * (for example `agent-runtime-v12`); hashes are integrity/deduplication data, not UI names.
 */
export type AgentRuntimeSource = {
  release: string;
  targets: Partial<Record<AgentRuntimeTarget, AgentRuntimeArtifact>>;
  /** Optional local directory containing fastvibe-agent-<target>.tar.gz. */
  artifactDirectory?: string;
  /** Cache downloaded archives so reconnecting does not hit GitHub again. */
  cacheDirectory?: string;
  releaseBaseUrl?: string;
};

export function readAgentRuntimeSource(path: string): AgentRuntimeSource {
  const value = JSON.parse(readFileSync(path, "utf8")) as { schema?: unknown } & Partial<AgentRuntimeSource>;
  if (value.schema !== 1 || typeof value.release !== "string" || !/^agent-runtime-v[0-9]+$/.test(value.release)) {
    throw new Error(`Agent runtime release metadata 无效：缺少可读的 release 版本（${path}）`);
  }
  const release = value.release;
  const targets: Partial<Record<AgentRuntimeTarget, AgentRuntimeArtifact>> = {};
  for (const target of ["linux-x64", "linux-arm64"] as const) {
    const item = value.targets?.[target];
    if (!item || typeof item.runtimeHash !== "string" || !/^[a-f0-9]{64}$/.test(item.runtimeHash)) {
      throw new Error(`Agent runtime release metadata 无效：缺少 ${target} 的 runtimeHash`);
    }
    if (item.archive !== undefined && item.archive !== agentRuntimeFilename(target)) {
      throw new Error(`Agent runtime release metadata 无效：${target} 的 archive 名称不匹配`);
    }
    if (item.archiveSha256 !== undefined && (typeof item.archiveSha256 !== "string" || !/^[a-f0-9]{64}$/.test(item.archiveSha256))) {
      throw new Error(`Agent runtime release metadata 无效：${target} 的 archiveSha256 无效`);
    }
    targets[target] = {
      runtimeHash: item.runtimeHash,
      ...(item.archive ? { archive: item.archive } : {}),
      ...(item.archiveSha256 ? { archiveSha256: item.archiveSha256 } : {}),
    };
  }
  return { release, targets };
}

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

function artifactFor(source: AgentRuntimeSource, target: AgentRuntimeTarget): AgentRuntimeArtifact {
  const artifact = source.targets[target];
  if (!artifact) throw new Error(`当前构建不包含 ${target} 的 Agent runtime（${source.release}）`);
  return artifact;
}

export function agentRuntimeUrl(source: AgentRuntimeSource, target: AgentRuntimeTarget): string {
  const base = (source.releaseBaseUrl || "https://github.com/tyuan511/fastvibe/releases/download").replace(/\/$/, "");
  return `${base}/${encodeURIComponent(source.release)}/${agentRuntimeFilename(target)}`;
}

/** The same archive through the GitHub mirror, for hosts that cannot reach GitHub. */
export function agentRuntimeMirrorUrl(source: AgentRuntimeSource, target: AgentRuntimeTarget): string | undefined {
  const url = agentRuntimeUrl(source, target);
  return url.startsWith("https://github.com/") ? `${GITHUB_MIRROR}${url}` : undefined;
}

/** Deploy the Agent by having the remote host fetch the release archive. */
export function agentRuntimeRemoteDownloadCommand(source: AgentRuntimeSource, target: AgentRuntimeTarget): string {
  const script = [
    ...stagingPrelude(source, target),
    `URL=${shellQuote(agentRuntimeUrl(source, target))}`,
    `MIRROR_URL=${shellQuote(agentRuntimeMirrorUrl(source, target) ?? "")}`,
    ...loginEnvironment(),
    "load_login_env",
    ...downloadHelpers(),
    `echo "正在由远程主机直接下载 Agent 运行包：${agentRuntimeFilename(target)}（$(fv_host \"$URL\")）"`,
    'fv_download agent-download "$TMP/agent.tar.gz" "$URL" "$MIRROR_URL" || { echo "Agent 运行包下载失败" >&2; exit 127; }',
    ...installStagedArchive("远程主机已直接下载并部署 Agent"),
  ].join("\n");
  return remoteShellCommand(script);
}

/** Deploy an archive this desktop pushes through SSH stdin. */
export function agentRuntimeUploadCommand(source: AgentRuntimeSource, target: AgentRuntimeTarget, sha256: string): string {
  const safeSha = /^[a-f0-9]{64}$/.test(sha256) ? sha256 : "";
  const script = [
    ...stagingPrelude(source, target),
    'cat > "$TMP/agent.tar.gz" || { echo "Agent 运行包上传失败" >&2; exit 127; }',
    `EXPECTED_SHA='${safeSha}'`,
    ...sha256Helper(),
    'ACTUAL_SHA=$(sha256_of "$TMP/agent.tar.gz")',
    'if [ -z "$ACTUAL_SHA" ]; then echo "远程主机缺少 sha256sum/shasum，跳过校验和检查"; elif [ "$ACTUAL_SHA" != "$EXPECTED_SHA" ]; then echo "Agent 运行包上传不完整（校验和不匹配）" >&2; exit 127; fi',
    ...installStagedArchive("预编译 Agent 已部署"),
  ].join("\n");
  return remoteShellCommand(script);
}

/** Variables and a private staging directory shared by both deploy paths. */
function stagingPrelude(source: AgentRuntimeSource, target: AgentRuntimeTarget): string[] {
  const safeRelease = source.release.replace(/[^0-9A-Za-z._-]/g, "_");
  const artifact = artifactFor(source, target);
  return [
    `VERSION='${safeRelease}'`,
    `EXPECTED_HASH=${shellQuote(artifact.runtimeHash)}`,
    `EXPECTED_ARCHIVE_SHA=${shellQuote(artifact.archiveSha256 ?? "")}`,
    `EXPECTED_TARGET=${shellQuote(target)}`,
    'command -v tar >/dev/null 2>&1 || { echo "远程主机缺少 tar，无法解压 Agent 运行包" >&2; exit 127; }',
    'ROOT="$HOME/.fastvibe-agent"',
    'RELEASE="$ROOT/releases/$VERSION"',
    'TMP="$ROOT/.download-$$"',
    'umask 077',
    'rm -rf "$TMP" && mkdir -p "$TMP/unpacked" || exit 1',
    'cleanup() { rm -rf "$TMP"; }',
    'trap cleanup EXIT',
    ...sha256Helper(),
  ];
}

/** Verify `$TMP/agent.tar.gz`, then replace `releases/<release>` and relink `current`. */
function installStagedArchive(done: string): string[] {
  return [
    '[ -s "$TMP/agent.tar.gz" ] || { echo "Agent 运行包为空" >&2; exit 127; }',
    'ACTUAL_ARCHIVE_SHA=$(sha256_of "$TMP/agent.tar.gz")',
    'if [ -n "$EXPECTED_ARCHIVE_SHA" ] && [ -n "$ACTUAL_ARCHIVE_SHA" ] && [ "$ACTUAL_ARCHIVE_SHA" != "$EXPECTED_ARCHIVE_SHA" ]; then echo "Agent 运行包校验和不匹配" >&2; exit 127; fi',
    'tar -xzf "$TMP/agent.tar.gz" -C "$TMP/unpacked" || { echo "Agent 运行包解压失败" >&2; exit 127; }',
    '[ -f "$TMP/unpacked/out/main/agent.js" ] || { echo "Agent 运行包内容不完整" >&2; exit 127; }',
    'UNPACKED_HASH=$(awk -F\'"\' \'/"runtimeHash"/ { print $4; exit }\' "$TMP/unpacked/manifest.json" 2>/dev/null)',
    'if [ -z "$UNPACKED_HASH" ]; then UNPACKED_HASH=$(awk -F\'"\' \'/"version"/ { print $4; exit }\' "$TMP/unpacked/manifest.json" 2>/dev/null); fi',
    '[ "$UNPACKED_HASH" = "$EXPECTED_HASH" ] || { echo "Agent 运行包内容校验失败（runtimeHash 不匹配）" >&2; exit 127; }',
    'UNPACKED_PLATFORM=$(awk -F\'"\' \'/"platform"/ { print $4; exit }\' "$TMP/unpacked/manifest.json" 2>/dev/null)',
    'UNPACKED_ARCH=$(awk -F\'"\' \'/"arch"/ { print $4; exit }\' "$TMP/unpacked/manifest.json" 2>/dev/null)',
    '[ "$UNPACKED_PLATFORM-$UNPACKED_ARCH" = "$EXPECTED_TARGET" ] || { echo "Agent 运行包架构不匹配" >&2; exit 127; }',
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

function archiveMatches(archive: Buffer, expected: string | undefined): boolean {
  return !expected || createHash("sha256").update(archive).digest("hex") === expected;
}

export async function loadAgentRuntime(
  source: AgentRuntimeSource,
  target: AgentRuntimeTarget,
  onOutput: (message: string) => void,
  onProgress?: (done: number, total: number | undefined) => void,
): Promise<{ archive: Buffer; location: string }> {
  const filename = agentRuntimeFilename(target);
  const artifact = artifactFor(source, target);
  const localPath = source.artifactDirectory ? join(source.artifactDirectory, filename) : "";
  const releaseCache = source.cacheDirectory ? join(source.cacheDirectory, source.release, target) : "";
  const cachePath = releaseCache ? join(releaseCache, filename) : "";
  for (const candidate of [localPath, cachePath]) {
    if (!candidate || !existsSync(candidate)) continue;
    const archive = readFileSync(candidate);
    if (archiveMatches(archive, artifact.archiveSha256)) {
      onOutput(`使用本地预编译 Agent：${filename}`);
      return { archive, location: candidate };
    }
    if (candidate === cachePath) rmSync(candidate, { force: true });
    onOutput(`本地 Agent 运行包校验失败，重新下载：${filename}`);
  }

  const url = agentRuntimeUrl(source, target);
  onOutput(`下载预编译 Agent：${filename}`);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 120_000);
  try {
    const response = await fetch(url, { redirect: "follow", signal: controller.signal });
    if (!response.ok) throw new Error(`找不到远程 Agent 运行包（HTTP ${response.status}）：${filename}`);
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
      onProgress?.(total, declaredLength || undefined);
      if (total > maxBytes) {
        await reader.cancel();
        throw new Error(`远程 Agent 运行包过大：${filename}`);
      }
      chunks.push(Buffer.from(part.value));
    }
    const archive = Buffer.concat(chunks);
    if (!archive.length) throw new Error(`远程 Agent 运行包为空：${filename}`);
    if (!archiveMatches(archive, artifact.archiveSha256)) throw new Error(`远程 Agent 运行包校验和不匹配：${filename}`);
    if (source.cacheDirectory) {
      mkdirSync(releaseCache, { recursive: true });
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
