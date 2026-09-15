import { app } from "electron";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

export type FastVibePaths = {
  userData: string;
  logs: string;
  runtimeRoot: string;
  agentDir: string;
  skillsDir: string;
  sessionsDir: string;
  worktreesDir: string;
  /** Scratch workspaces for conversations that are not bound to a project. */
  scratchDir: string;
  /** pi-coding-agent SDK model registry configuration. */
  modelsJson: string;
  agentEnv: string;
  conversationsFile: string;
  providersFile: string;
  mcpFile: string;
  /** Renderer UI preferences (theme, chat behaviour, …). */
  settingsFile: string;
  /** Per-thinking-block durations, which the engine's transcripts do not record. */
  reasoningFile: string;
  /** Append-only record of finalized turns, so 使用统计 survives session deletion. */
  usageLedgerFile: string;
};

export function getFastVibePaths(): FastVibePaths {
  const userData = app.getPath("userData");
  const logs = join(userData, "logs");
  const runtimeRoot = join(userData, "runtime", "engine");
  const agentDir = join(runtimeRoot, "agent");
  const skillsDir = join(agentDir, "skills");
  const sessionsDir = join(agentDir, "sessions");
  const worktreesDir = join(runtimeRoot, "wt");
  const scratchDir = join(runtimeRoot, "scratch");

  for (const dir of [logs, agentDir, skillsDir, sessionsDir, worktreesDir, scratchDir]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    userData,
    logs,
    runtimeRoot,
    agentDir,
    skillsDir,
    sessionsDir,
    worktreesDir,
    scratchDir,
    modelsJson: join(agentDir, "models.json"),
    agentEnv: join(agentDir, ".env"),
    conversationsFile: join(userData, "conversations.json"),
    providersFile: join(userData, "providers.json"),
    mcpFile: join(userData, "mcp.json"),
    settingsFile: join(userData, "settings.json"),
    reasoningFile: join(runtimeRoot, "reasoning.json"),
    usageLedgerFile: join(runtimeRoot, "usage-ledger.jsonl"),
  };
}
