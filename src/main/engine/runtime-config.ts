import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { AGENT_CONFIG_FILES, type AgentConfigFile, type AgentConfigSnapshot } from "../../shared/agent-config.ts";
import type { FastVibePaths } from "./paths";

function filePaths(paths: FastVibePaths): Record<AgentConfigFile, string> {
  return {
    settings: paths.settingsFile,
    providers: paths.providersFile,
    agentEnv: paths.agentEnv,
    oauth: paths.oauthFile,
    models: paths.modelsJson,
    modelsDev: join(paths.userData, "models-dev.json"),
    agentSettings: join(paths.agentDir, "settings.json"),
    mcp: paths.mcpFile,
    subagents: paths.subagentsFile,
  };
}

/** Read the desktop's engine configuration for an SSH Agent. */
export function readAgentConfig(paths: FastVibePaths): AgentConfigSnapshot {
  const result: AgentConfigSnapshot = {};
  const pathsByKey = filePaths(paths);
  for (const key of AGENT_CONFIG_FILES) {
    const path = pathsByKey[key];
    result[key] = existsSync(path) ? readFileSync(path, "utf8") : null;
  }
  return result;
}

/** Replace the Agent's configuration, validating every file before writing any of it. */
export function writeAgentConfig(paths: FastVibePaths, snapshot: AgentConfigSnapshot): void {
  const pathsByKey = filePaths(paths);
  validateSnapshot(snapshot);
  for (const key of AGENT_CONFIG_FILES) {
    if (!(key in snapshot)) continue;
    const value = snapshot[key];
    const path = pathsByKey[key];
    if (value == null) {
      rmSync(path, { force: true });
      continue;
    }
    mkdirSync(dirname(path), { recursive: true });
    const temporary = `${path}.sync-${process.pid}`;
    try {
      writeFileSync(temporary, value, { mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

const JSON_CONFIG_FILES = new Set<AgentConfigFile>([
  "settings",
  "providers",
  "oauth",
  "models",
  "modelsDev",
  "agentSettings",
  "mcp",
  "subagents",
]);
const MAX_CONFIG_FILE_BYTES = 16 * 1024 * 1024;

function validateSnapshot(snapshot: AgentConfigSnapshot): void {
  for (const key of AGENT_CONFIG_FILES) {
    if (!(key in snapshot)) continue;
    const value = snapshot[key];
    if (value == null) continue;
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > MAX_CONFIG_FILE_BYTES) {
      throw new Error(`远程配置文件过大或格式无效：${key}`);
    }
    if (JSON_CONFIG_FILES.has(key)) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(value);
      } catch {
        throw new Error(`远程配置文件不是有效 JSON：${key}`);
      }
      if (key === "mcp" && !Array.isArray(parsed)) throw new Error("远程 MCP 配置格式无效");
    }
  }
}
