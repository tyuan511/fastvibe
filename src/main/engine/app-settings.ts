import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { nativeTheme, type BrowserWindow } from "electron";
import type { ComputerSettings, EngineModel, PermissionMode } from "@shared/types";
import type { FastVibePaths } from "./paths";

const VERSION = 1;

type SettingsFile = {
  version: number;
  settings: Record<string, unknown>;
};

/** Loose bag of renderer UI prefs. Main interprets `themeMode`, `defaultModel`, the two
 * permission-mode keys and `keepAwake`; everything else is the renderer's. */
export type PersistedSettings = Record<string, unknown>;

/**
 * Last parse of `settings.json`, validated against the file's own mtime/size.
 *
 * Read-heavy: several main-process paths ask for one preference at a time, and the
 * engine's event fan-out used to re-read (and re-parse) the whole file per streamed
 * event. A `statSync` is roughly two orders of magnitude cheaper than the read plus
 * `JSON.parse`, and keying on the stat keeps the previous semantics — a file edited
 * behind the app's back is still picked up, which an invalidate-on-write cache alone
 * would have lost.
 */
let cache: { mtimeMs: number; size: number; settings: PersistedSettings } | null = null;

export function readAppSettings(paths: FastVibePaths): PersistedSettings {
  try {
    const stat = statSync(paths.settingsFile);
    if (cache && cache.mtimeMs === stat.mtimeMs && cache.size === stat.size) return cache.settings;
    const parsed = JSON.parse(readFileSync(paths.settingsFile, "utf8")) as SettingsFile;
    if (!parsed || parsed.version !== VERSION || !parsed.settings || typeof parsed.settings !== "object") {
      return {};
    }
    cache = { mtimeMs: stat.mtimeMs, size: stat.size, settings: parsed.settings };
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

/**
 * 自动压缩 (设置 → 通用): whether the engine may compact a conversation on its own.
 *
 * The engine seeds `compaction.enabled` from its own settings file, which FastVibe
 * does not own, so a new session reads the preference through here instead.
 */
export function readAutoCompact(paths: FastVibePaths): boolean {
  const value = readAppSettings(paths).autoCompact;
  return typeof value === "boolean" ? value : true;
}

/**
 * 电脑操控 (设置 → 电脑操控).
 *
 * Read per call rather than cached in the bridge, so turning the master switch off stops
 * a run that is already going instead of only the next one. `readAppSettings` is itself
 * stat-cached, so this stays cheap enough to sit in front of every desktop action.
 */
export function readComputerSettings(paths: FastVibePaths): ComputerSettings {
  const settings = readAppSettings(paths);
  return {
    // Defaults match the renderer's: a machine whose settings file has not been written
    // yet must not be drivable, which is the opposite of how the other preferences fail.
    enabled: settings.computerEnabled === true,
    clipboard: settings.computerClipboard === true,
    preferBackground: settings.computerPreferBackground !== false,
    allowedApps: allowedAppIds(settings.computerAllowedApps),
  };
}

export function writeAppSettings(paths: FastVibePaths, settings: PersistedSettings): void {
  const payload: SettingsFile = { version: VERSION, settings };
  writeFileSync(paths.settingsFile, `${JSON.stringify(payload, null, 2)}\n`);
  // A write within the same millisecond as the cached stat would otherwise be
  // invisible to the mtime check; drop the entry rather than trusting the clock.
  cache = null;
}

export function clearAppSettings(paths: FastVibePaths): void {
  cache = null;
  if (existsSync(paths.settingsFile)) unlinkSync(paths.settingsFile);
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
 * Hand the renderer-owned permission mode to the permission sandbox. Called on
 * every settings write, so changing the mode reaches sessions that are already
 * running (the extension re-reads it per tool call).
 */
export function applyPermissionMode(settings: PersistedSettings): void {
  setPermissionModeEnv(settings.permissionMode);
  applyComputerAllowedApps(settings);
}

/** Same channel, same reason: 始终允许的应用 has to reach the sandbox extension. */
export const COMPUTER_ALLOWED_APPS_ENV = "FASTVIBE_COMPUTER_ALLOWED_APPS";

export function applyComputerAllowedApps(settings: PersistedSettings): void {
  process.env[COMPUTER_ALLOWED_APPS_ENV] = JSON.stringify(allowedAppIds(settings.computerAllowedApps));
}

/** The identities out of 始终允许的应用; the display names stored beside them are the UI's. */
function allowedAppIds(list: unknown): string[] {
  if (!Array.isArray(list)) return [];
  return list
    .map((item) => (item && typeof item === "object" ? (item as { id?: unknown }).id : undefined))
    .filter((id): id is string => typeof id === "string");
}

/**
 * The mode a launch starts on, resolved from 默认权限模式.
 *
 * `permissionMode` is the *live* mode the composer's chip switches, and the composer
 * writes it back to `settings.json`, so on its own it would let one escalated
 * session (完全访问) outlive the app. Startup therefore re-seeds the live value
 * from the default and stores the result, which is what the renderer reads through
 * `settings:get-sync` — sandbox env and chip agree from the first frame.
 *
 * An install from before the setting existed, or one with a corrupt file, lands on
 * 帮我批准 rather than the old hard-coded 完全访问.
 */
export function applyStartupPermissionMode(paths: FastVibePaths): void {
  const settings = readAppSettings(paths);
  // Deliberately *not* falling back to the stored `permissionMode`: that is the mode the
  // previous session ended in, and honouring it is the bug this setting exists to fix.
  const mode = permissionModeOf(settings.defaultPermissionMode) ?? "smart";
  // Only rewrite a settings file that exists: an empty one is the renderer's signal to
  // run its first-launch migration, and creating it here would hide that.
  if (Object.keys(settings).length > 0 && settings.permissionMode !== mode) {
    writeAppSettings(paths, { ...settings, permissionMode: mode });
  }
  setPermissionModeEnv(mode);
  applyComputerAllowedApps(settings);
}

function permissionModeOf(value: unknown): PermissionMode | undefined {
  return value === "ask" || value === "smart" || value === "full" ? value : undefined;
}

function setPermissionModeEnv(value: unknown): void {
  process.env[PERMISSION_MODE_ENV] = permissionModeOf(value) ?? "smart";
}

export function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0d1117" : "#ffffff";
}

export function paintWindows(windows: Iterable<BrowserWindow>): void {
  const color = windowBackgroundColor();
  for (const window of windows) window.setBackgroundColor(color);
}
