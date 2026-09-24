import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { THINKING_EFFORT_LEVELS, type EngineModel, type ProjectModelDefault, type ThinkingLevel } from "@shared/types";
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

export function readAutoCompact(paths: FastVibePaths): boolean {
  const value = readAppSettings(paths).autoCompact;
  return typeof value === "boolean" ? value : true;
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

export function applyPermissionMode(settings: PersistedSettings): void {
  const mode = settings.permissionMode === "ask" || settings.permissionMode === "full" || settings.permissionMode === "smart"
    ? settings.permissionMode
    : "smart";
  process.env.FASTVIBE_PERMISSION_MODE = mode;
}

/** Keep this module's import graph free of Electron for the headless runtime. */
export function settingsFileExists(paths: FastVibePaths): boolean {
  return existsSync(paths.settingsFile);
}
