import { createHash, randomUUID } from "node:crypto";
import { chmod, readFile, writeFile } from "node:fs/promises";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { INPUT_MODALITIES, PROVIDER_APIS, THINKING_EFFORT_LEVELS, type CostTier, type FastVibeModel, type ModelCost, type ModelPrice, type NativeProviderConfig, type ProviderApi, type ProviderConfig, type ProviderModel, type ThinkingLevel } from "@shared/types";
import { catalogPrice, enrichModel, loadModelsDev, type ModelsDevIndex } from "./models-dev";
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
  version: number;
  providers: StoredProvider[];
};

/**
 * On-disk schema version. 2 made the builtin provider's protocol user-selectable — in
 * v1 the code pinned it, so a v1 entry's `api` is the old default rather than a choice
 * and is migrated to the current one (see `normalizeFastVibe`).
 */
const PROVIDERS_VERSION = 2;

const COST_KEYS: Array<keyof ModelCost> = ["input", "output", "cacheRead", "cacheWrite"];

/**
 * The FastVibe gateway speaks the OpenAI Responses API by default. Models that only
 * exist behind `/chat/completions` (or a different protocol entirely) carry their own
 * `ProviderModel.api`, which overrides this per model in `models.json`.
 */
const FASTVIBE_DEFAULT: StoredProvider = {
  id: FASTVIBE_PROVIDER_ID,
  kind: "builtin",
  name: "FastVibe",
  baseUrl: FASTVIBE_API_BASE,
  api: "openai-responses",
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
    const legacy = !(typeof parsed.version === "number" && parsed.version >= PROVIDERS_VERSION);
    return ensureFastVibe(
      parsed.providers.filter(isStoredProvider).map(hydrateProvider).filter(isLiveProvider),
      legacy,
    );
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
  const payload: ProvidersFile = {
    version: PROVIDERS_VERSION,
    providers: providers.map((provider) => ({ ...provider, models: hydrateModels(provider.models) })),
  };
  writeFileSync(paths.providersFile, `${JSON.stringify(payload, null, 2)}\n`);
}

function ensureFastVibe(list: StoredProvider[], legacy: boolean): StoredProvider[] {
  const existing = list.find((item) => item.id === FASTVIBE_PROVIDER_ID);
  const fastvibe = normalizeFastVibe(existing ?? null, legacy);
  const others = list.filter((item) => item.id !== FASTVIBE_PROVIDER_ID);
  return [fastvibe, ...others];
}

/**
 * The builtin provider keeps the user's choice of protocol, but its identity and
 * endpoint are code-owned. `legacy` marks a file written before the protocol was
 * selectable, where the stored `api` was the code's default and not a decision.
 */
function normalizeFastVibe(existing: StoredProvider | null, legacy = false): StoredProvider {
  return {
    ...FASTVIBE_DEFAULT,
    api: !legacy && isProviderApi(existing?.api) ? existing.api : FASTVIBE_DEFAULT.api,
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
  api?: string,
): Promise<ProviderModel[]> {
  const base = baseUrl.trim().replace(/\/+$/, "");
  if (!/^https?:\/\//.test(base)) throw new Error("Base URL 需以 http(s):// 开头");

  const listed = api === "google-generative-ai"
    ? await fetchGeminiModels(base, apiKey)
    : await fetchOpenAiStyleModels(base, apiKey);
  if (listed.length === 0) throw new Error("没有返回任何模型");

  const index = loadModelsDev();
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const entry of listed) {
    if (!entry.id || seen.has(entry.id)) continue;
    seen.add(entry.id);
    models.push(enrichOne(index, entry.id, entry.name));
  }
  return models;
}

type ListedModel = { id: string; name: string };

async function fetchOpenAiStyleModels(base: string, apiKey: string): Promise<ListedModel[]> {
  return listedFromUnknown(await getJson(`${base}/models`, {
    Authorization: `Bearer ${apiKey}`,
    "x-api-key": apiKey,
  }));
}

/**
 * Gemini's list is `GET /v1beta/models?key=` with `{ models: [{ name: "models/gemini-…" }] }`,
 * not OpenAI's `{ data: [{ id }] }`. Auth is `x-goog-api-key` / `?key=`; Bearer is sent too
 * because some native-protocol relays only accept it.
 */
async function fetchGeminiModels(base: string, apiKey: string): Promise<ListedModel[]> {
  const headers = {
    "x-goog-api-key": apiKey,
    Authorization: `Bearer ${apiKey}`,
  };
  const collected: ListedModel[] = [];
  let pageToken = "";
  for (let page = 0; page < 20; page++) {
    const url = new URL(`${base}/models`);
    url.searchParams.set("key", apiKey);
    url.searchParams.set("pageSize", "100");
    if (pageToken) url.searchParams.set("pageToken", pageToken);
    const payload = await getJson(url.toString(), headers);
    const batch = listedFromGemini(payload);
    // A relay that chats Gemini-native but lists models OpenAI-style: empty Gemini parse,
    // then the generic extractor, stripping the `models/` prefix either way.
    if (batch.length === 0 && page === 0) {
      const fallback = listedFromUnknown(payload).map((item) => ({
        ...item,
        id: stripGeminiModelPrefix(item.id),
      }));
      if (fallback.length > 0) return fallback;
    }
    collected.push(...batch);
    pageToken = isRecord(payload) && typeof payload.nextPageToken === "string" ? payload.nextPageToken : "";
    if (!pageToken) break;
  }
  return collected;
}

async function getJson(url: string, headers: Record<string, string>): Promise<unknown> {
  let response: Response;
  try {
    response = await fetch(url, { headers, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new Error("无法连接该供应商，请检查 Base URL");
  }
  if (response.status === 401 || response.status === 403) throw new Error("密钥无效或无权访问");
  if (!response.ok) throw new Error(`拉取模型失败（${response.status}）`);
  return response.json();
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

function listedFromGemini(payload: unknown): ListedModel[] {
  const models = isRecord(payload) && Array.isArray(payload.models) ? payload.models : [];
  const out: ListedModel[] = [];
  for (const entry of models) {
    if (!isRecord(entry)) continue;
    const methods = Array.isArray(entry.supportedGenerationMethods) ? entry.supportedGenerationMethods : null;
    // Proxies often omit the field; only skip when it is present and not a chat model.
    if (methods && !methods.includes("generateContent")) continue;
    const id = stripGeminiModelPrefix(String(entry.name ?? entry.id ?? ""));
    if (!id) continue;
    out.push({ id, name: String(entry.displayName ?? entry.display_name ?? "") });
  }
  return out;
}

function listedFromUnknown(payload: unknown): ListedModel[] {
  const raw = extractModelList(payload);
  const out: ListedModel[] = [];
  for (const entry of raw) {
    const id = typeof entry === "string" ? entry : isRecord(entry) ? String(entry.id ?? entry.model ?? "") : "";
    if (!id) continue;
    const name = isRecord(entry) ? String(entry.name ?? entry.display_name ?? "") : "";
    out.push({ id, name });
  }
  return out;
}

function stripGeminiModelPrefix(id: string): string {
  return id.replace(/^models\//, "");
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
 * that name is not exported. Their credentials go to the engine credential overlay instead.
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
      providerName: provider.name,
      id: model.id,
      name: model.name,
      thinkingLevels: model.thinkingLevels,
    })),
  );
}

/**
 * Compatibility pins for one model, derived from the api it will actually be
 * streamed with. Model level rather than provider level on purpose: a provider whose
 * models are split across protocols (FastVibe's Responses default plus a few
 * `/chat/completions` models) would otherwise leak the chat-completions pin onto its
 * siblings, and `parseModels` merges model compat over provider compat anyway.
 *
 * Every provider written here is an OpenAI-compatible endpoint behind a base URL the
 * SDK does not recognise, so pi-ai cannot tell whether the upstream accepts the
 * OpenAI `developer` role that replaced `system`. Unknown URLs default to
 * `supportsDeveloperRole: true`, which silently 400s on upstreams that only speak
 * `system` (e.g. Qwen via the FastVibe gateway). `system` is accepted everywhere, so
 * pin it for chat-completions models instead of risking an opaque 400. The Responses
 * API sends the system prompt as `instructions` and ignores the pin.
 */
function modelCompat(api: string, model: ProviderModel): Record<string, unknown> | undefined {
  if (api !== "openai-completions") return undefined;
  const compat: Record<string, unknown> = { supportsDeveloperRole: false };
  // GLM/Z.AI upstreams take a top-level `enable_thinking` instead of
  // `reasoning_effort`; unknown gateways are never auto-detected as `zai`.
  if (model.thinkingFormat === "zai") compat.thinkingFormat = "zai";
  return compat;
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
      // Gemini authenticates with `x-goog-api-key` via the SDK client, not Bearer.
      authHeader: provider.api !== "google-generative-ai",
      models: provider.models.map((model) => {
        const compat = modelCompat(model.api ?? provider.api, model);
        const thinking = thinkingLevelMap(model);
        return {
          id: model.id,
          name: model.name,
          contextWindow: model.contextWindow,
          maxTokens: model.maxTokens,
          reasoning: model.reasoning,
          input: engineInputs(model.input),
          // Omitted when the model inherits the provider's api, which keeps
          // `models.json` a faithful mirror of what the user configured.
          ...(model.api ? { api: model.api } : {}),
          ...(compat ? { compat } : {}),
          ...(thinking ? { thinkingLevelMap: thinking } : {}),
          // Only real prices: the engine's own default is all zeros, so writing the
          // same zeros back would just bloat the file.
          ...(model.cost ? { cost: model.cost } : {}),
        };
      }),
    };
  }
  return `${JSON.stringify(result, null, 2)}\n`;
}

/**
 * pi's `thinkingLevelMap` for one model: an effort the user unchecked is mapped to
 * `null` (unsupported), so the engine clamps a request for it instead of sending a
 * parameter the upstream rejects. `off` is never mapped — see `THINKING_EFFORT_LEVELS`,
 * and note that FastVibe never requests it at all.
 * A level whose provider name differs keeps its provider value. `xhigh` and `max` are
 * special: pi offers either only when the model maps it, so a checked one must carry a
 * mapping, and an unchecked one is written as `null` like everything else.
 */
function thinkingLevelMap(model: ProviderModel): Record<string, string | null> | undefined {
  if (!model.reasoning || !model.thinkingLevels) return undefined;
  const allowed = new Set<ThinkingLevel>(model.thinkingLevels);
  const map: Record<string, string | null> = {};
  for (const level of THINKING_EFFORT_LEVELS) {
    if (!allowed.has(level)) {
      map[level] = null;
      continue;
    }
    const providerValue = model.effortMap?.[level] ?? (level === "xhigh" || level === "max" ? level : undefined);
    if (providerValue) map[level] = providerValue;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * Providers that have a stored key and so should reach the engine credential overlay.
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
  const id = uniqueProviderId(providers, draft.name, draft.baseUrl);
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
  // IPC callers build the whole patch object (`{ name, baseUrl, api, enabled, models }`),
  // so the keys they did not touch arrive present but `undefined`. Spreading those in
  // verbatim blanks the field, and `JSON.stringify` then drops the key from the file
  // entirely — a rename would erase `baseUrl`/`models` and the provider would fail
  // validation on the next read and disappear. Only defined values may win.
  const next = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) (next as Record<string, unknown>)[key] = value;
  }
  if (id === FASTVIBE_PROVIDER_ID) {
    // Identity and endpoint stay code-owned; the protocol is the user's to pick.
    next.name = FASTVIBE_DEFAULT.name;
    next.baseUrl = FASTVIBE_DEFAULT.baseUrl;
    if (!isProviderApi(next.api)) next.api = FASTVIBE_DEFAULT.api;
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

export async function removeProvider(paths: FastVibePaths, id: string): Promise<void> {
  if (id === FASTVIBE_PROVIDER_ID) return;
  const providers = readProviders(paths);
  const removed = providers.find((provider) => provider.id === id);
  if (!removed) return;
  writeProviders(paths, providers.filter((provider) => provider.id !== id));
  // The credential lives in its own env file, so dropping the entry would otherwise
  // strand `FASTVIBE_KEY_…` there forever.
  await setProviderKey(paths, removed.apiKeyEnv, "");
}

function uniqueProviderId(providers: StoredProvider[], name: string, baseUrl: string): string {
  // Minted once, at creation, and then it is the provider's identity for good: the id
  // namespaces `models.json`, becomes the credential's env-var segment (`nativeKeyEnv`),
  // and is what every turn writes into the transcript — the SDK restores a conversation's
  // model by looking up `getModel(message.provider, message.model)` from it. So it has to
  // be ASCII, readable, and stable.
  //
  // The name is the best source when it has ASCII (`Packy` → `custom-packy`), but a name
  // is not required to have any — a Chinese provider name slugged to the empty string and
  // fell back to the literal `provider`, leaving such a provider called `custom-provider`
  // in the transcript and, once that leaked into 使用统计, a row labelled 「provider」.
  // Fall back to the endpoint's host next (that is the provider's real, stable identity),
  // and to a hash of the name only when neither yields anything usable.
  const slug =
    slugify(name) ||
    slugify(hostLabel(baseUrl)) ||
    createHash("sha1").update(name.trim()).digest("hex").slice(0, 6);
  let id = `custom-${slug}`;
  while (providers.some((provider) => provider.id === id)) id = `custom-${slug}-${randomUUID().slice(0, 4)}`;
  return id;
}

/** ASCII, env-safe segment: `My Gateway` → `my-gateway`. */
function slugify(value: string): string {
  return value.trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
}

/**
 * The operator's name as read off an endpoint: `cihai.wujie-ops.com` → `cihai`.
 * Generic service prefixes are skipped so `api.openai.com` names the company rather than
 * the subdomain, and the shape of the host is only a guess anyway — this is a readable
 * id, not a verified brand name.
 */
function hostLabel(baseUrl: string): string {
  const generic = new Set(["api", "www", "gateway", "gw", "llm", "chat", "proxy", "v1"]);
  const trimmed = baseUrl.trim();
  if (!trimmed) return "";
  try {
    const url = new URL(/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`);
    return url.hostname.split(".").find((label) => label && !generic.has(label)) ?? "";
  } catch {
    return "";
  }
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
  return fetchProviderModels(provider.baseUrl, keys[provider.apiKeyEnv] ?? "", provider.api);
}

/* ---------------- helpers ---------------- */

/** What a stored entry may look like on disk: only the id is guaranteed. */
type StoredProviderInput = Partial<StoredProvider> & { id: string };

function hydrateProvider(value: StoredProviderInput): StoredProvider {
  const kind: StoredProvider["kind"] =
    value.kind === "native" || value.kind === "builtin" ? value.kind : "custom";
  // Every field is repaired rather than trusted: a partially written entry must stay
  // visible (and repairable) instead of being filtered out and silently lost.
  const base: StoredProvider = {
    id: value.id,
    kind,
    name: typeof value.name === "string" && value.name.trim() ? value.name : value.id,
    baseUrl: typeof value.baseUrl === "string" ? value.baseUrl : "",
    api: isProviderApi(value.api) ? value.api : "openai-completions",
    apiKeyEnv:
      typeof value.apiKeyEnv === "string" && value.apiKeyEnv ? value.apiKeyEnv : nativeKeyEnv(value.id),
    enabled: value.enabled !== false,
    models: hydrateModels(value.models),
  };

  if (kind === "native") {
    // The SDK is the source of truth for a native provider's identity and endpoint.
    const native = findNativeProvider(value.id);
    if (!native) return base;
    // Intersect with the catalog: an SDK upgrade can retire a model, and a stale
    // selection would otherwise surface in the composer and then fail to resolve.
    const live = new Set(native.models.map((model) => model.id));
    return {
      ...base,
      name: native.name,
      baseUrl: native.baseUrl,
      api: native.api,
      models: base.models.filter((model) => live.has(model.id)),
    };
  }

  return base;
}

export function nativeKeyEnv(id: string): string {
  return `FASTVIBE_KEY_${id.toUpperCase().replace(/[^A-Z0-9]/g, "_")}`;
}

/**
 * Repair a stored model list. Everything but the override fields is passed through — a
 * model that lost metadata is still usable — while a value the engine would reject is
 * dropped so the model falls back to its provider's defaults instead of invalidating
 * `models.json` (one bad value makes the SDK discard every custom provider).
 */
function hydrateModels(value: unknown): ProviderModel[] {
  if (!Array.isArray(value)) return [];
  const models: ProviderModel[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const id = entry.id;
    if (typeof id !== "string" || !id) continue;
    const { api, cost, costTiers, effortMap, thinkingLevels, input, ...rest } = entry;
    const model = rest as unknown as ProviderModel;
    // `features` was dropped from the model record; a legacy entry still carries it, and
    // deleting it here keeps the next write from copying a dead field forward.
    delete (model as unknown as Record<string, unknown>).features;
    if (isProviderApi(api)) model.api = api;
    // A stored price is kept — native providers carry the SDK's richer list — but a
    // model persisted before pricing existed (the snapshot's v2 fields) has none, and
    // without one `models.json` hands the engine an all-zero price, which is why
    // `usage.cost` in every transcript came back as $0. Prices are not editable, so
    // back-filling from the bundled catalog is what makes 费用/统计 add up.
    const stored = isModelCost(cost) ? { cost, costTiers: hydrateCostTiers(costTiers) } : catalogPrice(id);
    model.cost = stored?.cost;
    // The ladder rides alongside the flat price the engine reads: pi cannot bill a
    // long-context step itself, so FastVibe picks the tier when it reports money.
    model.costTiers = stored?.costTiers;
    model.thinkingLevels = hydrateThinkingLevels(thinkingLevels);
    model.effortMap = hydrateEffortMap(effortMap);
    model.input = INPUT_MODALITIES.filter((item) => Array.isArray(input) && input.includes(item));
    if (model.input.length === 0) model.input = ["text"];
    // A marker, not a payload: only `true` is meaningful.
    if (model.edited !== true) delete model.edited;
    models.push(model);
  }
  return models;
}

/**
 * A stored level list is intersected with the tunable levels, in the engine's order:
 * a level this build cannot express must not reach the effort menu, and the menu
 * renders in list order.
 */
function hydrateThinkingLevels(value: unknown): ThinkingLevel[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const levels = THINKING_EFFORT_LEVELS.filter((level) => value.includes(level));
  return levels.length > 0 ? levels : undefined;
}

function hydrateEffortMap(value: unknown): ProviderModel["effortMap"] {
  if (!isRecord(value)) return undefined;
  const map: NonNullable<ProviderModel["effortMap"]> = {};
  for (const level of THINKING_EFFORT_LEVELS) {
    const providerValue = value[level];
    if (typeof providerValue === "string" && providerValue) map[level] = providerValue;
  }
  return Object.keys(map).length > 0 ? map : undefined;
}

/**
 * A stored ladder, repaired per row. A row the engine could not use is dropped rather
 * than rejecting the whole price: the entry tier still bills a run, and one malformed
 * step must not silently price every long request at $0.
 */
function hydrateCostTiers(value: unknown): CostTier[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tiers: CostTier[] = [];
  for (const entry of value) {
    if (!isRecord(entry)) continue;
    const over = entry.over;
    const cost = entry.cost;
    if (typeof over !== "number" || !Number.isFinite(over) || over <= 0) continue;
    if (!isModelCost(cost)) continue;
    tiers.push({ over, cost });
  }
  return tiers.length > 0 ? tiers.sort((a, b) => a.over - b.over) : undefined;
}

function isModelCost(value: unknown): value is ModelCost {
  if (!isRecord(value)) return false;
  return COST_KEYS.every((key) => {
    const price = value[key];
    return typeof price === "number" && Number.isFinite(price) && price >= 0;
  });
}

/**
 * Every configured model's price, keyed `provider/model` and then by bare model id.
 * Both keys because a transcript records the model id verbatim while the provider that
 * served it may have been renamed or removed before the report is read.
 */
export function modelPriceIndex(paths: FastVibePaths): Map<string, ModelPrice> {
  const index = new Map<string, ModelPrice>();
  for (const provider of readProviders(paths)) {
    for (const model of provider.models) {
      const price: ModelPrice = { cost: model.cost, costTiers: model.costTiers };
      index.set(`${provider.id}/${model.id}`, price);
      if (!index.has(model.id)) index.set(model.id, price);
    }
  }
  return index;
}

function isProviderApi(value: unknown): value is ProviderApi {
  return typeof value === "string" && (PROVIDER_APIS as readonly string[]).includes(value);
}

function isStoredProvider(value: unknown): value is StoredProviderInput {
  // An id is the only thing a stored entry must have; everything else is repaired by
  // `hydrateProvider`, so a provider that lost a field on write cannot lose its entry.
  return isRecord(value) && typeof value.id === "string" && value.id.length > 0;
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
