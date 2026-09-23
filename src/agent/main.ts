#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createAgentRuntime } from "./runtime";
import { configureAgentHttpProxy } from "./http-proxy";
import { registerAgentIpc, agentChannels } from "./handlers";
import { TerminalSessions } from "../main/engine/terminal-sessions";
import { RemoteServer } from "../main/server/server";
import { broadcast, subscribe } from "../main/ipc/broadcast";
import { dispatch } from "../main/ipc/registry";
import { applyShellPath } from "../main/engine/shell-path";
import { loadOrCreateServerIdentity } from "../main/server/identity";
import { HEADLESS_CAPABILITIES } from "../main/app-server/capabilities";
import { createAppServer, initAppServer } from "../main/app-server/runtime";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDataRoot = join(homedir(), ".fastvibe");

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

const userData = option("--data-dir") || process.env.FASTVIBE_USER_DATA || defaultDataRoot;
const port = Number(option("--port") ?? (process.env.FASTVIBE_AGENT_PORT || 7777));
/**
 * Where this Agent records its pid, port and version once listening (`<data>/agent.json`).
 *
 * The SSH bootstrap starts the Agent on `--port=0`: the OS picks a free port, so no fixed
 * port can be taken by another user or program, and this file is how the desktop then
 * finds it. The bootstrap passes the path explicitly so it never depends on how the
 * login shell happens to set `FASTVIBE_USER_DATA`.
 */
const stateFile = option("--state-file") || join(userData, "agent.json");
const resourcesPath = process.env.FASTVIBE_RESOURCES_PATH || join(here, "../../resources");

if (!Number.isInteger(port) || port < 0 || port > 65_535) throw new Error("FASTVIBE_AGENT_PORT 无效");

// The headless service can also start outside a login shell.
applyShellPath();
configureAgentHttpProxy();

const runtime = createAgentRuntime({ userData, resourcesPath });
const terminals = new TerminalSessions();

registerAgentIpc({
  runtime,
  terminals,
  log: {
    info: (message) => console.info(`[fastvibe-agent] ${message}`),
    warn: (message) => console.warn(`[fastvibe-agent] ${message}`),
    error: (message, error) => console.error(`[fastvibe-agent] ${message}`, error ?? ""),
  },
});

const appServer = createAppServer({
  identity: loadOrCreateServerIdentity(runtime.paths.serverIdentityFile, {
    version: process.env.FASTVIBE_VERSION || "agent",
    platform: process.platform,
  }),
  capabilities: HEADLESS_CAPABILITIES,
  channels: agentChannels,
  log: {
    info: (message) => console.info(`[fastvibe-agent] ${message}`),
    warn: (message) => console.warn(`[fastvibe-agent] ${message}`),
  },
});
initAppServer({
  dispatch: (method, payload, context) =>
    dispatch(method, payload, { kind: context.kind, window: null, origin: context.origin }),
});

const server = new RemoteServer({
  accessFile: runtime.paths.remoteAccessFile,
  appServer,
  channels: agentChannels,
  policyScope: "subset",
  // The bootstrap starts this process with the token it also hands the desktop over SSH.
  loopbackToken: process.env.FASTVIBE_AGENT_SYNC_TOKEN || undefined,
  dispatch: (method, payload, clientId) => dispatch(method, payload, { kind: "remote", window: null, origin: clientId }),
  subscribe,
  webRoot: process.env.FASTVIBE_WEB_ROOT || join(here, "../renderer"),
  log: {
    info: (message) => console.info(`[fastvibe-agent] ${message}`),
    warn: (message) => console.warn(`[fastvibe-agent] ${message}`),
    error: (message, error) => console.error(`[fastvibe-agent] ${message}`, error ?? ""),
  },
});

let stopping = false;
async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  await server.stop();
  removeStateFile();
  terminals.dispose();
  await runtime.engine.stop();
  runtime.engine.flush();
}

process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void stop().finally(() => process.exit(0)));

await runtime.engine.start();
const listening = (await server.start({ port, host: "127.0.0.1" })).port ?? port;
writeStateFile(listening);
broadcast("agent:ready", { port: listening, userData });
console.info(`[fastvibe-agent] ready on 127.0.0.1:${listening}`);

/**
 * Written only after `listen` succeeded, so its presence means the port accepts. One
 * field per line: the bootstrap reads it with `sed`, not a JSON parser.
 */
function writeStateFile(listeningPort: number): void {
  mkdirSync(dirname(stateFile), { recursive: true });
  const temporary = `${stateFile}.${process.pid}.tmp`;
  const state = { pid: process.pid, port: listeningPort, version: process.env.FASTVIBE_VERSION || null, startedAt: new Date().toISOString() };
  writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
  renameSync(temporary, stateFile);
}

/** Remove the state file only if it is still ours — a successor may already own it. */
function removeStateFile(): void {
  try {
    const recorded = JSON.parse(readFileSync(stateFile, "utf8")) as { pid?: unknown };
    if (recorded.pid === process.pid) rmSync(stateFile, { force: true });
  } catch {
    // Already gone.
  }
}
