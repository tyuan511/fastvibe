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
  /** Subscription (OAuth) tokens; the one credential that must outlive a restart. */
  oauthFile: string;
  conversationsFile: string;
  providersFile: string;
  mcpFile: string;
  /** Renderer UI preferences (theme, chat behaviour, …). */
  settingsFile: string;
  /** Main-owned normal window size and maximized state. */
  windowStateFile: string;
  /** User overrides for built-in subagent models. */
  subagentsFile: string;
  /** Per-thinking-block durations, which the engine's transcripts do not record. */
  reasoningFile: string;
  /** Append-only record of finalized turns, so 使用统计 survives session deletion. */
  usageLedgerFile: string;
  /** Durable, Main-owned user message queue. */
  messageQueueFile: string;
  /**
   * Remote-access password hash and device tokens.
   *
   * Deliberately *not* in `settings.json`: that file is handed whole to every renderer
   * (`settings:get`) and broadcast again on every write, so a credential placed there
   * would be shipped to every window — and, once the remote server exists, to every
   * client that connects. Kept apart, and never served by any method.
   */
  remoteAccessFile: string;
};

/**
 * Resolved once per process.
 *
 * The paths are derived from `userData`, which never changes for the life of the
 * app, and the `mkdirSync` sweep below only has to happen once — but this is called
 * from hot paths (the engine event fan-out asks for `settingsFile` on every
 * streamed event), where re-running six `mkdirSync` syscalls per token blocked the
 * main process's event loop for the whole of a fast reply.
 */
let cached: FastVibePaths | null = null;

export function getFastVibePaths(): FastVibePaths {
  return (cached ??= buildFastVibePaths());
}

function buildFastVibePaths(): FastVibePaths {
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
    oauthFile: join(agentDir, "oauth.json"),
    conversationsFile: join(userData, "conversations.json"),
    providersFile: join(userData, "providers.json"),
    mcpFile: join(userData, "mcp.json"),
    settingsFile: join(userData, "settings.json"),
    windowStateFile: join(userData, "window-state.json"),
    subagentsFile: join(agentDir, "subagents.json"),
    reasoningFile: join(runtimeRoot, "reasoning.json"),
    usageLedgerFile: join(runtimeRoot, "usage-ledger.jsonl"),
    messageQueueFile: join(runtimeRoot, "message-queue.json"),
    remoteAccessFile: join(userData, "remote-access.json"),
  };
}
