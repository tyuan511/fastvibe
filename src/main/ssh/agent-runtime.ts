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
