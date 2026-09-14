import { app } from "electron";
import { mkdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type FastVibePaths = {
  userData: string;
  logs: string;
  ompRoot: string;
  ompAgent: string;
  ompSessions: string;
  ompWorktrees: string;
  /** Scratch workspaces for conversations that are not bound to a project. */
  ompScratch: string;
  ompStderrLog: string;
  modelsYml: string;
  /** pi-coding-agent SDK model registry configuration. */
  modelsJson: string;
  configYml: string;
  agentEnv: string;
  conversationsFile: string;
  providersFile: string;
  mcpFile: string;
};

export function getFastVibePaths(): FastVibePaths {
  const userData = app.getPath("userData");
  const logs = join(userData, "logs");
  const ompRoot = join(userData, "runtime", "omp");
  const ompAgent = join(ompRoot, "agent");
  const ompSessions = join(ompAgent, "sessions");
  const ompWorktrees = join(ompRoot, "wt");
  const ompScratch = join(ompRoot, "scratch");

  for (const dir of [logs, ompAgent, ompSessions, ompWorktrees, ompScratch]) {
    mkdirSync(dir, { recursive: true });
  }

  return {
    userData,
    logs,
    ompRoot,
    ompAgent,
    ompSessions,
    ompWorktrees,
    ompScratch,
    ompStderrLog: join(logs, "omp.stderr.log"),
    modelsYml: join(ompAgent, "models.yml"),
    modelsJson: join(ompAgent, "models.json"),
    configYml: join(ompAgent, "config.yml"),
    agentEnv: join(ompAgent, ".env"),
    conversationsFile: join(userData, "conversations.json"),
    providersFile: join(userData, "providers.json"),
    mcpFile: join(userData, "mcp.json"),
  };
}

export function nativeOmpHome(): string {
  return join(homedir(), ".omp");
}

export function ompSpawnEnv(
  base: NodeJS.ProcessEnv,
  paths: FastVibePaths,
  keys: Record<string, string> = {},
): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    PI_CODING_AGENT_DIR: paths.ompAgent,
    PI_CODING_AGENT_SESSION_DIR: paths.ompSessions,
    OMP_WORKTREE_DIR: paths.ompWorktrees,
  };
  for (const [name, value] of Object.entries(keys)) {
    if (value) env[name] = value;
  }

  // Named profiles live under ~/.omp/profiles — never select one.
  delete env.OMP_PROFILE;
  delete env.PI_PROFILE;

  return env;
}
