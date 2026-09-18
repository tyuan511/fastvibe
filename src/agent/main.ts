#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { homedir } from "node:os";
import { createAgentRuntime } from "./runtime";
import { registerAgentIpc, agentChannels } from "./handlers";
import { TerminalSessions } from "../main/engine/terminal-sessions";
import { RemoteServer } from "../main/server/server";
import { broadcast, subscribe } from "../main/ipc/broadcast";
import { dispatch } from "../main/ipc/registry";
import { getFastVibePaths } from "../main/engine/paths";
import { applyShellPath } from "../main/engine/shell-path";

const here = dirname(fileURLToPath(import.meta.url));
const defaultDataRoot = join(homedir(), ".fastvibe");

function option(name: string): string | undefined {
  const prefix = `${name}=`;
  const value = process.argv.find((item) => item.startsWith(prefix));
  return value ? value.slice(prefix.length) : undefined;
}

const userData = option("--data-dir") || process.env.FASTVIBE_USER_DATA || defaultDataRoot;
const port = Number(option("--port") || process.env.FASTVIBE_AGENT_PORT || 7777);
const resourcesPath = process.env.FASTVIBE_RESOURCES_PATH || join(here, "../../resources");

if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error("FASTVIBE_AGENT_PORT 无效");

// The headless service can also start outside a login shell.
applyShellPath();

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

const server = new RemoteServer({
  accessFile: runtime.paths.remoteAccessFile,
  channels: agentChannels,
  policyScope: "subset",
  allowLoopbackAuth: true,
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
  terminals.dispose();
  await runtime.engine.stop();
  runtime.engine.flush();
}

process.once("SIGTERM", () => void stop().finally(() => process.exit(0)));
process.once("SIGINT", () => void stop().finally(() => process.exit(0)));

await runtime.engine.start();
await server.start({ port, host: "127.0.0.1" });
broadcast("agent:ready", { port, userData });
console.info(`[fastvibe-agent] ready on 127.0.0.1:${port}`);
