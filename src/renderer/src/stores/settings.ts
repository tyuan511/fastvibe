import { create } from "zustand";
import type { PermissionMode, QueueBehavior, RunMode, ThinkingLevel } from "@shared/types";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME_MODE,
  isThemeId,
  isThemeMode,
  type ThemeId,
  type ThemeMode,
} from "@/lib/themes";

const KEY = "fastvibe.settings";

export type AppSettings = {
  runMode: RunMode;
  permissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel | "auto";
  queueBehavior: QueueBehavior;
  autoCompact: boolean;
  interruptMode: "immediate" | "wait";
  showThinking: boolean;
  showTimestamps: boolean;
  compactCode: boolean;
  sendOnEnter: boolean;
  /** Whether the active theme follows the OS or is pinned light/dark. */
  themeMode: ThemeMode;
  /** Theme used while in light mode. */
  lightTheme: ThemeId;
  /** Theme used while in dark mode. */
  darkTheme: ThemeId;
  /**
   * Workspace sidebar width in px. Absent until the user resizes, so an older
   * install can still migrate its localStorage-only value.
   */
  sidebarWidth?: number;
  /** Right-hand side pane width in px; same lifecycle as `sidebarWidth`. */
  sidePaneWidth?: number;
};

const DEFAULTS: AppSettings = {
  runMode: "agent",
  permissionMode: "full",
  thinkingLevel: "auto",
  queueBehavior: "followUp",
  autoCompact: true,
  interruptMode: "immediate",
  showThinking: true,
  showTimestamps: true,
  compactCode: false,
  sendOnEnter: true,
  themeMode: DEFAULT_THEME_MODE,
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
};

/** Drop malformed persisted theme values so a stale id can never crash the app. */
function sanitize(parsed: Partial<AppSettings>): Partial<AppSettings> {
  const next = { ...parsed };
  if (!isThemeMode(next.themeMode)) delete next.themeMode;
  if (!isThemeId(next.lightTheme)) delete next.lightTheme;
  if (!isThemeId(next.darkTheme)) delete next.darkTheme;
  if (!isFiniteNumber(next.sidebarWidth)) delete next.sidebarWidth;
  if (!isFiniteNumber(next.sidePaneWidth)) delete next.sidePaneWidth;
  return next;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function peekLocal(): Partial<AppSettings> {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return {};
    return sanitize(JSON.parse(raw) as Partial<AppSettings>);
  } catch {
    return {};
  }
}

function peekDisk(): Partial<AppSettings> {
  try {
    const raw = window.fastvibe?.settings?.initial;
    if (!raw || typeof raw !== "object") return {};
    return sanitize(raw as Partial<AppSettings>);
  } catch {
    return {};
  }
}

function writeLocal(settings: AppSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    // ignore quota / private-mode errors
  }
}

function writeDisk(settings: AppSettings): void {
  void window.fastvibe?.settings?.save(settings).catch(() => undefined);
}

/**
 * Disk (`userData/settings.json`) is the source of truth so preferences survive
 * Electron origin changes (dev `localhost` vs packaged `file://`). localStorage
 * is a first-paint cache and a migration source for older installs.
 */
function read(): AppSettings {
  return { ...DEFAULTS, ...peekLocal(), ...peekDisk() };
}

type SettingsStore = {
  settings: AppSettings;
  update: (patch: Partial<AppSettings>) => void;
  reset: () => void;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: read(),
  update: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      writeLocal(next);
      writeDisk(next);
      return { settings: next };
    }),
  reset: () => {
    try {
      localStorage.removeItem(KEY);
    } catch {
      // ignore
    }
    void window.fastvibe?.settings?.clear().catch(() => undefined);
    set({ settings: DEFAULTS });
  },
}));

// First launch after this change: copy whatever localStorage had onto disk.
if (typeof window !== "undefined" && window.fastvibe?.settings) {
  const disk = window.fastvibe.settings.initial;
  if (!disk || Object.keys(disk).length === 0) {
    writeDisk(useSettingsStore.getState().settings);
  }
}
