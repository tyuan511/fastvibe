import { existsSync, readFileSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { nativeTheme, type BrowserWindow } from "electron";
import { THINKING_EFFORT_LEVELS, type ComputerSettings, type EngineModel, type ProjectModelDefault, type ThinkingLevel } from "@shared/types";
import { isGlassEnabled } from "@shared/glass";
import type { FastVibePaths } from "./paths";

const VERSION = 1;

type SettingsFile = {
  version: number;
  settings: Record<string, unknown>;
};

/** Loose bag of renderer UI prefs. Main interprets `themeMode`, the global and
 * project model defaults and `keepAwake`; everything else is the renderer's. */
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
 * Whether this window is drawn over the OS blur: macOS only, and only while 玻璃效果 is
 * on (`shared/glass.ts`). Windows and Linux have no vibrancy, so the setting is not
 * offered there and every theme keeps its solid surfaces.
 *
 * Read from the saved settings rather than told by the renderer, so a window is already
 * the right kind when it is created and there is no call a remote client could forge.
 */
export function windowIsGlass(settings: Record<string, unknown>): boolean {
  return process.platform === "darwin" && isGlassEnabled(settings);
}

export function windowBackgroundColor(glass = false): string {
  // Fully transparent, not merely `transparent`: the window's own fill is what would
  // otherwise sit between the blur and the page.
  if (glass) return "#00000000";
  // Pre-paint only: the colour the window shows before the renderer applies a theme
  // (the default GitHub Light / Dark background).
  return nativeTheme.shouldUseDarkColors ? "#0d1117" : "#ffffff";
}

/** The macOS material behind a Glass window. */
const GLASS_MATERIAL = "under-window" as const;

/** The `BrowserWindow` option that turns the blur on at creation. */
export function windowVibrancy(glass: boolean): typeof GLASS_MATERIAL | undefined {
  return glass ? GLASS_MATERIAL : undefined;
}

/**
 * Where macOS draws the traffic lights. The side panels float as panes inset 8px from
 * the window edge (index.css, floating panes), so the lights sit 8px further in to stay
 * inside the sidebar pane's first row instead of on its corner.
 */
export const WINDOW_BUTTON_POSITION = { x: 24, y: 24 } as const;

export function paintWindows(windows: Iterable<BrowserWindow>, settings: Record<string, unknown>): void {
  const glass = windowIsGlass(settings);
  const color = windowBackgroundColor(glass);
  for (const window of windows) {
    if (window.isDestroyed()) continue;
    // Order matters: dropping the vibrancy first leaves a frame of the old transparent
    // fill, which on a solid theme reads as a flash of the desktop.
    window.setBackgroundColor(color);
    if (process.platform === "darwin") {
      window.setVibrancy(glass ? GLASS_MATERIAL : null);
    }
  }
}
