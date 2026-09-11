import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import type { FastVibeModel, ProviderConfig, ProviderModel } from "@shared/types";
import { lookupBuiltinModel, pickDefaultModelId, toValidEfforts } from "./model-catalog";
import { enrichModel, loadModelsDev, type ModelsDevIndex } from "./models-dev";
import type { FastVibePaths } from "./paths";

export const FASTVIBE_PROVIDER_ID = "fastvibe";
export const FASTVIBE_API_BASE = "https://fastvibe.dev/v1";
export const FASTVIBE_API_KEY_ENV = "FASTVIBE_API_KEY";

type StoredProvider = {
  id: string;
  kind: "builtin" | "custom";
  name: string;
  baseUrl: string;
  api: "openai-completions";
  apiKeyEnv: string;
  models: ProviderModel[];
};

type ProvidersFile = {
  version: 1;
  providers: StoredProvider[];
};

const FASTVIBE_DEFAULT: StoredProvider = {
  id: FASTVIBE_PROVIDER_ID,
  kind: "builtin",
  name: "FastVibe",
  baseUrl: FASTVIBE_API_BASE,
  api: "openai-completions",
  apiKeyEnv: FASTVIBE_API_KEY_ENV,
  models: [],
};

export function providersFilePath(paths: FastVibePaths): string {
  return paths.providersFile;
}

export function readProviders(paths: FastVibePaths): StoredProvider[] {
  try {
    const parsed = JSON.parse(readFileSync(paths.providersFile, "utf8")) as ProvidersFile;
    if (!parsed || !Array.isArray(parsed.providers)) return [normalizeFastVibe(null)];
    const list = parsed.providers.filter(isStoredProvider);
    return ensureFastVibe(list);
  } catch {
    const migrated = migrateLegacy(paths);
    return migrated ?? [normalizeFastVibe(null)];
  }
}

/**
 * Older builds wrote a single fastvibe provider straight into models.yml.
 * If providers.json is missing but that config exists, seed the new store from it
 * so users are not forced to reconnect.
 */
function migrateLegacy(paths: FastVibePaths): StoredProvider[] | null {
  if (existsSync(paths.providersFile)) return null;
  try {
    if (!existsSync(paths.modelsYml)) return null;
    const keys = readProviderKeysSync(paths);
    if (!keys[FASTVIBE_API_KEY_ENV]) return null;
    const ids = parseModelIds(readFileSync(paths.modelsYml, "utf8"));
    if (ids.length === 0) return null;
    const models: ProviderModel[] = ids.map((id) => {
      const builtin = lookupBuiltinModel(id);
      if (builtin) {
        return {
          id,
          name: builtin.name,
          contextWindow: builtin.contextWindow,
          maxTokens: builtin.maxTokens,
          reasoning: builtin.reasoning,
          input: builtin.input,
          thinkingLevels: builtin.thinkingLevels,
          thinkingFormat: builtin.thinkingFormat,
          source: "builtin",
        };
      }
      return {
        id,
        name: id,
        contextWindow: 128_000,
        maxTokens: 8192,
        reasoning: false,
        input: ["text"],
        source: "default",
      };
    });
    const providers = [normalizeFastVibe({ ...FASTVIBE_DEFAULT, models })];
    try {
      writeProviders(paths, providers);
    } catch {
      // migration is best-effort
    }
    return providers;
  } catch {
    return null;
  }
}

function parseModelIds(yml: string): string[] {
  const ids: string[] = [];
  let inFastVibe = false;
  for (const raw of yml.split("\n")) {
    const line = raw.replace(/\s+$/, "");
    if (/^  [A-Za-z0-9_.:-]+:$/.test(line)) {
      inFastVibe = line.trim() === `${FASTVIBE_PROVIDER_ID}:`;
      continue;
    }
    if (!inFastVibe) continue;
    const match = /^\s+- id:\s*(.+)$/.exec(line);
    if (match) ids.push(unquote(match[1].trim()));
  }
  return ids;
}

function writeProviders(paths: FastVibePaths, providers: StoredProvider[]): void {
  const payload: ProvidersFile = { version: 1, providers };
  writeFileSync(paths.providersFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function ensureFastVibe(list: StoredProvider[]): StoredProvider[] {
  const existing = list.find((item) => item.id === FASTVIBE_PROVIDER_ID);
  const fastvibe = normalizeFastVibe(existing ?? null);
  const others = list.filter((item) => item.id !== FASTVIBE_PROVIDER_ID);
  return [fastvibe, ...others];
}

function normalizeFastVibe(existing: StoredProvider | null): StoredProvider {
  return {
    ...FASTVIBE_DEFAULT,
    models: existing?.models ?? [],
  };
}

export async function loadProviderKeys(paths: FastVibePaths): Promise<Record<string, string>> {
  const keys: Record<string, string> = {};
  try {
    const text = await readFile(paths.agentEnv, "utf8");
    for (const line of text.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (!match) continue;
      const value = unquote(match[2].trim());
      if (value) keys[match[1]] = value;
    }
  } catch {
    // no keys yet
  }
  return keys;
}

async function writeProviderKeys(paths: FastVibePaths, keys: Record<string, string>): Promise<void> {
  const body = Object.entries(keys)
    .filter(([, value]) => value)
    .map(([name, value]) => `${name}=${value}`)
    .join("\n");
  await writeFile(paths.agentEnv, body ? `${body}\n` : "", { mode: 0o600 });
  await chmod(paths.agentEnv, 0o600);
}

export async function setProviderKey(
  paths: FastVibePaths,
  apiKeyEnv: string,
  apiKey: string,
): Promise<void> {
  const keys = await loadProviderKeys(paths);
  if (apiKey.trim()) keys[apiKeyEnv] = apiKey.trim();
  else delete keys[apiKeyEnv];
  await writeProviderKeys(paths, keys);
}

export function listProviderConfigs(
  paths: FastVibePaths,
  keys: Record<string, string>,
): ProviderConfig[] {
  return readProviders(paths).map((provider) => ({
    id: provider.id,
    kind: provider.kind,
    name: provider.name,
    baseUrl: provider.baseUrl,
    api: provider.api,
    apiKeyEnv: provider.apiKeyEnv,
    hasKey: Boolean(keys[provider.apiKeyEnv]),
    models: provider.models,
  }));
}

/** Fetch the provider's full model list and enrich each with models.dev metadata. */
export async function fetchProviderModels(
  baseUrl: string,
  apiKey: string,
): Promise<ProviderModel[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("Base URL 需以 http(s):// 开头");

  let response: Response;
  try {
    response = await fetch(`${base}/models`, {
      headers: { Authorization: `Bearer ${apiKey}`, "x-api-key": apiKey },
      signal: AbortSignal.timeout(20_000),
    });
  } catch {
    throw new Error("无法连接该供应商，请检查 Base URL");
  }
  if (response.status === 401 || response.status === 403) throw new Error("密钥无效或无权访问");
  if (!response.ok) throw new Error(`拉取模型失败（${response.status}）`);

  const payload: unknown = await response.json();
  const raw = extractModelList(payload);
  if (raw.length === 0) throw new Error("没有返回任何模型");

  const index = loadModelsDev();
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry : isRecord(entry) ? String(entry.id ?? entry.model ?? "") : "";
    if (!id || seen.has(id)) continue;
    seen.add(id);
    const apiName = isRecord(entry) ? String(entry.name ?? entry.display_name ?? "") : "";
    models.push(enrichOne(index, id, apiName));
  }
  return models;
}

function enrichOne(index: ModelsDevIndex, id: string, apiName: string): ProviderModel {
  const builtin = lookupBuiltinModel(id);
  if (builtin) {
    return {
      id,
      name: apiName || builtin.name,
      contextWindow: builtin.contextWindow,
      maxTokens: builtin.maxTokens,
      reasoning: builtin.reasoning,
      input: builtin.input,
      thinkingLevels: builtin.thinkingLevels,
      thinkingFormat: builtin.thinkingFormat,
      source: "builtin",
    };
  }
  const meta = enrichModel(index, id, apiName || id);
  return { ...meta, thinkingFormat: inferThinkingFormat(id) };
}

function inferThinkingFormat(id: string): ProviderModel["thinkingFormat"] {
  return /glm|zai|z-ai/i.test(id) ? "zai" : "openai";
}

function extractModelList(payload: unknown): unknown[] {
  if (Array.isArray(payload)) return payload;
  if (isRecord(payload) && Array.isArray(payload.data)) return payload.data;
  if (isRecord(payload) && Array.isArray(payload.models)) return payload.models;
  return [];
}

/** Write models.yml + config.yml from the stored provider selection. */
export function applyProviders(paths: FastVibePaths): {
  models: FastVibeModel[];
  defaultModel?: string;
} {
  const providers = readProviders(paths);
  const usable = providers.filter((provider) => provider.models.length > 0);
  const keys = readProviderKeysSync(paths);
  writeFileSync(paths.modelsYml, renderModelsYml(usable, keys), "utf8");

  const allIds = usable.flatMap((provider) => provider.models.map((model) => model.id));
  const defaultId = allIds.length > 0 ? pickDefaultModelId(allIds) : undefined;
  const defaultProvider =
    usable.find((provider) => provider.models.some((model) => model.id === defaultId)) ?? usable[0];
  if (defaultProvider && defaultId) {
    writeFileSync(
      paths.configYml,
      `modelRoles:\n  default: ${defaultProvider.id}/${defaultId}\n`,
      "utf8",
    );
  }

  return {
    defaultModel: defaultId,
    models: usable.flatMap((provider) =>
      provider.models.map((model) => ({
        provider: provider.id,
        id: model.id,
        name: model.name,
        thinkingLevels: model.thinkingLevels,
      })),
    ),
  };
}

/** Providers that have at least one model and, when required, a stored key. */
export function usableProviders(paths: FastVibePaths, keys: Record<string, string>): StoredProvider[] {
  return readProviders(paths).filter(
    (provider) => provider.models.length > 0 && Boolean(keys[provider.apiKeyEnv]),
  );
}

export function renderModelsYml(providers: StoredProvider[], keys: Record<string, string> = {}): string {
  const lines = ["providers:"];
  for (const provider of providers) {
    const hasKey = Boolean(provider.apiKeyEnv && keys[provider.apiKeyEnv]);
    lines.push(`  ${yamlScalar(provider.id)}:`);
    lines.push(`    baseUrl: ${yamlScalar(provider.baseUrl)}`);
    lines.push(`    api: ${provider.api}`);
    if (hasKey) {
      lines.push(`    apiKey: ${provider.apiKeyEnv}`);
      lines.push("    authHeader: true");
    } else {
      lines.push("    auth: none");
    }
    lines.push("    models:");
    for (const model of provider.models) {
      lines.push(`      - id: ${yamlScalar(model.id)}`);
      lines.push(`        name: ${yamlScalar(model.name)}`);
      lines.push(`        contextWindow: ${model.contextWindow}`);
      lines.push(`        maxTokens: ${model.maxTokens}`);
      lines.push(`        reasoning: ${model.reasoning}`);
      const input = yamlInputs(model.input);
      if (input.length > 0) lines.push(`        input: [${input.join(", ")}]`);
      const efforts = toValidEfforts(model.thinkingLevels);
      if (efforts.length > 0) {
        lines.push("        thinking:");
        lines.push("          mode: effort");
        lines.push(`          efforts: [${efforts.join(", ")}]`);
      }
      if (model.thinkingFormat) lines.push(`        thinkingFormat: ${model.thinkingFormat}`);
    }
  }
  return `${lines.join("\n")}\n`;
}

function readProviderKeysSync(paths: FastVibePaths): Record<string, string> {
  try {
    const text = readFileSync(paths.agentEnv, "utf8");
    const keys: Record<string, string> = {};
    for (const line of text.split("\n")) {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line.trim());
      if (match && unquote(match[2].trim())) keys[match[1]] = unquote(match[2].trim());
    }
    return keys;
  } catch {
    return {};
  }
}

function yamlInputs(input: string[] | undefined): string[] {
  if (!input) return [];
  return input.filter((item) => item === "text" || item === "image");
}

function yamlScalar(value: string): string {
  return /^[A-Za-z0-9_./:+-]+$/.test(value) ? value : JSON.stringify(value);
}

/* ---------------- mutations ---------------- */

export async function saveFastVibe(
  paths: FastVibePaths,
  apiKey: string,
  models: ProviderModel[],
): Promise<void> {
  await setProviderKey(paths, FASTVIBE_API_KEY_ENV, apiKey);
  updateProvider(paths, FASTVIBE_PROVIDER_ID, { models });
}

export async function addProvider(
  paths: FastVibePaths,
  draft: { name: string; baseUrl: string; apiKey: string },
  models: ProviderModel[],
): Promise<string> {
  const providers = readProviders(paths);
  const id = uniqueProviderId(providers, draft.name);
  const apiKeyEnv = `FASTVIBE_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
  providers.push({
    id,
    kind: "custom",
    name: draft.name.trim() || id,
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    api: "openai-completions",
    apiKeyEnv,
    models,
  });
  writeProviders(paths, providers);
  await setProviderKey(paths, apiKeyEnv, draft.apiKey);
  return id;
}

export function updateProvider(
  paths: FastVibePaths,
  id: string,
  patch: Partial<Pick<StoredProvider, "name" | "baseUrl" | "models">>,
): void {
  const providers = readProviders(paths);
  const index = providers.findIndex((provider) => provider.id === id);
  if (index < 0) return;
  providers[index] = { ...providers[index], ...patch };
  writeProviders(paths, providers);
}

export function removeProvider(paths: FastVibePaths, id: string): void {
  if (id === FASTVIBE_PROVIDER_ID) return;
  const providers = readProviders(paths).filter((provider) => provider.id !== id);
  writeProviders(paths, providers);
}

function uniqueProviderId(providers: StoredProvider[], name: string): string {
  const slug = name.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "provider";
  let id = `custom-${slug}`;
  while (providers.some((provider) => provider.id === id)) id = `custom-${slug}-${randomUUID().slice(0, 4)}`;
  return id;
}

export function providerKeyEnv(paths: FastVibePaths, id: string): string | undefined {
  return readProviders(paths).find((provider) => provider.id === id)?.apiKeyEnv;
}

/** Re-fetch a provider's model list using its stored key. */
export async function refreshProviderModels(
  paths: FastVibePaths,
  id: string,
): Promise<ProviderModel[]> {
  const provider = readProviders(paths).find((item) => item.id === id);
  if (!provider) throw new Error("供应商不存在");
  const keys = await loadProviderKeys(paths);
  return fetchProviderModels(provider.baseUrl, keys[provider.apiKeyEnv] ?? "");
}

/* ---------------- helpers ---------------- */

function isStoredProvider(value: unknown): value is StoredProvider {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.baseUrl === "string" &&
    typeof value.apiKeyEnv === "string" &&
    Array.isArray(value.models)
  );
}

function unquote(value: string): string {
  if (
    (value.startsWith('"') && value.endsWith('"')) ||
    (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1);
  }
  return value;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
