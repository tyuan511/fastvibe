import { existsSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { nativeTheme, type BrowserWindow } from "electron";
import type { FastVibePaths } from "./paths";

const VERSION = 1;

type SettingsFile = {
  version: number;
  settings: Record<string, unknown>;
};

/** Loose bag of renderer UI prefs. Main never interprets the keys besides themeMode. */
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

export function windowBackgroundColor(): string {
  return nativeTheme.shouldUseDarkColors ? "#0d1117" : "#ffffff";
}

export function paintWindows(windows: Iterable<BrowserWindow>): void {
  const color = windowBackgroundColor();
  for (const window of windows) window.setBackgroundColor(color);
}
