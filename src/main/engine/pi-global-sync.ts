import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { ProviderModel } from "@shared/types";
import type { PiConfigSyncReport } from "../../shared/types.ts";
import { orderProviderModels } from "../../shared/model-order.ts";
import { engineModelBaseUrl, trimBaseUrl } from "./provider-url.ts";
import { uiText } from "./ui-text.ts";

/**
 * Merge FastVibe's provider, default-model and MCP configuration into a pi agent
 * directory (`~/.pi/agent`), without taking that directory over.
 *
 * pi and FastVibe do not share a data root. This writes the files the CLI actually
 * reads and leaves sessions, themes and installed packages in place. `merge` replaces
 * a provider or MCP server that exists on both sides and keeps one that exists only in
 * pi. `replace` writes FastVibe's providers, credentials and MCP servers in their
 * place and drops the rest.
 *
 * Secrets are the sharp edge. pi does not store an API key as an opaque string: a
 * value that starts with `!` is a shell command, and `$VAR` / `${VAR}` are expanded.
 * A key pasted into FastVibe can contain either by accident, so every secret is
 * escaped (`escapePiConfigSecret`) on the way out. Existing files are copied aside
 * before the first byte changes, and a file that is not valid JSON aborts the whole
 * sync so a half-applied write cannot replace a config we failed to read.
 */

/** Same set as `THINKING_EFFORT_LEVELS`. Copied so this module can load under `node --test`, which cannot resolve `@shared`. */
const EFFORTS = ["minimal", "low", "medium", "high", "xhigh", "max"] as const;

export type PiSyncMode = "merge" | "replace";

export type PiSyncProviderInput = {
  id: string;
  /**
   * `native` contributes overrides only. In `merge` those fold into the provider pi
   * already has; in `replace` the entry is just the overrides.
   */
  kind: "native" | "custom";
  /** models.json provider object. Absent when this provider only contributes a credential. */
  models?: Record<string, unknown>;
  /** auth.json credential. Custom providers usually carry the key inside `models` instead. */
  credential?: PiSyncCredential;
};

export type PiSyncCredential =
  | { type: "api_key"; key: string }
  | { type: "oauth"; access: string; refresh: string; expires: number };

export type PiSyncMcpServer = {
  name: string;
  id: string;
  enabled: boolean;
  transport: "stdio" | "http";
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  url?: string;
};

export type PiSyncRequest = {
  providers: PiSyncProviderInput[];
  /** Connected-looking providers that had nothing to write. Names, for the report only. */
  skipped: string[];
  defaultModel?: { provider: string; id: string };
  /** A concrete level. `auto` / absent leaves pi's thinking default alone. */
  thinkingLevel?: string;
  /** Omitted when FastVibe's effective value already matches pi's default. */
  autoCompact?: boolean;
  mcp: PiSyncMcpServer[];
  /** Absent means merge, which is what the older call sites do. */
  mode?: PiSyncMode;
};

/**
 * One provider object for pi's `models.json`.
 *
 * `apiKey` is written exactly as given. FastVibe's own `models.json` passes the env
 * var name (the process injects the secret); a sync to global pi passes the secret
 * itself, and `writePiAgentConfig` escapes it. Native providers contribute overrides
 * only — a full entry would shadow the CLI's built-in provider.
 */
export function piProviderModelsEntry(
  provider: {
    kind: "native" | "custom";
    name: string;
    baseUrl: string;
    api: string;
    models: ProviderModel[];
    modelOrder?: string[];
  },
  apiKey?: string,
): Record<string, unknown> | undefined {
  if (provider.kind === "native") {
    const modelOverrides = Object.fromEntries(
      provider.models.filter((model) => model.edited === true).map((model) => [model.id, nativeModelOverride(model)]),
    );
    return Object.keys(modelOverrides).length > 0 ? { modelOverrides } : undefined;
  }
  if (provider.models.length === 0) return undefined;
  const baseUrl = trimBaseUrl(provider.baseUrl);
  return {
    name: provider.name,
    baseUrl,
    api: provider.api,
    ...(apiKey ? { apiKey } : {}),
    // Gemini authenticates with `x-goog-api-key` via the SDK client, not Bearer.
    authHeader: provider.api !== "google-generative-ai",
    models: orderProviderModels(provider.models, provider.modelOrder).map((model) => {
      const api = model.api ?? provider.api;
      const compat = modelCompat(api, model);
      const thinking = thinkingLevelMap(model);
      const modelBase = engineModelBaseUrl(provider.baseUrl, api);
      const cost = modelCost(model.cost);
      return {
        id: model.id,
        name: model.name,
        contextWindow: model.contextWindow,
        maxTokens: model.maxTokens,
        reasoning: model.reasoning,
        input: engineInputs(model.input),
        ...(model.api ? { api: model.api } : {}),
        ...(modelBase !== baseUrl ? { baseUrl: modelBase } : {}),
        ...(compat ? { compat } : {}),
        ...(thinking ? { thinkingLevelMap: thinking } : {}),
        ...(cost ? { cost } : {}),
      };
    }),
  };
}

/**
 * Make a secret survive pi's config-value parser as itself.
 *
 * `$` starts an environment interpolation (`$NAME`, `${NAME}`) and a leading `!`
 * runs the rest as a shell command. `$$` is a literal dollar and `$!` is a literal
 * bang, but the command form is decided before escapes are read — a value that
 * *starts* with `!` is a command no matter what follows. Prefixing `$` turns that
 * leading bang into the `$!` escape, which the template parser then yields back.
 */
export function escapePiConfigSecret(value: string): string {
  // `$$` in a replacement string is one dollar, so four are needed to emit two.
  const escaped = value.replaceAll("$", "$$$$");
  return escaped.startsWith("!") ? `$${escaped}` : escaped;
}

export function writePiAgentConfig(agentDir: string, request: PiSyncRequest, ownAgentDir?: string): PiConfigSyncReport {
  const root = resolve(agentDir);
  if (ownAgentDir && resolve(ownAgentDir) === root) {
    throw new Error(uiText(
      "不能把配置同步到 FastVibe 自己的运行目录",
      "Refusing to write pi config into FastVibe's own runtime directory",
    ));
  }
  if (existsSync(root) && !isDirectory(root)) {
    throw new Error(uiText("全局 pi 的配置目录不是一个文件夹", "The pi config path is not a directory"));
  }
  mkdirSync(root, { recursive: true });

  const modelsPath = join(root, "models.json");
  const authPath = join(root, "auth.json");
  const settingsPath = join(root, "settings.json");
  const mcpPath = join(root, "mcp.json");

  const modelsFile = readJsonFile(modelsPath, "models.json");
  const authFile = readJsonFile(authPath, "auth.json");
  const settingsFile = readJsonFile(settingsPath, "settings.json");
  const mcpFile = readJsonFile(mcpPath, "mcp.json");

  const models = mergeModels(modelsFile.value, request);
  const auth = mergeAuth(authFile.value, request);
  const settings = mergeSettings(settingsFile.value, request, syncedProviderIds(request));
  const mcp = mergeMcp(mcpFile.value, request);

  const writes: Array<{ path: string; before?: string; next: unknown; mode: number }> = [];
  if (models.changed) writes.push({ path: modelsPath, before: modelsFile.text, next: models.next, mode: 0o600 });
  if (auth.changed) writes.push({ path: authPath, before: authFile.text, next: auth.next, mode: 0o600 });
  if (settings.changed) writes.push({ path: settingsPath, before: settingsFile.text, next: settings.next, mode: 0o644 });
  if (mcp.changed) writes.push({ path: mcpPath, before: mcpFile.text, next: mcp.next, mode: 0o600 });

  // Nothing is written until every file has been read. A bad JSON file throws above,
  // so a sync that cannot see the current config cannot replace it.
  const backupDir = writes.some((item) => item.before !== undefined) ? backup(root, writes) : undefined;
  for (const item of writes) writeText(item.path, `${JSON.stringify(item.next, null, 2)}\n`, item.mode);

  const unchanged = writes.length === 0;
  return {
    agentDir: root,
    ...(backupDir ? { backupDir } : {}),
    providersWritten: models.written,
    providersKept: models.kept,
    providersSkipped: request.skipped,
    authWritten: auth.written,
    settingsUpdated: settings.updated,
    mcpWritten: mcp.written,
    mcpKept: mcp.kept,
    mcpSkipped: mcp.skipped,
    unchanged,
  };
}

function syncedProviderIds(request: PiSyncRequest): Set<string> {
  const ids = new Set<string>();
  for (const provider of request.providers) {
    if (provider.models || provider.credential) ids.add(provider.id);
  }
  return ids;
}

function mergeModels(current: unknown, request: PiSyncRequest): {
  next: Record<string, unknown>;
  written: string[];
  kept: string[];
  changed: boolean;
} {
  const base = recordOrEmpty(current, "models.json");
  if (base.providers !== undefined && !isRecord(base.providers)) {
    throw new Error(uiText("全局 pi 的 models.json 格式无法识别", "pi models.json is not in a recognised shape"));
  }
  const previous = isRecord(base.providers) ? base.providers : {};
  const providers: Record<string, unknown> = request.mode === "replace" ? {} : { ...previous };
  const written: string[] = [];
  for (const provider of request.providers) {
    if (!provider.models) continue;
    const existing = providers[provider.id];
    // Folding overrides into an existing native entry keeps that entry's apiKey.
    // Escaping the key here would double every `$` the next time overrides are written.
    const next = request.mode !== "replace" && provider.kind === "native" && isRecord(existing)
      ? { ...existing, ...provider.models }
      : escapeModelsKey(provider.models);
    if (sameJson(existing, next)) continue;
    providers[provider.id] = next;
    written.push(provider.id);
  }
  const kept = Object.keys(providers).filter((id) => !written.includes(id));
  return { next: { ...base, providers }, written, kept, changed: !sameJson(previous, providers) };
}

function mergeAuth(current: unknown, request: PiSyncRequest): {
  next: Record<string, unknown>;
  written: string[];
  changed: boolean;
} {
  const base = current === undefined ? {} : recordOrEmpty(current, "auth.json");
  const next: Record<string, unknown> = request.mode === "replace" ? {} : { ...base };
  const written: string[] = [];
  for (const provider of request.providers) {
    if (!provider.credential) continue;
    const credential = provider.credential.type === "api_key"
      ? { type: "api_key" as const, key: escapePiConfigSecret(provider.credential.key) }
      : provider.credential;
    if (sameJson(next[provider.id], credential)) continue;
    next[provider.id] = credential;
    written.push(provider.id);
  }
  return { next, written, changed: !sameJson(base, next) };
}

function mergeSettings(
  current: unknown,
  request: PiSyncRequest,
  synced: Set<string>,
): { next: Record<string, unknown>; updated: string[]; changed: boolean } {
  const base = current === undefined ? {} : recordOrEmpty(current, "settings.json");
  const next: Record<string, unknown> = { ...base };
  const updated: string[] = [];

  if (request.defaultModel && synced.has(request.defaultModel.provider)) {
    if (next.defaultProvider !== request.defaultModel.provider) {
      next.defaultProvider = request.defaultModel.provider;
      updated.push("defaultProvider");
    }
    if (next.defaultModel !== request.defaultModel.id) {
      next.defaultModel = request.defaultModel.id;
      updated.push("defaultModel");
    }
  }
  if (request.thinkingLevel && (EFFORTS as readonly string[]).includes(request.thinkingLevel)) {
    if (next.defaultThinkingLevel !== request.thinkingLevel) {
      next.defaultThinkingLevel = request.thinkingLevel;
      updated.push("defaultThinkingLevel");
    }
  }
  if (typeof request.autoCompact === "boolean" && compactionEnabled(base) !== request.autoCompact) {
    const compaction = isRecord(base.compaction) ? { ...base.compaction } : {};
    compaction.enabled = request.autoCompact;
    next.compaction = compaction;
    updated.push("compaction.enabled");
  }
  return { next, updated, changed: updated.length > 0 };
}

function mergeMcp(current: unknown, request: PiSyncRequest): {
  next: Record<string, unknown>;
  written: string[];
  kept: string[];
  skipped: string[];
  changed: boolean;
} {
  const base = current === undefined ? {} : recordOrEmpty(current, "mcp.json");
  if (base.mcpServers !== undefined && !isRecord(base.mcpServers)) {
    throw new Error(uiText("全局 pi 的 mcp.json 格式无法识别", "pi mcp.json is not in a recognised shape"));
  }
  const previous = isRecord(base.mcpServers) ? base.mcpServers : {};
  const servers: Record<string, unknown> = request.mode === "replace" ? {} : { ...previous };
  const claimed = new Set<string>();
  const written: string[] = [];
  const skipped: string[] = [];
  for (const server of request.mcp) {
    const config = piMcpServer(server);
    const label = server.name.trim() || server.id;
    if (!config) {
      skipped.push(label);
      continue;
    }
    const name = claimMcpName(piMcpName(server.name) || piMcpName(server.id) || "mcp", claimed);
    if (sameJson(servers[name], config)) {
      claimed.add(name);
      continue;
    }
    servers[name] = config;
    written.push(name);
  }
  const kept = Object.keys(servers).filter((name) => !written.includes(name));
  return { next: { ...base, mcpServers: servers }, written, kept, skipped, changed: !sameJson(previous, servers) };
}

function piMcpServer(server: PiSyncMcpServer): Record<string, unknown> | undefined {
  const enabled = server.enabled ? {} : { enabled: false };
  if (server.transport === "http") {
    if (!server.url || !isHttpUrl(server.url)) return undefined;
    return { url: server.url, ...enabled };
  }
  if (!server.command?.trim()) return undefined;
  const args = server.args?.filter((arg) => typeof arg === "string");
  const env = server.env
    ? Object.fromEntries(Object.entries(server.env).filter((entry): entry is [string, string] => typeof entry[1] === "string").map(([key, value]) => [key, escapePiConfigSecret(value)]))
    : undefined;
  return {
    command: server.command,
    ...(args && args.length > 0 ? { args } : {}),
    ...(env && Object.keys(env).length > 0 ? { env } : {}),
    ...enabled,
  };
}

const MCP_NAME = /[^A-Za-z0-9_-]+/g;

function piMcpName(value: string): string {
  return value.trim().replace(MCP_NAME, "-").replace(/^-+|-+$/g, "").slice(0, 64);
}

function claimMcpName(base: string, claimed: Set<string>): string {
  if (!claimed.has(base)) {
    claimed.add(base);
    return base;
  }
  let index = 2;
  while (claimed.has(`${base}-${index}`)) index += 1;
  const name = `${base}-${index}`;
  claimed.add(name);
  return name;
}

function escapeModelsKey(models: Record<string, unknown>): Record<string, unknown> {
  if (typeof models.apiKey !== "string" || models.apiKey.length === 0) return models;
  return { ...models, apiKey: escapePiConfigSecret(models.apiKey) };
}

function compactionEnabled(settings: Record<string, unknown>): boolean {
  const compaction = settings.compaction;
  if (!isRecord(compaction) || compaction.enabled === undefined) return true;
  return compaction.enabled !== false;
}

function backup(root: string, writes: Array<{ path: string; before?: string }>): string | undefined {
  const originals = writes.filter((item) => item.before !== undefined);
  if (originals.length === 0) return undefined;
  const dir = join(root, "backups", `fastvibe-${Date.now()}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  for (const item of originals) copyFileSync(item.path, join(dir, basename(item.path)));
  return dir;
}

function writeText(path: string, text: string, mode: number): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(temporary, text, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, path);
    chmodSync(path, mode);
  } catch (error) {
    rmSync(temporary, { force: true });
    throw error;
  }
}

function readJsonFile(path: string, label: string): { text?: string; value?: unknown } {
  if (!existsSync(path)) return {};
  const text = readFileSync(path, "utf8");
  try {
    return { text, value: JSON.parse(text.replace(/^\uFEFF/, "")) };
  } catch {
    throw new Error(uiText(
      `无法读取全局 pi 的 ${label}，文件不是有效的 JSON，已停止同步`,
      `Could not read pi ${label}: the file is not valid JSON, so nothing was written`,
    ));
  }
}

function recordOrEmpty(value: unknown, label: string): Record<string, unknown> {
  if (value === undefined) return {};
  if (!isRecord(value)) {
    throw new Error(uiText(
      `全局 pi 的 ${label} 不是一个 JSON 对象，已停止同步`,
      `pi ${label} is not a JSON object, so nothing was written`,
    ));
  }
  return value;
}

function sameJson(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * Compatibility pins for one model, derived from the api it will actually be
 * streamed with. Model level rather than provider level on purpose: a provider whose
 * models are split across protocols would otherwise leak the chat-completions pin
 * onto its siblings, and `parseModels` merges model compat over provider compat.
 *
 * Every provider written here is an OpenAI-compatible endpoint behind a base URL the
 * SDK does not recognise, so pi-ai cannot tell whether the upstream accepts the
 * OpenAI `developer` role that replaced `system`. Unknown URLs default to
 * `supportsDeveloperRole: true`, which silently 400s on upstreams that only speak
 * `system`. `system` is accepted everywhere, so pin it for chat-completions models.
 * The Responses API sends the system prompt as `instructions` and ignores the pin.
 */
function modelCompat(api: string, model: ProviderModel): Record<string, unknown> | undefined {
  if (api !== "openai-completions") return undefined;
  const compat: Record<string, unknown> = { supportsDeveloperRole: false };
  // GLM/Z.AI upstreams take a top-level `enable_thinking` instead of
  // `reasoning_effort`; unknown gateways are never auto-detected as `zai`.
  if (model.thinkingFormat === "zai") compat.thinkingFormat = "zai";
  return compat;
}

function nativeModelOverride(model: ProviderModel): Record<string, unknown> {
  const thinking = thinkingLevelMap(model);
  return {
    name: model.name,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    reasoning: model.reasoning,
    input: engineInputs(model.input),
    ...(thinking ? { thinkingLevelMap: thinking } : {}),
  };
}

/**
 * pi's `thinkingLevelMap` for one model: an effort the user unchecked is mapped to
 * `null` (unsupported), so the engine clamps a request for it instead of sending a
 * parameter the upstream rejects. `off` is never mapped.
 * A level whose provider name differs keeps its provider value. `xhigh` and `max` are
 * special: pi offers either only when the model maps it, so a checked one must carry a
 * mapping, and an unchecked one is written as `null` like everything else.
 */
function thinkingLevelMap(model: ProviderModel): Record<string, string | null> | undefined {
  if (!model.reasoning || !model.thinkingLevels) return undefined;
  const allowed = new Set<string>(model.thinkingLevels);
  const map: Record<string, string | null> = {};
  for (const level of EFFORTS) {
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
 * The engine's models.json schema only accepts `text` and `image` modalities, and a
 * single unknown value invalidates the whole file (every custom provider is then
 * dropped from the registry). models.dev also reports `video`/`file`, which we keep
 * in the UI metadata but must not hand to the engine.
 */
function engineInputs(input: string[] | undefined): string[] {
  if (!input) return [];
  return input.filter((item) => item === "text" || item === "image");
}

function modelCost(cost: ProviderModel["cost"]): ProviderModel["cost"] | undefined {
  if (!cost) return undefined;
  if (![cost.input, cost.output, cost.cacheRead, cost.cacheWrite].every((value) => typeof value === "number")) return undefined;
  return { input: cost.input, output: cost.output, cacheRead: cost.cacheRead, cacheWrite: cost.cacheWrite };
}
