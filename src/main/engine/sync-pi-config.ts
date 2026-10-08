import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { Credential } from "@earendil-works/pi-ai";
import type { McpServerConfig, PiConfigSyncReport } from "@shared/types";
import { readPreferredModelSettings } from "./app-settings";
import { readOAuthCredentials } from "./oauth-store";
import type { FastVibePaths } from "./paths";
import {
  piProviderModelsEntry,
  writePiAgentConfig,
  type PiSyncCredential,
  type PiSyncMcpServer,
  type PiSyncMode,
  type PiSyncProviderInput,
} from "./pi-global-sync.ts";
import { connectedProviderIds, loadProviderKeys, readProviders } from "./providers";

/** The CLI's own agent directory. FastVibe never uses this as its runtime. */
export function globalPiAgentDir(): string {
  return join(homedir(), ".pi", "agent");
}

/**
 * Copy the connected configuration into the global pi agent directory.
 *
 * Sessions, UI preferences and FastVibe's own files stay where they are. See
 * `pi-global-sync.ts` for what is merged and what is left alone.
 */
export async function syncFastVibeConfigToPi(
  paths: FastVibePaths,
  agentDir = globalPiAgentDir(),
  mode: PiSyncMode = "merge",
): Promise<PiConfigSyncReport> {
  const providers = readProviders(paths);
  const keys = await loadProviderKeys(paths);
  const oauth = readOAuthCredentials(paths.oauthFile);
  const connected = connectedProviderIds(paths, keys);
  const skipped: string[] = [];
  const inputs: PiSyncProviderInput[] = [];

  for (const provider of providers) {
    if (!connected.has(provider.id)) {
      // An empty, never-connected builtin row is not news. A provider the user
      // turned on and then left without a credential is.
      if (provider.enabled && (provider.kind === "native" || provider.models.length > 0)) skipped.push(provider.name);
      continue;
    }
    const key = keys[provider.apiKeyEnv];
    const subscription = oauthCredential(oauth[provider.id]);
    if (provider.kind === "native") {
      // The subscription is what a login replaced the key with. Writing both would
      // let pi prefer the oauth entry and ignore the key.
      const credential = subscription ?? (key ? { type: "api_key" as const, key } : undefined);
      const models = piProviderModelsEntry(provider);
      if (!credential && !models) {
        skipped.push(provider.name);
        continue;
      }
      inputs.push({
        id: provider.id,
        kind: provider.kind,
        ...(models ? { models } : {}),
        ...(credential ? { credential } : {}),
      });
      continue;
    }
    // pi uses a stored oauth credential ahead of `models.json`, and a custom
    // provider has no oauth login in the CLI. A pasted key is the one that works,
    // so the subscription is only written when there is no key.
    const credential = !key && subscription ? subscription : undefined;
    const models = piProviderModelsEntry(provider, key);
    if (!models && !credential) {
      skipped.push(provider.name);
      continue;
    }
    inputs.push({
      id: provider.id,
      kind: provider.kind,
      ...(models ? { models } : {}),
      ...(credential ? { credential } : {}),
    });
  }

  const preferred = readPreferredModelSettings(paths);
  return writePiAgentConfig(agentDir, {
    providers: inputs,
    skipped,
    ...(preferred.model ? { defaultModel: preferred.model } : {}),
    ...(preferred.thinkingLevel && preferred.thinkingLevel !== "auto" ? { thinkingLevel: preferred.thinkingLevel } : {}),
    mcp: readMcpServers(paths.mcpFile),
    mode,
  }, paths.agentDir);
}

function oauthCredential(value: Credential | undefined): PiSyncCredential | undefined {
  if (!value || value.type !== "oauth") return undefined;
  if (typeof value.access !== "string" || typeof value.refresh !== "string" || typeof value.expires !== "number") return undefined;
  return { type: "oauth", access: value.access, refresh: value.refresh, expires: value.expires };
}

function readMcpServers(file: string): PiSyncMcpServer[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return [];
  }
  if (!Array.isArray(parsed)) return [];
  const servers: PiSyncMcpServer[] = [];
  for (const item of parsed) {
    if (!item || typeof item !== "object") continue;
    const server = item as Partial<McpServerConfig>;
    if (typeof server.name !== "string" || typeof server.id !== "string") continue;
    if (server.transport !== "stdio" && server.transport !== "http") continue;
    const args = Array.isArray(server.args) ? server.args.filter((arg): arg is string => typeof arg === "string") : undefined;
    servers.push({
      name: server.name,
      id: server.id,
      enabled: server.enabled !== false,
      transport: server.transport,
      ...(typeof server.command === "string" ? { command: server.command } : {}),
      ...(args && args.length > 0 ? { args } : {}),
      ...(server.env && typeof server.env === "object" ? { env: server.env } : {}),
      ...(typeof server.url === "string" ? { url: server.url } : {}),
    });
  }
  return servers;
}
