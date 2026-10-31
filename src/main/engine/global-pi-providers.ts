import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { type ModelRegistry, readStoredCredential } from "@earendil-works/pi-coding-agent";
import { getSupportedThinkingLevels } from "@earendil-works/pi-ai";
import type { FastVibeModel, ProviderModel } from "@shared/types";
import { findNativeProvider, listNativeProviders } from "./native-providers";
import { escapePiConfigSecret, piProviderModelsEntry } from "./pi-global-sync";
import type { FastVibePaths } from "./paths";

type Bag = Record<string, unknown>;
export type GlobalProvider = {
  id: string; kind: "native" | "custom"; name: string; baseUrl: string; api: string;
  apiKeyEnv: string; enabled: boolean; models: ProviderModel[]; modelOrder?: string[];
};
const bag = (value: unknown): Bag => value && typeof value === "object" && !Array.isArray(value) ? value as Bag : {};

/** Missing is empty; unreadable or malformed must stop a write, never replace it. */
function readObject(file: string): Bag {
  try {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error(`Invalid configuration: ${file}`);
    return value as Bag;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}
function writeObject(file: string, value: Bag): void {
  mkdirSync(dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  writeFileSync(temp, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  renameSync(temp, file);
}

export function readGlobalPiProviders(paths: FastVibePaths): GlobalProvider[] {
  const config = readObject(paths.modelsJson);
  const entries = bag(config.providers);
  const auth = readObject(paths.oauthFile);
  const ids = new Set([...Object.keys(entries), ...Object.keys(auth)]);
  // Environment-only native providers are visible too, without evaluating commands.
  for (const native of listNativeProviders()) {
    if (Object.keys(process.env).some((key) => key === `${native.id.replace(/-/g, "_").toUpperCase()}_API_KEY` && process.env[key])) ids.add(native.id);
  }
  return [...ids].map((id) => {
    const raw = bag(entries[id]);
    const native = findNativeProvider(id);
    const models = Array.isArray(raw.models) ? raw.models.map((value) => {
      const model = bag(value);
      return {
        ...model,
        id: String(model.id ?? ""), name: String(model.name ?? model.id ?? ""),
        contextWindow: typeof model.contextWindow === "number" ? model.contextWindow : 128000,
        maxTokens: typeof model.maxTokens === "number" ? model.maxTokens : 8192,
        reasoning: model.reasoning === true, input: Array.isArray(model.input) ? model.input : ["text"],
        edited: true,
      } as ProviderModel;
    }) : (native?.models ?? []).map((model) => ({ ...model, ...bag(bag(raw.modelOverrides)[model.id]), edited: true }));
    return {
      id, kind: native ? "native" : "custom", name: String(raw.name ?? native?.name ?? id),
      baseUrl: String(raw.baseUrl ?? native?.baseUrl ?? ""), api: String(raw.api ?? native?.api ?? "openai-completions"),
      apiKeyEnv: id, enabled: raw.enabled !== false, models,
    };
  });
}

/** Preserve every provider/model field not explicitly changed by the UI. */
export function updateGlobalPiProvider(paths: FastVibePaths, provider: GlobalProvider, changed: string[]): void {
  const config = readObject(paths.modelsJson);
  const entries = bag(config.providers);
  const previous = bag(entries[provider.id]);
  const next = { ...previous };
  for (const key of ["name", "baseUrl", "api", "enabled"] as const) {
    if (changed.includes(key)) next[key] = provider[key];
  }
  if (changed.includes("models") || changed.includes("modelOrder")) {
    const rendered = piProviderModelsEntry(provider) ?? {};
    if (provider.kind === "native") {
      const old = bag(previous.modelOverrides);
      next.modelOverrides = Object.fromEntries(Object.entries(bag(rendered.modelOverrides)).map(([id, value]) => [id, { ...bag(old[id]), ...bag(value) }]));
    } else {
      const old = new Map((Array.isArray(previous.models) ? previous.models : []).map((model) => [bag(model).id, bag(model)]));
      next.models = (Array.isArray(rendered.models) ? rendered.models : []).map((model) => ({ ...old.get(bag(model).id), ...bag(model) }));
    }
  }
  config.providers = { ...entries, [provider.id]: next };
  writeObject(paths.modelsJson, config);
}

export async function setGlobalPiKey(paths: FastVibePaths, id: string, key: string): Promise<void> {
  const current = readStoredCredential(id, paths.oauthFile);
  const auth = readObject(paths.oauthFile);
  if (key.trim()) auth[id] = { type: "api_key", key: key.trim() };
  else if (current?.type === "api_key") delete auth[id];
  writeObject(paths.oauthFile, auth);
  // An existing models.json key takes precedence over auth.json. Explicit key edits
  // retire that expression; unrelated edits leave it byte-for-byte unchanged.
  const config = readObject(paths.modelsJson);
  const entries = bag(config.providers);
  if ("apiKey" in bag(entries[id])) {
    const next = { ...bag(entries[id]) };
    delete next.apiKey;
    config.providers = { ...entries, [id]: next };
    writeObject(paths.modelsJson, config);
  }
}
export async function removeGlobalPiProvider(paths: FastVibePaths, id: string): Promise<void> {
  const config = readObject(paths.modelsJson);
  const entries = { ...bag(config.providers) };
  delete entries[id];
  config.providers = entries;
  writeObject(paths.modelsJson, config);
  const auth = readObject(paths.oauthFile);
  delete auth[id];
  writeObject(paths.oauthFile, auth);
}
export function globalPiModels(registry: ModelRegistry): FastVibeModel[] {
  return registry.getAvailable().filter((model) => registry.hasConfiguredAuth(model)).map((model) => ({
    provider: model.provider, providerName: findNativeProvider(model.provider)?.name ?? model.provider,
    id: model.id, name: model.name,
    thinkingLevels: getSupportedThinkingLevels(model).filter((level) => level !== "off"),
  }));
}
export function globalPiCredentialKinds(paths: FastVibePaths): Map<string, string> {
  const kinds = new Map(Object.entries(readObject(paths.oauthFile)).map(([id, value]) => [id, String(bag(value).type ?? "")]));
  for (const [id, value] of Object.entries(bag(readObject(paths.modelsJson).providers))) {
    if (typeof bag(value).apiKey === "string" && bag(value).apiKey) kinds.set(id, "api_key");
  }
  return kinds;
}

/** Converts metadata without resolving env/command key expressions. The caller also
 * copies canonical models.json into isolatedAgentDir, preserving its full schema. */
export async function importGlobalPiProviders(paths: FastVibePaths, sourceDir: string): Promise<void> {
  const source = { ...paths, modelsJson: join(sourceDir, "models.json"), oauthFile: join(sourceDir, "auth.json") };
  const providers = readGlobalPiProviders(source);
  const auth = readObject(source.oauthFile);
  // Store expressions as expressions in the credential store, never in the private
  // literal-key overlay. pi evaluates them only when a real request needs auth.
  const entries = bag(readObject(source.modelsJson).providers);
  for (const provider of providers) {
    const expression = bag(entries[provider.id]).apiKey;
    if (typeof expression === "string") auth[provider.id] = { type: "api_key", key: expression };
  }
  writeObject(paths.providersFile, { version: 3, providers });
  mkdirSync(dirname(paths.agentEnv), { recursive: true });
  writeFileSync(paths.agentEnv, "", { mode: 0o600 });
  writeObject(join(paths.isolatedAgentDir, "oauth.json"), { version: 1, credentials: auth });
}
