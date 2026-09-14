import { randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { PROVIDER_APIS, type FastVibeModel, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel } from "@shared/types";
import { enrichModel, loadModelsDev, type ModelsDevIndex } from "./models-dev";
import { findNativeProvider, listNativeProviders, selectedNativeModels } from "./native-providers";
import type { FastVibePaths } from "./paths";

export const FASTVIBE_PROVIDER_ID = "fastvibe";
export const FASTVIBE_API_BASE = "https://fastvibe.dev/v1";
export const FASTVIBE_API_KEY_ENV = "FASTVIBE_API_KEY";

/**
 * `native` entries point at a pi-coding-agent built-in provider: the id is the SDK
 * provider id itself (e.g. `deepseek`) and `models` is the user's chosen subset of
 * the built-in catalog. `baseUrl` / `api` / `name` are derived from the SDK on every
 * read rather than trusted from disk, so an SDK upgrade refreshes them for free.
 */
type StoredProvider = {
  id: string;
  kind: "builtin" | "native" | "custom";
  name: string;
  baseUrl: string;
  api: string;
  apiKeyEnv: string;
  enabled: boolean;
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
  enabled: true,
  models: [],
};

export function providersFilePath(paths: FastVibePaths): string {
  return paths.providersFile;
}

export function readProviders(paths: FastVibePaths): StoredProvider[] {
  try {
    const parsed = JSON.parse(readFileSync(paths.providersFile, "utf8")) as ProvidersFile;
    if (!parsed || !Array.isArray(parsed.providers)) return [normalizeFastVibe(null)];
    return ensureFastVibe(parsed.providers.filter(isStoredProvider).map(hydrateProvider).filter(isLiveProvider));
  } catch {
    // No providers.json yet: FastVibe exists but has no models until the user connects.
    return [normalizeFastVibe(null)];
  }
}

/**
 * Drop native entries whose provider id no longer exists in the SDK catalog — an
 * upgrade can retire a built-in, and a stale entry would otherwise show up as a
 * nameless provider with no models.
 */
function isLiveProvider(provider: StoredProvider): boolean {
  return provider.kind !== "native" || findNativeProvider(provider.id) !== undefined;
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
    enabled: existing?.enabled ?? true,
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
    enabled: provider.enabled,
    models: provider.models,
  }));
}

/** The pi-coding-agent built-ins offered by 添加供应商, with live metadata. */
export function nativeProviderCatalog(): NativeProviderConfig[] {
  return listNativeProviders().map((provider) => ({
    id: provider.id,
    name: provider.name,
    api: provider.api,
    baseUrl: provider.baseUrl,
    models: provider.models,
    supported: provider.supported,
    unsupportedReason: provider.unsupportedReason,
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

/**
 * Model parameters come from the bundled models.dev snapshot — there is no
 * hand-maintained catalog to drift out of sync, and no per-model editing UI.
 * Unknown ids keep models.dev's conservative defaults (128K context / 8K output /
 * text-only) rather than blocking the model.
 */
function enrichOne(index: ModelsDevIndex, id: string, apiName: string): ProviderModel {
  return { ...enrichModel(index, id, apiName || id), thinkingFormat: inferThinkingFormat(id) };
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

/**
 * Materialise the engine's model registry. `models.json` is the only config the
 * pi-coding-agent SDK reads; the YAML/`config.yml` pair the RPC engine used is gone.
 *
 * Providers without a stored key are omitted entirely, so an unconfigured provider
 * contributes no models — which is why a fresh install shows an empty model menu
 * instead of a preloaded catalog.
 *
 * Native providers are excluded from the file on purpose: the SDK already knows
 * their endpoint, api and models, and a `models.json` entry would make it resolve
 * `apiKey` as an env-var name — sending the literal name as the bearer token when
 * that name is not exported. Their credentials go to `AuthStorage` instead.
 */
export function applyProviders(paths: FastVibePaths): FastVibeModel[] {
  const usable = readProviders(paths).filter(
    (provider) => provider.enabled && (provider.kind === "native" || provider.models.length > 0),
  );
  const keys = readProviderKeysSync(paths);
  const connected = usable.filter((provider) => Boolean(keys[provider.apiKeyEnv]));
  const writable = connected.filter((provider) => provider.kind !== "native");
  writeFileSync(paths.modelsJson, renderModelsJson(writable), "utf8");

  // Only connected providers: returning a keyless provider's models here would put
  // them in the composer's menu even though models.json omits them, and selecting
  // one would then fail with "模型不存在".
  return connected.flatMap((provider) =>
    provider.models.map((model) => ({
      provider: provider.id,
      id: model.id,
      name: model.name,
      thinkingLevels: model.thinkingLevels,
    })),
  );
}

function renderModelsJson(providers: StoredProvider[]): string {
  const result: Record<string, unknown> = { providers: {} };
  const output = result.providers as Record<string, unknown>;
  for (const provider of providers) {
    output[provider.id] = {
      name: provider.name,
      baseUrl: provider.baseUrl,
      api: provider.api,
      apiKey: provider.apiKeyEnv,
      authHeader: true,
      models: provider.models.map((model) => ({
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        input: engineInputs(model.input),
      })),
    };
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * Providers that have a stored key and so should reach `AuthStorage`.
 *
 * Native providers are included even though they hold no `models.json` models —
 * their models come from the SDK registry, and requiring a non-empty `models` here
 * would strand them at `needsAuth` no matter what key the user pasted.
 */
export function usableProviders(paths: FastVibePaths, keys: Record<string, string>): StoredProvider[] {
  return readProviders(paths).filter(
    (provider) =>
      provider.enabled &&
      (provider.kind === "native" || provider.models.length > 0) &&
      Boolean(keys[provider.apiKeyEnv]),
  );
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

/**
 * The engine's models.json schema only accepts `text` and `image` modalities, and a
 * single unknown value invalidates the whole file (every custom provider is then
 * dropped from the registry). models.dev also reports `video`/`file`, which we keep
 * in the UI metadata but must not hand to the engine.
 */
function engineInputs(input: string[] | undefined): string[] {
  if (!input) return [];
  return input.filter((item) => item === "text" || item === "image");
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
  draft: { name: string; baseUrl: string; apiKey: string; api?: ProviderApi },
  models: ProviderModel[],
): Promise<string> {
  const providers = readProviders(paths);
  const id = uniqueProviderId(providers, draft.name);
  const apiKeyEnv = nativeKeyEnv(id);
  providers.push({
    id,
    kind: "custom",
    name: draft.name.trim() || id,
    baseUrl: draft.baseUrl.trim().replace(/\/+$/, ""),
    api: draft.api && isProviderApi(draft.api) ? draft.api : "openai-completions",
    apiKeyEnv,
    enabled: true,
    models,
  });
  writeProviders(paths, providers);
  await setProviderKey(paths, apiKeyEnv, draft.apiKey);
  return id;
}

/**
 * Enable a pi-coding-agent built-in provider with a pasted key.
 *
 * Only the key and the chosen models are persisted — name, api and baseUrl are
 * re-read from the SDK on every `readProviders`, and nothing is written to
 * `models.json` (see `applyProviders`).
 */
export async function addNativeProvider(
  paths: FastVibePaths,
  id: string,
  apiKey: string,
  models: ProviderModel[],
): Promise<string> {
  const native = findNativeProvider(id);
  if (!native) throw new Error("该内置供应商不存在");
  if (!native.supported) throw new Error(native.unsupportedReason ?? "该内置供应商暂不支持 API 密钥");

  const providers = readProviders(paths);
  if (providers.some((provider) => provider.id === id)) throw new Error("该内置供应商已添加");

  const apiKeyEnv = nativeKeyEnv(id);
  providers.push({
    id,
    kind: "native",
    name: native.name,
    baseUrl: native.baseUrl,
    api: native.api,
    apiKeyEnv,
    enabled: true,
    // Re-read through the catalog so a stale renderer payload cannot smuggle in
    // models the SDK no longer ships.
    models: selectedNativeModels(
      id,
      models.map((model) => model.id),
    ),
  });
  writeProviders(paths, providers);
  await setProviderKey(paths, apiKeyEnv, apiKey);
  return id;
}

export function updateProvider(
  paths: FastVibePaths,
  id: string,
  patch: Partial<Pick<StoredProvider, "name" | "baseUrl" | "api" | "enabled" | "models">>,
): void {
  const providers = readProviders(paths);
  const index = providers.findIndex((provider) => provider.id === id);
  if (index < 0) return;
  const current = providers[index];
  const next = { ...current, ...patch };
  if (id === FASTVIBE_PROVIDER_ID) {
    next.name = FASTVIBE_DEFAULT.name;
    next.baseUrl = FASTVIBE_DEFAULT.baseUrl;
    next.api = FASTVIBE_DEFAULT.api;
  }
  if (current.kind === "native") {
    // Identity and endpoint stay pinned to the SDK; only enablement and the
    // selected model subset are user-editable.
    next.name = current.name;
    next.baseUrl = current.baseUrl;
    next.api = current.api;
    next.models = selectedNativeModels(
      id,
      (patch.models ?? current.models).map((model) => model.id),
    );
  }
  providers[index] = next;
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

/**
 * Refresh a provider's model list. Custom providers re-fetch `/models` with their
 * stored key; native providers re-read the SDK catalog (no request, no key needed).
 */
export async function refreshProviderModels(
  paths: FastVibePaths,
  id: string,
): Promise<ProviderModel[]> {
  const provider = readProviders(paths).find((item) => item.id === id);
  if (!provider) throw new Error("供应商不存在");
  if (provider.kind === "native") return findNativeProvider(id)?.models ?? [];
  const keys = await loadProviderKeys(paths);
  return fetchProviderModels(provider.baseUrl, keys[provider.apiKeyEnv] ?? "");
}

/* ---------------- helpers ---------------- */

function hydrateProvider(value: StoredProvider): StoredProvider {
  const kind: StoredProvider["kind"] =
    value.kind === "native" || value.kind === "builtin" ? value.kind : "custom";

  if (kind === "native") {
    // The SDK is the source of truth for a native provider's identity and endpoint.
    const native = findNativeProvider(value.id);
    if (!native) return { ...value, kind, enabled: value.enabled !== false };
    // Intersect with the catalog: an SDK upgrade can retire a model, and a stale
    // selection would otherwise surface in the composer and then fail to resolve.
    const live = new Set(native.models.map((model) => model.id));
    return {
      ...value,
      kind,
      name: native.name,
      baseUrl: native.baseUrl,
      api: native.api,
      enabled: value.enabled !== false,
      models: value.models.filter((model) => live.has(model.id)),
    };
  }

  return {
    ...value,
    kind,
    api: isProviderApi(value.api) ? value.api : "openai-completions",
    enabled: value.enabled !== false,
  };
}

export function nativeKeyEnv(id: string): string {
  return `FASTVIBE_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

function isProviderApi(value: unknown): value is ProviderApi {
  return typeof value === "string" && (PROVIDER_APIS as readonly string[]).includes(value);
}

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
