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
  /**
   * Parent of the scratch workspaces for conversations that are not bound to a project.
   * Each such conversation gets its own `scratch/<conversationId>` directory — they must
   * not share one, or one chat's files are the other's.
   */
  scratchDir: string;
  /** pi-coding-agent SDK model registry configuration. */
  modelsJson: string;
  agentEnv: string;
  /** Subscription (OAuth) tokens; the one credential that must outlive a restart. */
  oauthFile: string;
  conversationsFile: string;
  providersFile: string;
  gatewayCredentialsFile: string;
  mcpFile: string;
  /** Which decision model browser use runs on (off / Jev); see `src/main/engine/decision/`. */
  decisionFile: string;
  /** Append-only record of decision-layer calls: hashes and summaries, never page text. */
  decisionTraceFile: string;
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
  /** Durable memory configuration, separate from renderer settings. */
  memoryFile: string;
  /** SQLite semantic/JEV memory index. */
  memoryDatabaseFile: string;
  /** On-demand local embedding model cache. */
  memoryModelsDir: string;
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
  /** Saved SSH host profiles; the file is private because it may contain an SSH password. */
  sshHostsFile: string;
  /** The self-hosted frp tunnel's settings, token included; 0600 and never served. */
  frpFile: string;
  /** The `frpc.toml` rendered from `frpFile` at each start. Holds the token too. */
  frpcConfigFile: string;
  /**
   * Remote projects on other App Servers, as references.
   *
   * Separate from `conversationsFile` because the two have different owners: a binding
   * points at something another server owns and must outlive that server being
   * unreachable, while the catalog holds chats this machine really has.
   */
  projectBindingsFile: string;
  /**
   * This installation's stable identity.
   *
   * Read by every handshake, and what makes `remote:<server>:<id>` mean something on
   * both ends. Kept beside the conversations rather than in `settings.json`, which is a
   * file the user is expected to reset.
   */
  serverIdentityFile: string;
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
/**
 * Scratch directory for one unbound conversation: `scratch/<conversationId>`.
 *
 * The id is sanitized so a session id cannot escape the scratch root. Callers that
 * are about to use the path as a cwd want `ensureScratchWorkspace` instead, which
 * creates it.
 */
export function scratchWorkspace(scratchDir: string, conversationId: string): string {
  const safe = conversationId.replace(/[^A-Za-z0-9._-]/g, "_").replace(/^\.+/g, "").slice(0, 128);
  return join(scratchDir, safe || "chat");
}

/** Create `scratch/<conversationId>` and return it. */
export function ensureScratchWorkspace(scratchDir: string, conversationId: string): string {
  const dir = scratchWorkspace(scratchDir, conversationId);
  mkdirSync(dir, { recursive: true });
  return dir;
}

let cached: FastVibePaths | null = null;
let configuredUserData: string | undefined;

/**
 * Set the data root before the first engine is created.
 *
 * Electron Main calls this with app.getPath("userData"); a headless Agent calls it
 * from its own service configuration. Keeping the path provider free of Electron is
 * what lets the same engine runtime load in a plain Linux Node process.
 */
export function configureFastVibeUserData(userData: string): void {
  const root = userData.trim();
  if (!root) throw new Error("FastVibe 数据目录不能为空");
  configuredUserData = root;
  cached = null;
}

export function getFastVibePaths(): FastVibePaths {
  return (cached ??= buildFastVibePaths());
}

function buildFastVibePaths(): FastVibePaths {
  const userData = configuredUserData ?? process.env.FASTVIBE_USER_DATA;
  if (!userData) throw new Error("FastVibe 数据目录尚未配置");
  const logs = join(userData, "logs");
  const runtimeRoot = join(userData, "runtime", "engine");
  const agentDir = join(runtimeRoot, "agent");
  const skillsDir = join(agentDir, "skills");
  const sessionsDir = join(agentDir, "sessions");
  const worktreesDir = join(runtimeRoot, "wt");
  const scratchDir = join(runtimeRoot, "scratch");
  const memoryModelsDir = join(runtimeRoot, "models", "memory");

  for (const dir of [logs, agentDir, skillsDir, sessionsDir, worktreesDir, scratchDir, memoryModelsDir]) {
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
    /** Panel credentials for custom relays (new-api); never served, never in providers.json. */
    gatewayCredentialsFile: join(userData, "gateway-credentials.json"),
    mcpFile: join(userData, "mcp.json"),
    decisionFile: join(userData, "decision.json"),
    decisionTraceFile: join(runtimeRoot, "decision-trace.jsonl"),
    settingsFile: join(userData, "settings.json"),
    windowStateFile: join(userData, "window-state.json"),
    subagentsFile: join(agentDir, "subagents.json"),
    reasoningFile: join(runtimeRoot, "reasoning.json"),
    usageLedgerFile: join(runtimeRoot, "usage-ledger.jsonl"),
    memoryFile: join(runtimeRoot, "memory.json"),
    memoryDatabaseFile: join(runtimeRoot, "memory.sqlite"),
    memoryModelsDir,
    messageQueueFile: join(runtimeRoot, "message-queue.json"),
    remoteAccessFile: join(userData, "remote-access.json"),
    sshHostsFile: join(userData, "ssh-hosts.json"),
    frpFile: join(userData, "frp.json"),
    frpcConfigFile: join(userData, "frpc.toml"),
    projectBindingsFile: join(userData, "project-bindings.json"),
    serverIdentityFile: join(userData, "server-identity.json"),
  };
}
