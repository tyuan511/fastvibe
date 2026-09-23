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
import { NOTIFICATION_SETTINGS } from "@shared/types";
import { detectSystemLanguage, isUiLanguage, type UiLanguage } from "@/lib/language";
import { sanitizeShortcutOverrides, type ShortcutOverrides } from "@/lib/shortcuts";

import { DEFAULT_PROXY_SETTINGS, proxySettingsOf, type ProxySettings } from "@shared/proxy";

const KEY = "fastvibe.settings";

export type AppSettings = ProxySettings & {
  /** The mode the sandbox enforces now. Every picker persists it as the startup mode too. */
  permissionMode: PermissionMode;
  /** 默认权限模式: kept in sync with `permissionMode` by every permission picker. */
  defaultPermissionMode: PermissionMode;
  /** Whether the machine-wide risk warning for 完全访问 has already been accepted. */
  fullAccessConfirmed: boolean;
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
   * 系统通知: one switch per scenario (设置 → 通用). Flat keys, because `settings.json`
   * is a flat bag Main reads one preference at a time, and **on** when absent — the
   * user has to turn a notice off, never on.
   *
   * `notifyDone` is an ordinary finish, `notifyError` a run that settled on an error,
   * `notifyApproval` a background chat parked on a question, `notifyUpdate` a downloaded
   * update. They are separate because they answer different questions: someone who works
   * in a terminal all day wants to know a chat *cannot* proceed without them and may not
   * care that a run finished, and a failed run is worth saying out loud even when an
   * ordinary one is not.
   */
  notifyDone: boolean;
  notifyError: boolean;
  notifyApproval: boolean;
  notifyUpdate: boolean;
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
  /** Extra instructions appended to the default system prompt on every turn. */
  customSystemPrompt: string;
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
  /**
   * 始终允许 rules: prompts the user has said yes to for good, as `method:title:message`
   * keys. Shared by every conversation and persisted, so an approval made in one chat
   * is not asked for again in the next (see `lib/permission-rules.ts`).
   */
  permissionAlways?: string[];
  /**
   * 电脑操控 (设置 → 电脑操控). Mirrors `ComputerSettings`; kept as flat keys because
   * `settings.json` is a flat bag that Main reads one preference at a time.
   */
  computerEnabled: boolean;
  computerClipboard: boolean;
  computerPreferBackground: boolean;
  /**
   * Apps whose windows skip the tool confirmation.
   *
   * `id` is the identity that is matched — a bundle id where the platform has one,
   * otherwise the executable name. `name` rides along purely so the list can be read by
   * a human; matching never looks at it, because a display name is not an identity and
   * two applications can share one.
   */
  computerAllowedApps?: Array<{ id: string; name: string }>;
  sidebarOrder?: Record<string, string[]>;
  /**
   * Shortcut overrides keyed by command id. Absent keys keep the catalog default;
   * `null` unbinds. Only deviations are stored so a later default change still lands.
   */
  shortcuts?: ShortcutOverrides;
};

const DEFAULTS: AppSettings = {
  ...DEFAULT_PROXY_SETTINGS,
  permissionMode: "smart",
  defaultPermissionMode: "smart",
  fullAccessConfirmed: false,
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
  customSystemPrompt: "",
  themeMode: DEFAULT_THEME_MODE,
  lightTheme: DEFAULT_LIGHT_THEME,
  darkTheme: DEFAULT_DARK_THEME,
  uiFontSize: DEFAULT_UI_FONT_SIZE,
  autoCheckUpdates: true,
  // 系统通知 (设置 → 通用): every scenario on, so a fresh install is not a silent one.
  notifyDone: true,
  notifyError: true,
  notifyApproval: true,
  notifyUpdate: true,
  // Off until the user turns it on. Driving the desktop is not something an app should
  // start doing because it was installed — unlike every other default here, the cost of
  // guessing wrong is an action taken in someone else's application.
  computerEnabled: false,
  computerClipboard: false,
  computerPreferBackground: true,
};

/** Drop malformed persisted theme values so a stale id can never crash the app. */
function sanitize(parsed: Partial<AppSettings>): Partial<AppSettings> {
  const next = { ...parsed };
  if (Object.keys(DEFAULT_PROXY_SETTINGS).some((key) => key in parsed)) {
    Object.assign(next, proxySettingsOf(parsed));
  }
  if (!isPermissionMode(next.permissionMode)) delete next.permissionMode;
  if (!isPermissionMode(next.defaultPermissionMode)) delete next.defaultPermissionMode;
  if (typeof next.fullAccessConfirmed !== "boolean") delete next.fullAccessConfirmed;
  if (!isUiLanguage(next.uiLanguage)) delete next.uiLanguage;
  if (!isUiLanguage(next.aiLanguage)) delete next.aiLanguage;
  if (typeof next.customSystemPrompt !== "string") delete next.customSystemPrompt;
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
  if (!isIdList(next.permissionAlways)) delete next.permissionAlways;
  if (typeof next.computerEnabled !== "boolean") delete next.computerEnabled;
  if (typeof next.computerClipboard !== "boolean") delete next.computerClipboard;
  if (typeof next.computerPreferBackground !== "boolean") delete next.computerPreferBackground;
  if (!isAllowedAppList(next.computerAllowedApps)) delete next.computerAllowedApps;
  if (!isIdListMap(next.sidebarOrder)) delete next.sidebarOrder;
  if (typeof next.autoCheckUpdates !== "boolean") delete next.autoCheckUpdates;
  // A malformed switch drops, which reads back as the default — on. `notifications` is
  // the three-valued key this replaced, and a stale one is dropped rather than migrated:
  // every one of its values is the new default's superset.
  for (const key of NOTIFICATION_SETTINGS) {
    if (typeof next[key] !== "boolean") delete next[key];
  }
  delete (next as Record<string, unknown>).notifications;
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

/** 始终允许的应用 entries; one malformed pair drops the whole list, as elsewhere here. */
function isAllowedAppList(value: unknown): value is Array<{ id: string; name: string }> {
  return (
    Array.isArray(value) &&
    value.every(
      (item) =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as { id?: unknown }).id === "string" &&
        typeof (item as { name?: unknown }).name === "string",
    )
  );
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

// Serialize writes so a concurrent preference change cannot restore an old proxy.
let pendingWrite: Promise<unknown> = Promise.resolve();
let resetGeneration = 0;
function persist(task: () => Promise<unknown>): Promise<void> {
  const result = pendingWrite.then(task).then(() => undefined);
  pendingWrite = result.catch(() => undefined);
  return result;
}

function writeDisk(): void {
  void persist(() => window.fastvibe.settings.save(useSettingsStore.getState().settings)).catch(() => undefined);
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
  const merged = { ...defaults, ...local, ...disk };
  // Before the one-time warning existed, selecting full access was already an explicit
  // grant. Preserve that grant across the migration rather than asking an existing user.
  if (
    local.fullAccessConfirmed === undefined &&
    disk.fullAccessConfirmed === undefined &&
    (merged.permissionMode === "full" || merged.defaultPermissionMode === "full")
  ) {
    merged.fullAccessConfirmed = true;
  }
  return merged;
}

function firstRunLanguages(): Pick<AppSettings, "uiLanguage" | "aiLanguage"> {
  const system = detectSystemLanguage();
  return { uiLanguage: system, aiLanguage: system };
}

type SettingsStore = {
  settings: AppSettings;
  resetVersion: number;
  update: (patch: Partial<AppSettings>) => void;
  /** Commit proxy preferences only after Main successfully applies them. */
  saveProxy: (patch: ProxySettings) => Promise<void>;
  /**
   * Adopt preferences another window wrote. Deliberately does **not** write back:
   * the file already holds them, and echoing would make two windows sync forever.
   */
  applyRemote: (settings: Record<string, unknown>) => void;
  reset: () => Promise<void>;
};

export const useSettingsStore = create<SettingsStore>((set) => ({
  settings: read(),
  resetVersion: 0,
  update: (patch) =>
    set((state) => {
      const next = { ...state.settings, ...patch };
      writeLocal(next);
      writeDisk();
      return { settings: next };
    }),
  saveProxy: (patch) => {
    const generation = resetGeneration;
    return persist(async () => {
      if (generation !== resetGeneration) return;
      await window.fastvibe.settings.saveProxy(patch);
      // Reflect an acknowledged save even if a reset is queued: the reset can fail.
      useSettingsStore.getState().applyRemote({ ...useSettingsStore.getState().settings, ...patch });
    });
  },
  applyRemote: (remote) =>
    set(() => {
      const next = { ...DEFAULTS, ...sanitize(remote as Partial<AppSettings>) } as AppSettings;
      writeLocal(next);
      return { settings: next };
    }),
  reset: () => {
    resetGeneration += 1;
    return persist(async () => {
      const before = useSettingsStore.getState().settings;
      await window.fastvibe.settings.clear();
      // Preserve preference changes made after reset was requested.
      const after = useSettingsStore.getState().settings;
      const changed = Object.fromEntries(Object.entries(after).filter(([key, value]) => value !== before[key as keyof AppSettings]));
      const next = { ...DEFAULTS, ...changed };
      writeLocal(next);
      set((state) => ({ settings: next, resetVersion: state.resetVersion + 1 }));
    });
  },
}));

// First launch after this change: copy whatever localStorage had onto disk.
if (typeof window !== "undefined" && window.fastvibe?.settings) {
  const disk = window.fastvibe.settings.initial;
  if (!disk || Object.keys(disk).length === 0) {
    writeDisk();
  }
}
