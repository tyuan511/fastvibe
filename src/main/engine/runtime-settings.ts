import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
// A relative path rather than the `@shared` alias, so `node --test` can load this module
// (the alias resolves only for the bundler) — same reason `reply-suggestion.ts` does it.
import { THINKING_EFFORT_LEVELS, type EngineModel, type ProjectModelDefault, type ThinkingLevel } from "../../shared/types.ts";
import type { FastVibePaths } from "./paths";

/** Settings that are safe to read from both Electron Main and a headless Agent. */
export type PersistedSettings = Record<string, unknown>;

type SettingsFile = {
  version: number;
  settings: PersistedSettings;
};

const VERSION = 1;
let cache: { file: string; mtimeMs: number; size: number; settings: PersistedSettings } | null = null;

export function readAppSettings(paths: FastVibePaths): PersistedSettings {
  try {
    const stat = statSync(paths.settingsFile);
    if (cache && cache.file === paths.settingsFile && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) {
      return cache.settings;
    }
    const parsed = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as SettingsFile;
    if (!parsed || parsed.version !== VERSION || !parsed.settings || typeof parsed.settings !== "object") return {};
    cache = { file: paths.settingsFile, mtimeMs: stat.mtimeMs, size: stat.size, settings: parsed.settings };
    return parsed.settings;
  } catch {
    return {};
  }
}

export function readDefaultModel(paths: FastVibePaths): EngineModel | undefined {
  return readPreferredModelSettings(paths).model;
}

/**
 * 轻量模型 (设置 → 模型与默认): the model short side jobs are asked to do — a chat's
 * title, a commit subject, the next-message guess, memory extraction.
 *
 * Unset means no opinion and each job runs on the conversation's own model, which is
 * what they all did before this row existed. Nothing is written until the user picks,
 * so a fresh install sends no extra provider traffic and pays nothing it did not pay
 * before. See `engine/light-model.ts` for how a pin is turned into a model.
 */
export function readLightModel(paths: FastVibePaths): EngineModel | undefined {
  return readEngineModel(readAppSettings(paths).lightModel);
}

/**
 * Resolve the model and reasoning defaults for a new conversation. A project pin
 * overrides the global default, while a missing or malformed pin falls back cleanly.
 */
export function readPreferredModelSettings(paths: FastVibePaths, project?: string): {
  model?: EngineModel;
  thinkingLevel?: ThinkingLevel | "auto";
} {
  const settings = readAppSettings(paths);
  const projectDefaults = settings.projectDefaults;
  const projectDefault = project && typeof projectDefaults === "object" && projectDefaults !== null && !Array.isArray(projectDefaults)
    ? (projectDefaults as Record<string, unknown>)[project]
    : undefined;
  const projectPreference = isProjectModelDefault(projectDefault) ? projectDefault : undefined;
  return {
    model: projectPreference?.model ?? readEngineModel(settings.defaultModel),
    thinkingLevel: projectPreference?.thinkingLevel ?? readThinkingLevel(settings.thinkingLevel),
  };
}

function readEngineModel(value: unknown): EngineModel | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { provider, id } = value as Partial<EngineModel>;
  if (typeof provider !== "string" || typeof id !== "string" || !provider || !id) return undefined;
  return { provider, id };
}

function readThinkingLevel(value: unknown): ThinkingLevel | "auto" | undefined {
  return value === "auto" || (typeof value === "string" && (THINKING_EFFORT_LEVELS as readonly string[]).includes(value))
    ? value as ThinkingLevel | "auto"
    : undefined;
}

function isProjectModelDefault(value: unknown): value is ProjectModelDefault {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<ProjectModelDefault>;
  return Boolean(readEngineModel(candidate.model)) && readThinkingLevel(candidate.thinkingLevel) !== undefined;
}

export function writeAppSettings(paths: FastVibePaths, settings: PersistedSettings): void {
  writeFileSync(paths.settingsFile, `${JSON.stringify({ version: VERSION, settings }, null, 2)}\n`);
  cache = null;
}

export function clearAppSettings(paths: FastVibePaths): void {
  cache = null;
  try {
    if (existsSync(paths.settingsFile)) unlinkSync(paths.settingsFile);
  } catch {
    // The next read will fall back to defaults.
  }
}

export function invalidateAppSettingsCache(): void {
  cache = null;
}

/** Keep this module's import graph free of Electron for the headless runtime. */
export function settingsFileExists(paths: FastVibePaths): boolean {
  return existsSync(paths.settingsFile);
}
