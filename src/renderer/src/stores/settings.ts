import { create } from "zustand";
import { THINKING_EFFORT_LEVELS, type EngineModel, type PermissionMode, type QueueBehavior, type ThinkingLevel } from "@shared/types";
import {
  DEFAULT_DARK_THEME,
  DEFAULT_LIGHT_THEME,
  DEFAULT_THEME_MODE,
  DEFAULT_UI_FONT_SIZE,
  isThemeId,
  isThemeMode,
  type ThemeId,
  type ThemeMode,
} from "@/lib/themes";
import { isPermissionMode } from "@/lib/permission-modes";
import { detectSystemLanguage, isUiLanguage, type UiLanguage } from "@/lib/language";
import { sanitizeShortcutOverrides, type ShortcutOverrides } from "@/lib/shortcuts";

const KEY = "fastvibe.settings";

export type AppSettings = {
  /**
   * The mode the sandbox enforces right now; the composer's chip is its view. Written
   * by the composer, and re-seeded from `defaultPermissionMode` by Main on every launch
   * (`applyStartupPermissionMode`) so an escalated session does not outlive the app.
   */
  permissionMode: PermissionMode;
  /**
   * 默认权限模式: what a launch starts on (设置 → 通用 → 默认权限模式). Separate from the
   * live mode so escalating one run to 完全访问 in the composer cannot silently carry
   * over to the next launch.
   */
  defaultPermissionMode: PermissionMode;
  thinkingLevel: ThinkingLevel | "auto";
  queueBehavior: QueueBehavior;
  autoCompact: boolean;
  interruptMode: "immediate" | "wait";
  showThinking: boolean;
  showTimestamps: boolean;
  /**
   * 折叠运行过程: fold each reply's process (thinking, tools, intermediate prose)
   * into one 「用时 …」 block, leaving only the final summary text on screen.
   */
  collapseRuns: boolean;
  /** When true, an agent run holds the machine awake (`powerSaveBlocker`). */
  keepAwake: boolean;
  compactCode: boolean;
  sendOnEnter: boolean;
  /** When true, the packaged app checks for updates after launch. */
  autoCheckUpdates: boolean;
  /**
   * Provider/model a brand-new conversation starts on. Persisted like every other
   * preference and read by the engine when it creates a session — the SDK's own
   * `defaultProvider`/`defaultModel` keys cannot hold it, because `setModel`
   * rewrites them to the last used model on every switch.
   */
  defaultModel?: EngineModel;
  /**
   * 界面语言: the language every string in the app is rendered in. Applied through
   * react-i18next (`lib/i18n.ts`); changing it re-renders the tree and writes
   * `FASTVIBE_UI_LANGUAGE` so Main and the built-in extensions follow along.
   */
  uiLanguage: UiLanguage;
  /**
   * AI 偏好语言: appended to the system prompt on every turn by the built-in
   * `output-language` extension, so the model answers in this language no matter
   * which one the user typed in. Independent of `uiLanguage` on purpose.
   */
  aiLanguage: UiLanguage;
  /** Whether the active theme follows the OS or is pinned light/dark. */
  themeMode: ThemeMode;
  /** Theme used while in light mode. */
  lightTheme: ThemeId;
  /** Theme used while in dark mode. */
  darkTheme: ThemeId;
  /**
   * 界面字号: the root font size in px (default 16). Body text (`text-sm`) renders
   * at 14px there; every other rem-based size scales with it — see `applyUiFontSize`.
   */
  uiFontSize: number;
  /**
   * Workspace sidebar width in px. Absent until the user resizes, so an older
   * install can still migrate its localStorage-only value.
   */
  sidebarWidth?: number;
  /**
   * Whether the workspace sidebar is collapsed. Set when the user drags the
   * splitter below the minimum width (or presses the header toggle), so the
   * collapsed state survives a restart.
   */
  sidebarCollapsed?: boolean;
  /** Right-hand side pane width in px; same lifecycle as `sidebarWidth`. */
  sidePaneWidth?: number;
  /**
   * Conversations the user archived, in archive order. Archived chats are hidden
   * from the sidebar and managed from Settings → 归档对话. Persisted with the other
   * preferences so the list survives the dev/packaged origin switch; older builds
   * kept it in localStorage and are migrated once in `stores/archive.ts`.
   */
  archivedConversations?: string[];
  /**
   * Manually dragged sidebar order, keyed by section (`pinned`, `recent`, or
   * `project:<cwd>`). Each value is that section's own id list, so reordering one
   * project never disturbs 置顶, 聊天 or another project. A conversation missing
   * from its section's list keeps the section's default position (creation order,
   * or pin time for 置顶).
   */
  sidebarOrder?: Record<string, string[]>;
  /**
   * Shortcut overrides keyed by command id. Absent keys keep the catalog default;
   * `null` unbinds. Only deviations are stored so a later default change still lands.
   */
  shortcuts?: ShortcutOverrides;
};

const DEFAULTS: AppSettings = {
  permissionMode: "smart",
  defaultPermissionMode: "smart",
  thinkingLevel: "auto",
  queueBehavior: "followUp",
  autoCompact: true,
  interruptMode: "immediate",
  showThinking: true,
  showTimestamps: true,
  collapseRuns: true,
  keepAwake: true,
  compactCode: false,
  sendOnEnter: true,
  uiLanguage: "zh",
  aiLanguage: "zh",
  themeMode: DEFAULT_THEME_MODE,
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  autoCheckUpdates: true,
};

/** Drop malformed persisted theme values so a stale id can never crash the app. */
function sanitize(parsed: Partial<AppSettings>): Partial<AppSettings> {
  const next = { ...parsed };
  if (!isPermissionMode(next.permissionMode)) delete next.permissionMode;
  if (!isPermissionMode(next.defaultPermissionMode)) delete next.defaultPermissionMode;
  if (!isUiLanguage(next.uiLanguage)) delete next.uiLanguage;
  if (!isUiLanguage(next.aiLanguage)) delete next.aiLanguage;
  if (!isThemeMode(next.themeMode)) delete next.themeMode;
  if (!isThemeId(next.lightTheme)) delete next.lightTheme;
  if (!isThemeId(next.darkTheme)) delete next.darkTheme;
  if (!isFontSize(next.uiFontSize)) delete next.uiFontSize;
  if (!isThinkingLevel(next.thinkingLevel)) delete next.thinkingLevel;
  if (!isEngineModel(next.defaultModel)) delete next.defaultModel;
  if (!isFiniteNumber(next.sidebarWidth)) delete next.sidebarWidth;
  if (typeof next.sidebarCollapsed !== "boolean") delete next.sidebarCollapsed;
  if (!isFiniteNumber(next.sidePaneWidth)) delete next.sidePaneWidth;
  if (!isIdList(next.archivedConversations)) delete next.archivedConversations;
  if (!isIdListMap(next.sidebarOrder)) delete next.sidebarOrder;
  if (typeof next.autoCheckUpdates !== "boolean") delete next.autoCheckUpdates;
  if (typeof next.keepAwake !== "boolean") delete next.keepAwake;
  if (typeof next.collapseRuns !== "boolean") delete next.collapseRuns;
  const shortcuts = sanitizeShortcutOverrides(next.shortcuts);
  if (shortcuts) next.shortcuts = shortcuts;
  else delete next.shortcuts;
  return next;
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

/** Accept 12–20 px, the range the 界面字号 picker offers; anything else resets. */
function isFontSize(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 12 && value <= 20;
}

/**
 * A level the engine cannot request would be clamped to `off`, so it never persists.
 * `off` itself is rejected: a setting saved before 关闭推理 was dropped as an option
 * would otherwise keep sending a parameter some models 400 on, so it resets to the
 * default (跟随模型默认).
 */
function isThinkingLevel(value: unknown): value is ThinkingLevel | "auto" {
  return value === "auto" || (typeof value === "string" && (THINKING_EFFORT_LEVELS as readonly string[]).includes(value));
}

function isIdList(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

/** Section-keyed id lists (`sidebarOrder`); any malformed entry drops the whole map. */
function isIdListMap(value: unknown): value is Record<string, string[]> {
  return (
    typeof value === "object" &&
    value !== null &&
    !Array.isArray(value) &&
    Object.values(value).every(isIdList)
  );
}

/** A half-written `defaultModel` must never reach the engine's model lookup. */
function isEngineModel(value: unknown): value is EngineModel {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Partial<EngineModel>;
  return Boolean(candidate.provider) && Boolean(candidate.id);
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
 *
 * An install that already has settings predates 语言 and keeps 中文 — flipping an
 * existing user's interface language on upgrade would be a surprise. Only a
 * brand-new install follows the OS locale.
 */
function read(): AppSettings {
  const local = peekLocal();
  const disk = peekDisk();
  const existing = Object.keys(local).length > 0 || Object.keys(disk).length > 0;
  const defaults = existing ? DEFAULTS : { ...DEFAULTS, ...firstRunLanguages() };
  return { ...defaults, ...local, ...disk };
}

function firstRunLanguages(): Pick<AppSettings, "uiLanguage" | "aiLanguage"> {
  const system = detectSystemLanguage();
  return { uiLanguage: system, aiLanguage: system };
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
