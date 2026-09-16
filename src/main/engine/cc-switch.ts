import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { CcSwitchCandidate, CcSwitchScan, ProviderApi, ProviderModel } from "@shared/types";
import { enrichModel, loadModelsDev } from "./models-dev";
import type { FastVibePaths } from "./paths";
import {
  addProvider,
  fetchProviderModels,
  listProviderConfigs,
  loadProviderKeys,
  saveFastVibe,
} from "./providers";

const DB_PATH = join(homedir(), ".cc-switch", "cc-switch.db");

const APP_LABELS: Record<string, string> = {
  claude: "Claude Code",
  "claude-desktop": "Claude Desktop",
  codex: "Codex",
  gemini: "Gemini",
  grokbuild: "Grok",
  opencode: "OpenCode",
  pi: "Pi",
  hermes: "Hermes",
  openclaw: "OpenClaw",
  mcode: "MiniMax Code",
};

const OAUTH_TYPES = new Set(["codex_oauth", "github_copilot", "xai_oauth"]);

type Draft = {
  id: string;
  name: string;
  appType: string;
  appLabel: string;
  baseUrl: string;
  api: ProviderApi;
  apiKey: string;
  models: string[];
  target: "fastvibe" | "custom";
};

/**
 * Providers CC Switch has stored that FastVibe can actually use: a base URL, an
 * API key, and a protocol we speak. Official OAuth logins and empty presets are
 * dropped; keys never leave the main process.
 */
export async function scanCcSwitch(paths: FastVibePaths): Promise<CcSwitchScan> {
  if (!existsSync(DB_PATH)) return { found: false, path: DB_PATH, candidates: [] };
  const drafts = readDrafts();
  const taken = await existingFingerprints(paths);
  const candidates = drafts.map((draft) => {
    const fingerprint = finger(draft.api, draft.baseUrl, draft.apiKey);
    if (taken.has(fingerprint)) {
      return candidate(draft, false, draft.target === "fastvibe" ? "已写入内置 FastVibe" : "已导入");
    }
    return candidate(draft, true);
  });
  return { found: true, path: DB_PATH, candidates };
}

export async function importCcSwitch(paths: FastVibePaths, ids: string[]): Promise<number> {
  const wanted = new Set(ids);
  const taken = await existingFingerprints(paths);
  let imported = 0;
  for (const draft of readDrafts()) {
    if (!wanted.has(draft.id)) continue;
    const fingerprint = finger(draft.api, draft.baseUrl, draft.apiKey);
    if (taken.has(fingerprint)) continue;
    const models = await resolveModels(draft);
    if (draft.target === "fastvibe") {
      await saveFastVibe(paths, draft.apiKey, models);
    } else {
      await addProvider(
        paths,
        { name: draft.name, baseUrl: draft.baseUrl, apiKey: draft.apiKey, api: draft.api },
        models,
      );
    }
    taken.add(fingerprint);
    imported += 1;
  }
  return imported;
}

function candidate(draft: Draft, importable: boolean, reason?: string): CcSwitchCandidate {
  return {
    id: draft.id,
    name: draft.name,
    appLabel: draft.appLabel,
    baseUrl: draft.baseUrl,
    api: draft.api,
    modelCount: draft.models.length,
    importable,
    reason,
  };
}

function readDrafts(): Draft[] {
  if (!existsSync(DB_PATH)) return [];
  let rows: Array<{ id: string; app_type: string; name: string; settings_config: string; meta: string }>;
  try {
    const db = new DatabaseSync(DB_PATH, { readOnly: true });
    try {
      rows = db
        .prepare("SELECT id, app_type, name, settings_config, meta FROM providers")
        .all() as typeof rows;
    } finally {
      db.close();
    }
  } catch {
    throw new Error("无法读取 CC Switch 数据库");
  }

  const drafts: Draft[] = [];
  const seen = new Set<string>();
  for (const row of rows) {
    const settings = parseJson(row.settings_config);
    const meta = parseJson(row.meta);
    const extracted = extract(row.app_type, settings, meta);
    if (!extracted) continue;
    const { baseUrl, apiKey, api, models } = extracted;
    if (!apiKey || !baseUrl) continue;
    if (isOAuth(settings, meta)) continue;
    const fingerprint = finger(api, baseUrl, apiKey);
    if (seen.has(fingerprint)) continue;
    seen.add(fingerprint);
    const appLabel = APP_LABELS[row.app_type] ?? row.app_type;
    drafts.push({
      id: `${row.app_type}:${row.id}`,
      name: row.name.trim() || appLabel,
      appType: row.app_type,
      appLabel,
      baseUrl,
      api,
      apiKey,
      models,
      target: isFastVibeGateway(baseUrl) ? "fastvibe" : "custom",
    });
  }
  return drafts;
}

function extract(
  appType: string,
  settings: unknown,
  meta: unknown,
): { baseUrl: string; apiKey: string; api: ProviderApi; models: string[] } | null {
  const root = asRecord(settings);
  if (!root) return null;
  const metaRecord = asRecord(meta);
  if (appType === "claude" || appType === "claude-desktop") {
    const env = asRecord(root.env);
    return {
      baseUrl: stripSlash(str(env?.ANTHROPIC_BASE_URL)),
      apiKey: firstNonEmpty(env, ["ANTHROPIC_AUTH_TOKEN", "ANTHROPIC_API_KEY", "OPENROUTER_API_KEY", "GOOGLE_API_KEY"]),
      api: apiFromFormat(str(metaRecord?.apiFormat), "anthropic-messages"),
      models: unique([
        str(env?.ANTHROPIC_MODEL),
        str(env?.ANTHROPIC_DEFAULT_HAIKU_MODEL),
        str(env?.ANTHROPIC_DEFAULT_SONNET_MODEL),
        str(env?.ANTHROPIC_DEFAULT_OPUS_MODEL),
      ]),
    };
  }
  if (appType === "codex") {
    const auth = asRecord(root.auth);
    const config = str(root.config);
    return {
      baseUrl: stripSlash(quoted(config, "base_url")),
      apiKey: firstNonEmpty(auth, ["OPENAI_API_KEY"]) || quoted(config, "api_key"),
      api: wireApi(quoted(config, "wire_api"), str(metaRecord?.apiFormat)),
      models: unique([quoted(config, "model")]),
    };
  }
  if (appType === "gemini") {
    const env = asRecord(root.env);
    return {
      baseUrl: stripSlash(str(env?.GOOGLE_GEMINI_BASE_URL) || str(env?.GEMINI_BASE_URL)),
      apiKey: firstNonEmpty(env, ["GEMINI_API_KEY", "GOOGLE_API_KEY"]),
      api: "google-generative-ai",
      models: unique([str(env?.GEMINI_MODEL)]),
    };
  }
  if (appType === "grokbuild") {
    const config = str(root.config);
    return {
      baseUrl: stripSlash(quoted(config, "base_url") || yaml(config, "base_url")),
      apiKey: quoted(config, "api_key") || yaml(config, "api_key"),
      api: "openai-completions",
      models: unique([quoted(config, "model") || yaml(config, "model")]),
    };
  }
  if (appType === "opencode" || appType === "mcode") {
    const options = asRecord(root.options);
    const npm = str(root.npm);
    const models = asRecord(root.models);
    return {
      baseUrl: stripSlash(str(options?.baseURL) || str(options?.baseUrl)),
      apiKey: str(options?.apiKey),
      api: npm.includes("anthropic") ? "anthropic-messages" : "openai-completions",
      models: models ? Object.keys(models) : [],
    };
  }
  if (appType === "pi") {
    const models = Array.isArray(root.models) ? root.models : [];
    return {
      baseUrl: stripSlash(str(root.baseUrl) || str(root.base_url)),
      apiKey: str(root.apiKey) || str(root.api_key),
      api: apiFromFormat(str(root.api), "openai-completions"),
      models: models.flatMap((item) => {
        if (typeof item === "string") return [item];
        const record = asRecord(item);
        return record ? [str(record.id)] : [];
      }).filter(Boolean),
    };
  }
  if (appType === "hermes") {
    return {
      baseUrl: stripSlash(str(root.base_url) || str(root.baseUrl)),
      apiKey: str(root.api_key) || str(root.apiKey),
      api: "openai-completions",
      models: unique([str(root.model)]),
    };
  }
  if (appType === "openclaw") {
    return {
      baseUrl: stripSlash(str(root.baseUrl) || str(root.base_url)),
      apiKey: str(root.apiKey) || str(root.api_key),
      api: "openai-completions",
      models: unique([str(root.model)]),
    };
  }
  return null;
}

async function resolveModels(draft: Draft): Promise<ProviderModel[]> {
  try {
    const fetched = await fetchProviderModels(draft.baseUrl, draft.apiKey, draft.api);
    if (fetched.length > 0) return fetched;
  } catch {
    // Fall back to whatever CC Switch already recorded.
  }
  const index = loadModelsDev();
  const seen = new Set<string>();
  const models: ProviderModel[] = [];
  for (const id of draft.models) {
    if (!id || seen.has(id)) continue;
    seen.add(id);
    models.push({
      ...enrichModel(index, id, id),
      thinkingFormat: /glm|zai|z-ai/i.test(id) ? "zai" : "openai",
    });
  }
  return models;
}

async function existingFingerprints(paths: FastVibePaths): Promise<Set<string>> {
  const keys = await loadProviderKeys(paths);
  const taken = new Set<string>();
  for (const provider of listProviderConfigs(paths, keys)) {
    const key = keys[provider.apiKeyEnv];
    if (!key) continue;
    taken.add(finger(provider.api, provider.baseUrl, key));
  }
  return taken;
}

function isOAuth(settings: unknown, meta: unknown): boolean {
  const type = str(asRecord(meta)?.providerType).toLowerCase();
  if (OAUTH_TYPES.has(type)) return true;
  const auth = asRecord(asRecord(settings)?.auth);
  return str(auth?.auth_mode).toLowerCase() === "chatgpt" || Boolean(asRecord(auth?.tokens));
}

function isFastVibeGateway(baseUrl: string): boolean {
  try {
    const host = new URL(baseUrl).hostname.toLowerCase();
    return host === "fastvibe.dev" || host.endsWith(".fastvibe.dev");
  } catch {
    return false;
  }
}

function apiFromFormat(raw: string, fallback: ProviderApi): ProviderApi {
  const value = raw.toLowerCase().replace(/-/g, "_");
  if (value === "openai_chat" || value === "openai_completions" || value === "openai-completions") {
    return "openai-completions";
  }
  if (value === "openai_responses" || value === "openai-responses") return "openai-responses";
  if (value === "anthropic" || value === "anthropic_messages" || value === "anthropic-messages") {
    return "anthropic-messages";
  }
  if (
    value === "google" ||
    value === "gemini" ||
    value === "google_generative_ai" ||
    value === "google-generative-ai"
  ) {
    return "google-generative-ai";
  }
  return fallback;
}

function wireApi(wire: string, format: string): ProviderApi {
  const value = wire.toLowerCase() || format.toLowerCase().replace(/-/g, "_");
  if (value === "chat" || value.includes("chat")) return "openai-completions";
  return "openai-responses";
}

function finger(api: string, baseUrl: string, apiKey: string): string {
  return `${api}|${normalizeUrl(baseUrl)}|${apiKey}`;
}

function normalizeUrl(url: string): string {
  try {
    const parsed = new URL(stripSlash(url));
    const host = parsed.host.toLowerCase();
    if (host === "fastvibe.dev" || host.endsWith(".fastvibe.dev")) {
      return `${parsed.protocol}//${host}`;
    }
    const path = parsed.pathname.replace(/\/+$/, "") || "";
    return `${parsed.protocol}//${host}${path}`;
  } catch {
    return stripSlash(url).toLowerCase();
  }
}

function stripSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

function quoted(text: string, key: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*=\\s*"([^"]*)"`, "m"));
  return match?.[1]?.trim() ?? "";
}

function yaml(text: string, key: string): string {
  const match = text.match(new RegExp(`(?:^|\\n)\\s*${key}\\s*:\\s*"?([^"\\n]+)"?`, "m"));
  return match?.[1]?.trim() ?? "";
}

function firstNonEmpty(record: Record<string, unknown> | null, keys: string[]): string {
  if (!record) return "";
  for (const key of keys) {
    const value = str(record[key]);
    if (value && value !== "null") return value;
  }
  return "";
}

function unique(values: string[]): string[] {
  return [...new Set(values.filter(Boolean))];
}

function str(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}


