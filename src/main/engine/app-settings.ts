import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { nativeTheme, type BrowserWindow } from "electron";
import type { EngineModel } from "@shared/types";
import type { FastVibePaths } from "./paths";

const VERSION = 1;

type SettingsFile = {
  version: number;
  settings: Record<string, unknown>;
};

/** Loose bag of renderer UI prefs. Main only interprets `themeMode` and `defaultModel`. */
export type PersistedSettings = Record<string, unknown>;

export function readAppSettings(paths: FastVibePaths): PersistedSettings {
  try {
    const parsed = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as SettingsFile;
    if (!parsed || parsed.version !== VERSION || !parsed.settings || typeof parsed.settings !== "object") {
      return {};
    }
    return parsed.settings;
  } catch {
    return {};
  }
}

/**
 * The model a brand-new conversation should start on, if the user pinned one.
 *
 * Deliberately separate from the SDK's own `defaultProvider`/`defaultModel`:
 * `AgentSession.setModel` rewrites those to the last used model on every switch, so
 * they can never hold a preference.
 */
export function readDefaultModel(paths: FastVibePaths): EngineModel | undefined {
  const value = readAppSettings(paths).defaultModel;
  if (typeof value !== "object" || value === null) return undefined;
  const { provider, id } = value as Partial<EngineModel>;
  if (typeof provider !== "string" || typeof id !== "string" || !provider || !id) return undefined;
  return { provider, id };
}

export function writeAppSettings(paths: FastVibePaths, settings: PersistedSettings): void {
  const payload: SettingsFile = { version: VERSION, settings };
  writeFileSync(paths.settingsFile, `${JSON.stringify(payload, null, 2)}\n`);
}

export function clearAppSettings(paths: FastVibePaths): void {
  try {
    if (existsSync(paths.settingsFile)) unlinkSync(paths.settingsFile);
  } catch {
    // ignore
  }
}

export function applyNativeTheme(settings: PersistedSettings): void {
  const mode = settings.themeMode;
  nativeTheme.themeSource = mode === "light" || mode === "dark" || mode === "system" ? mode : "system";
}

/**
 * Env var the built-in `permission-sandbox` extension reads. It is a standalone
 * jiti module outside the Electron bundle, so it cannot import this module; the
 * process environment is the one channel shared with the embedded engine.
 */
export const PERMISSION_MODE_ENV = "FASTVIBE_PERMISSION_MODE";

/**
 * Hand the renderer-owned permission mode to the permission sandbox. Called at
 * startup and on every settings write, so changing the mode reaches sessions
 * that are already running (the extension re-reads it per tool call).
 */
export function applyPermissionMode(settings: PersistedSettings): void {
  const mode = settings.permissionMode;
  process.env[PERMISSION_MODE_ENV] = mode === "ask" || mode === "smart" || mode === "full" ? mode : "full";
}

export function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0d1117" : "#ffffff";
}

export function paintWindows(windows: Iterable<BrowserWindow>): void {
  const color = windowBackgroundColor();
  for (const window of windows) window.setBackgroundColor(color);
}
