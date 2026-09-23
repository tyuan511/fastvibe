import { create } from "zustand";
import { applyEngineEvent } from "@/lib/apply-engine-event";
import { i18n } from "@/lib/i18n";
import { useSettingsStore } from "@/stores/settings";
import type { ChangedFile } from "@/lib/changed-files";
import type { ChatMessage, EngineEvent, FilePreview } from "@shared/types";
import type { GitDiffSource } from "@shared/ipc";

export type SidePaneTabType =
  | "git"
  | "terminal"
  | "browser"
  | "selection-side-chat"
  | "files"
  | "plan"
  | "subagent"
  | "changes";

/** Everything needed to mint/re-title a subagent run's tab. */
export type SubagentTabInit = {
  /** The conversation whose tool call spawned the run. */
  conversationId?: string;
  /** Display name; defaults to the run's role. */
  title?: string;
  /** Live run status (`running` / `completed` / `error`). */
  status?: string;
  /**
   * The delegated brief, pinned on the tab.
   *
   * The pane draws it as the run's opening user message. It is stored here — not
   * only read back off `subagents` — because that list is replaced wholesale by
   * every `getSubagents` snapshot: a pane that derived its brief from it blanked
   * (and re-rendered its whole transcript) whenever an entry was momentarily absent.
   */
  brief?: string;
};

export type SidePaneTab = {
  id: string;
  type: SidePaneTabType;
  openedAt: number;
  title: string;
  path?: string;
  preview?: FilePreview;
  cwd?: string;
  sessionId?: string;
  /** Empty for a tab that was opened without a URL: the pane shows a blank page. */
  url?: string;
  faviconUrl?: string | null;
  ordinal?: number;
  parentSessionId?: string;
  conversationId?: string;
  messages?: ChatMessage[];
  streaming?: boolean;
  draft?: string;
  /** The subagent run this tab shows (`type: "subagent"`). */
  subagentId?: string;
  /** The conversation whose tool call spawned that run; scopes the tab. */
  subagentConversationId?: string;
  /** Live status of that run, mirrored into the tab title. */
  subagentStatus?: string;
  /** The delegated brief; the pane renders it as the run's opening user message. */
  subagentBrief?: string;
  /**
   * A file the 审查 tab should select on open, and which diff source to select it in.
   *
   * Set by `openGitDiff` so the pane lands on that file instead of whatever it last
   * showed. Cleared by the pane once honoured, so re-opening the tab later is not
   * yanked back to an old selection.
   */
  gitFocusPath?: string;
  gitFocusSource?: GitDiffSource;
  /**
   * One turn's writes, shown by the 修改记录 tab. The tab is opened only from the
   * transcript's file chips — never from the pane's own menus — and the diffs are
   * the tools' own patches, not the working tree.
   */
  changeFiles?: ChangedFile[];
  changePath?: string;
};

/**
 * One conversation's right-pane state: which tabs it has open, which is active,
 * and how the pane is shown for it. The pane is conversation-bound, so switching
 * chats swaps the whole surface instead of leaking one chat's tabs (and the file
 * preview / terminal / subagent they carry) into another.
 */
export type SidePaneScopeState = {
  tabs: SidePaneTab[];
  activeTabId: string | null;
  /** Right pane fills the shell and the conversation column is hidden. */
  maximized: boolean;
  /** Undefined until the user collapses/expands the pane while this chat is open. */
  collapsed?: boolean;
};

const EMPTY_SCOPE: SidePaneScopeState = { tabs: [], activeTabId: null, maximized: false };

/**
 * Scope for work done before a conversation exists (the greeting hero). It is
 * adopted by the conversation that chat materialises into, so a tab opened before
 * the first prompt is not lost when the conversation row appears.
 */
export const DRAFT_SCOPE = "";

const WIDTH_KEY = "fastvibe.side-pane.width";
const COLLAPSED_KEY = "fastvibe.side-pane.collapsed";
const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 380;

/**
 * Width persisted in `userData/settings.json` (the settings store), with
 * localStorage kept only as a first-paint cache and a migration source: the
 * localStorage origin differs between dev (`localhost`) and packaged (`file://`).
 */
function readWidth(conversationId?: string | null): number {
  const settings = useSettingsStore.getState().settings;
  const own = conversationId ? settings.sidePaneWidths?.[conversationId] : undefined;
  if (typeof own === "number" && Number.isFinite(own)) return Math.max(MIN_WIDTH, Math.round(own));
  const stored = settings.sidePaneWidth;
  if (typeof stored === "number" && Number.isFinite(stored)) return Math.max(MIN_WIDTH, Math.round(stored));
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    if (Number.isFinite(value)) return Math.max(MIN_WIDTH, Math.round(value));
  } catch {
    // ignore
  }
  return DEFAULT_WIDTH;
}

// Promote a legacy localStorage-only width to disk once, when it is first read.
function migrateWidth(): void {
  const store = useSettingsStore.getState();
  if (typeof store.settings.sidePaneWidth === "number") return;
  try {
    const raw = localStorage.getItem(WIDTH_KEY);
    const value = raw ? Number(raw) : NaN;
    if (Number.isFinite(value)) store.update({ sidePaneWidth: Math.max(MIN_WIDTH, Math.round(value)) });
  } catch {
    // ignore
  }
}

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(COLLAPSED_KEY) !== "0";
  } catch {
    return true;
  }
}

function writeCollapsed(collapsed: boolean): void {
  try {
    localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
  } catch {
    // ignore
  }
}

function uid(): string {
  return crypto.randomUUID();
}

function upsert(tabs: SidePaneTab[], tab: SidePaneTab): SidePaneTab[] {
  const index = tabs.findIndex((item) => item.id === tab.id);
  if (index < 0) return [...tabs, tab];
  const next = [...tabs];
  next[index] = { ...next[index], ...tab };
  return next;
}

type SidePaneStore = {
  /** The conversation whose pane the root `tabs` / `activeTabId` mirror. */
  scopeId: string | null;
  /** Pane state per conversation; background chats keep theirs live. */
  scopes: Record<string, SidePaneScopeState>;
  collapsed: boolean;
  maximized: boolean;
  width: number;
  tabs: SidePaneTab[];
  activeTabId: string | null;
  /** Switch the pane onto a conversation (null = the draft chat). */
  setScope: (conversationId: string | null | undefined) => void;
  /**
   * Drop a conversation's pane state — deleted, archived or otherwise gone — and
   * hand back its tabs so the caller can release the resources they hold
   * (terminals, browser views, side chats).
   */
  forgetScope: (conversationId: string) => SidePaneTab[];
  /**
   * Drop deleted conversations' remembered widths. Separate from `forgetScope`,
   * which archiving also runs: a restored chat should reopen at its own width.
   */
  forgetWidths: (conversationIds: string[]) => void;
  setCollapsed: (collapsed: boolean) => void;
  setMaximized: (maximized: boolean) => void;
  toggle: () => void;
  toggleMaximized: () => void;
  /**
   * Record a settled width for the chat on screen: kept per conversation (so a
   * switch restores each chat's own width) and as the default a chat without one
   * opens at. Written to settings.json and the first-paint cache.
   */
  persistWidth: (width: number) => void;
  activate: (id: string) => void;
  /**
   * Close a tab. `collapse` (default `true`) also hides a pane the tab left empty;
   * an internal retire passes `false` so replacing a dead tab in place cannot
   * flash the pane shut around the replacement.
   */
  close: (id: string, options?: { collapse?: boolean }) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  openGit: () => void;
  /**
   * Open 审查 focused on one file's diff, so a caller that already knows the file
   * lands on it instead of the pane's last state.
   */
  openGitDiff: (path: string, source: GitDiffSource, cwd?: string) => void;
  /**
   * Open 修改记录 on one turn's files, focused on `path`. The transcript chips are
   * the only caller: the pane itself has no entry that would mint this tab.
   */
  openTurnChanges: (files: ChangedFile[], path: string) => void;
  openTerminal: (cwd?: string) => void;
  openBrowser: (url?: string, conversationId?: string) => string;
  /** Browser tab ids in one conversation's pane (the active chat when omitted). */
  browserTabIds: (conversationId?: string) => string[];
  openSideChat: (parentSessionId: string, ordinal: number) => void;
  /** Open (or focus) the project file view, starting on the directory tree. */
  openFiles: () => void;
  /**
   * Open (or focus) one subagent run in its own tab. Runs are never merged into a
   * shared pane: two chats delegating at once, or a chain, must stay distinct.
   */
  openSubagent: (subagentId: string, init?: SubagentTabInit) => void;
  /**
   * Ensure a run has its own tab, without focusing it or un-collapsing the pane.
   * Called as each delegated run starts, so every run gets a distinct view; the
   * tool card re-focuses it on demand.
   */
  registerSubagent: (subagentId: string, init?: SubagentTabInit) => void;
  /** Open the file view focused on one file's preview. */
  openFilePreview: (preview: FilePreview, title?: string) => void;
  /** Open a standalone plan document without the project file tree. */
  openPlanPreview: (preview: FilePreview, title: string) => void;
  patchTab: (id: string, patch: Partial<SidePaneTab>) => void;
  applyConversationEvent: (conversationId: string, event: EngineEvent) => void;
  /** Path the active chat's file view is previewing, if any. */
  filesPreviewPath: () => string | undefined;
  nextSideChatOrdinal: (parentSessionId?: string) => number;
  hasReviewTab: () => boolean;
};

/**
 * Side-chat transcripts receive the same per-token stream as the main thread.
 * Coalesce those events into one update at a capped ~30fps cadence, keyed by the
 * pane's conversation, so a running side chat cannot starve the main thread either.
 */
const COALESCED_EVENTS = new Set([
  "message_update",
  "tool_execution_update",
  "tool_execution_start",
  "tool_execution_end",
  "toolcall_start",
  "toolcall_end",
  "subagent_event",
]);

/** Same ~30fps cap as the main transcript (see `stores/session.ts`). */
const STREAM_FLUSH_MS = 32;

/** One tab per subagent run, keyed by run id (`${toolCallId}:${index}`). Runs are
 * never merged into a shared pane: two chats delegating at once, or a chain, must
 * stay distinguishable.
 */
function subagentTabId(subagentId: string): string {
  return `subagent:${subagentId}`;
}

const SUBAGENT_TAB_STATUS: Record<string, string> = {
  running: "tabs.status.running",
  completed: "tabs.status.completed",
  error: "tabs.status.error",
  // A run the user stopped by hand is neither a success nor a failure of the run.
  aborted: "tabs.status.aborted",
};

/** `子 Agent` tab label: role plus live status, e.g. `explorer · 运行中`. */
export function subagentTabLabel(tab: SidePaneTab): string {
  const key = tab.subagentStatus ? SUBAGENT_TAB_STATUS[tab.subagentStatus] : undefined;
  const status = key ? (i18n.t(`sidepane:${key}`) as string) : tab.subagentStatus;
  return status ? `${tab.title} · ${status}` : tab.title;
}

/**
 * The label the tab bar draws for a tab.
 *
 * Singleton tabs (`git` / `terminal` / `browser` / `files` / `changes`) are named by
 * their *type* at render time, so switching 界面语言 renames them without closing
 * anything. A subagent tab keeps the stored role name and appends its live status;
 * a 辅助对话 tab keeps the conversation's own title, which is real data the engine
 * was given when the chat was created.
 */
export function sidePaneTabTitle(tab: SidePaneTab): string {
  if (tab.type === "subagent") return subagentTabLabel(tab);
  if (tab.type === "selection-side-chat") return tab.title;
  if (tab.type === "files" && tab.title !== i18n.t("sidepane:tabs.files")) return tab.title;
  if (tab.type === "plan") return tab.title;
  return i18n.t(`sidepane:tabs.${tab.type}`) as string;
}

/** The single tab that shows one run. */
function upsertSubagentTab(tabs: SidePaneTab[], subagentId: string, init?: SubagentTabInit): SidePaneTab {
  const existing = tabs.find((item) => item.id === subagentTabId(subagentId));
  return {
    ...(existing ?? { id: subagentTabId(subagentId), type: "subagent" as const, openedAt: Date.now() }),
    subagentId,
    subagentConversationId: init?.conversationId ?? existing?.subagentConversationId,
    // The base name stays stable; the tab bar appends the live status at render
    // time (`subagentStatus`), so a re-title from the tool card cannot clobber it.
    title: init?.title || existing?.title || (i18n.t("sidepane:tabs.subagent") as string),
    subagentStatus: init?.status ?? existing?.subagentStatus,
    subagentBrief: init?.brief || existing?.subagentBrief,
  };
}

function scopeKeyOf(state: { scopeId: string | null }): string {
  return state.scopeId ?? DRAFT_SCOPE;
}

function scopeOf(state: { scopeId: string | null; scopes: Record<string, SidePaneScopeState> }): SidePaneScopeState {
  return state.scopes[scopeKeyOf(state)] ?? EMPTY_SCOPE;
}

/**
 * Write one conversation's scope. The root `tabs` / `activeTabId` / `maximized` /
 * `collapsed` fields mirror the *active* scope, so every component that reads the
 * pane keeps working unchanged; a background scope is written silently and picked
 * up when the user switches to it.
 */
function writeScope(
  state: SidePaneStore,
  key: string,
  scope: SidePaneScopeState,
  root?: Partial<SidePaneStore>,
): Partial<SidePaneStore> {
  // The root `collapsed` / `maximized` fields *are* the active scope's. A caller
  // that uncollapses via `{ collapsed: false }` (chip → 修改记录, a new tab, …)
  // must persist that on the scope too: otherwise the next `patchTab` / `close`
  // re-reads the stale `scope.collapsed: true` (left behind when the last tab
  // closed, or when the user collapsed then reopened) and snaps the pane shut
  // while the tab is still there.
  const nextScope =
    root && (root.collapsed !== undefined || root.maximized !== undefined)
      ? {
          ...scope,
          ...(root.collapsed !== undefined ? { collapsed: root.collapsed } : {}),
          ...(root.maximized !== undefined ? { maximized: root.maximized } : {}),
        }
      : scope;
  const scopes = { ...state.scopes, [key]: nextScope };
  if (key !== scopeKeyOf(state)) return { scopes };
  return {
    scopes,
    tabs: nextScope.tabs,
    activeTabId: nextScope.activeTabId,
    maximized: nextScope.maximized,
    collapsed: nextScope.collapsed ?? state.collapsed,
    ...root,
  };
}

/** Bind a subagent tab to the conversation it will live under. */
function stampScope(key: string, init?: SubagentTabInit): SubagentTabInit {
  return { ...init, conversationId: init?.conversationId ?? (key === DRAFT_SCOPE ? undefined : key) };
}

/** The scope that already holds a run's tab, so a stream never mints a duplicate. */
function scopeOwningSubagent(state: SidePaneStore, subagentId: string): string | null {
  for (const [key, scope] of Object.entries(state.scopes)) {
    if (scope.tabs.some((item) => item.subagentId === subagentId)) return key;
  }
  return null;
}

export const useSidePaneStore = create<SidePaneStore>((set, get) => {
  const queued = new Map<string, EngineEvent[]>();
  let timer: number | null = null;
  let lastFlush = 0;

  const clearTimer = (): void => {
    if (timer !== null) {
      window.clearTimeout(timer);
      timer = null;
    }
  };

  /** Fold events into whichever conversation's scope owns the matching tab. */
  const applyEvents = (
    scopes: Record<string, SidePaneScopeState>,
    conversationId: string,
    events: EngineEvent[],
  ): { scopes: Record<string, SidePaneScopeState>; key: string } | null => {
    for (const key of Object.keys(scopes)) {
      const scope = scopes[key];
      const index = scope.tabs.findIndex((item) => item.conversationId === conversationId);
      if (index < 0) continue;
      const tab = scope.tabs[index];
      let messages = tab.messages ?? [];
      let streaming = tab.streaming ?? false;
      for (const event of events) {
        const applied = applyEngineEvent(messages, event, streaming);
        messages = applied.messages;
        streaming = applied.streaming;
      }
      const tabs = scope.tabs.slice();
      tabs[index] = { ...tab, messages, streaming };
      return { scopes: { ...scopes, [key]: { ...scope, tabs } }, key };
    }
    return null;
  };

  const flushQueued = (): void => {
    clearTimer();
    if (queued.size === 0) return;
    lastFlush = Date.now();
    const batch = new Map(queued);
    queued.clear();
    set((state) => {
      let scopes = state.scopes;
      let touched = false;
      for (const [conversationId, events] of batch) {
        const applied = applyEvents(scopes, conversationId, events);
        if (!applied) continue;
        scopes = applied.scopes;
        touched = true;
      }
      if (!touched) return state;
      const active = scopes[scopeKeyOf(state)] ?? EMPTY_SCOPE;
      return {
        scopes,
        tabs: active.tabs,
        activeTabId: active.activeTabId,
        maximized: active.maximized,
      };
    });
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(flushQueued, Math.max(0, STREAM_FLUSH_MS - (Date.now() - lastFlush)));
  };

  return {
  scopeId: null,
  scopes: {},
  collapsed: readCollapsed(),
  maximized: false,
  width: readWidth(),
  tabs: [],
  activeTabId: null,
  setScope: (conversationId) => {
    const nextId = conversationId ?? null;
    const nextKey = nextId ?? DRAFT_SCOPE;
    set((state) => {
      if (scopeKeyOf(state) === nextKey) return state;
      let scopes = state.scopes;
      // The draft pane belongs to the chat that materialises from it: carry the
      // tabs the user opened on the hero into the new conversation's scope.
      if (nextId && scopeKeyOf(state) === DRAFT_SCOPE && !scopes[nextKey] && state.tabs.length > 0) {
        scopes = {
          ...scopes,
          [nextKey]: {
            tabs: state.tabs,
            activeTabId: state.activeTabId,
            maximized: state.maximized,
            collapsed: state.collapsed,
          },
          // Moved, not copied: the draft pane must not keep a second reference to
          // tabs whose terminal/browser a scope drop would then dispose.
          [DRAFT_SCOPE]: EMPTY_SCOPE,
        };
      }
      const scope = scopes[nextKey] ?? EMPTY_SCOPE;
      const hasTabs = scope.tabs.length > 0;
      return {
        scopeId: nextId,
        scopes,
        width: readWidth(nextId),
        tabs: scope.tabs,
        activeTabId: scope.activeTabId,
        maximized: hasTabs ? scope.maximized : false,
        // An explicit choice on this chat wins; otherwise a chat with tabs shows
        // them, while a fresh empty scope starts closed instead of inheriting the
        // previous conversation's visible pane.
        collapsed: scope.collapsed ?? (hasTabs ? false : true),
      };
    });
  },
  forgetWidths: (conversationIds) => {
    const settings = useSettingsStore.getState();
    const widths = settings.settings.sidePaneWidths;
    if (!widths || !conversationIds.some((id) => id in widths)) return;
    const rest = { ...widths };
    for (const id of conversationIds) delete rest[id];
    settings.update({ sidePaneWidths: rest });
  },
  forgetScope: (conversationId) => {
    const dropped = get().scopes[conversationId]?.tabs ?? [];
    if (dropped.length === 0 && !get().scopes[conversationId]) return [];
    set((state) => {
      const scopes = { ...state.scopes };
      delete scopes[conversationId];
      if (scopeKeyOf(state) !== conversationId) return { scopes };
      const fallback = scopes[DRAFT_SCOPE] ?? EMPTY_SCOPE;
      return {
        scopes,
        scopeId: null,
        tabs: fallback.tabs,
        activeTabId: fallback.activeTabId,
        maximized: fallback.maximized,
        collapsed: fallback.tabs.length > 0 ? fallback.collapsed ?? false : true,
      };
    });
    return dropped;
  },
  setCollapsed: (collapsed) => {
    writeCollapsed(collapsed);
    set((state) => {
      const key = scopeKeyOf(state);
      const scope = { ...scopeOf(state), collapsed, maximized: collapsed ? false : scopeOf(state).maximized };
      return writeScope(state, key, scope, { collapsed, maximized: scope.maximized });
    });
  },
  setMaximized: (maximized) =>
    set((state) => {
      const value = maximized && !state.collapsed;
      return writeScope(state, scopeKeyOf(state), { ...scopeOf(state), maximized: value }, { maximized: value });
    }),
  toggle: () => get().setCollapsed(!get().collapsed),
  toggleMaximized: () => {
    if (get().collapsed) get().setCollapsed(false);
    get().setMaximized(!get().maximized);
  },
  persistWidth: (value) => {
    const width = Math.max(MIN_WIDTH, Math.round(value));
    const scopeId = get().scopeId;
    set({ width });
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // ignore
    }
    const settings = useSettingsStore.getState();
    const widths = settings.settings.sidePaneWidths ?? {};
    if (settings.settings.sidePaneWidth === width && (!scopeId || widths[scopeId] === width)) return;
    settings.update({
      sidePaneWidth: width,
      ...(scopeId ? { sidePaneWidths: { ...widths, [scopeId]: width } } : {}),
    });
  },
  activate: (id) =>
    set((state) => writeScope(state, scopeKeyOf(state), { ...scopeOf(state), activeTabId: id }, { collapsed: false })),
  close: (id, options) =>
    set((state) => {
      const collapse = options?.collapse !== false;
      // Browser tabs of a background chat live in that chat's scope; retiring one
      // must not look only at the pane on screen (and must not collapse it).
      const activeKey = scopeKeyOf(state);
      const keys = [activeKey, ...Object.keys(state.scopes).filter((key) => key !== activeKey)];
      for (const key of keys) {
        const scope = key === activeKey ? scopeOf(state) : state.scopes[key];
        if (!scope?.tabs.some((item) => item.id === id)) continue;
        const tabs = scope.tabs.filter((item) => item.id !== id);
        const activeTabId = scope.activeTabId === id ? (tabs.at(-1)?.id ?? null) : scope.activeTabId;
        const empty = tabs.length === 0 && collapse;
        return writeScope(
          state,
          key,
          {
            tabs,
            activeTabId,
            maximized: empty ? false : scope.maximized,
            collapsed: empty ? true : scope.collapsed,
          },
          key === activeKey && empty ? { collapsed: true, maximized: false } : undefined,
        );
      }
      return state;
    }),
  closeOthers: (id) =>
    set((state) => {
      const tabs = scopeOf(state).tabs.filter((item) => item.id === id);
      return writeScope(state, scopeKeyOf(state), {
        ...scopeOf(state),
        tabs,
        activeTabId: tabs[0]?.id ?? null,
      });
    }),
  closeAll: () =>
    set((state) =>
      writeScope(
        state,
        scopeKeyOf(state),
        { tabs: [], activeTabId: null, maximized: false, collapsed: true },
        { collapsed: true, maximized: false },
      ),
    ),
  openGit: () =>
    set((state) => {
      const scope = scopeOf(state);
      const existing = scope.tabs.find((item) => item.type === "git");
      const tab = existing ?? { id: "git", type: "git" as const, openedAt: Date.now(), title: i18n.t("sidepane:tabs.git") as string };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  openGitDiff: (path, source, cwd) =>
    set((state) => {
      const scope = scopeOf(state);
      const existing = scope.tabs.find((item) => item.type === "git");
      const tab: SidePaneTab = {
        ...(existing ?? { id: "git", type: "git" as const, openedAt: Date.now(), title: i18n.t("sidepane:tabs.git") as string }),
        gitFocusPath: path,
        gitFocusSource: source,
        ...(cwd ? { cwd } : {}),
      };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  openTurnChanges: (files, path) =>
    set((state) => {
      const scope = scopeOf(state);
      const existing = scope.tabs.find((item) => item.type === "changes");
      const tab: SidePaneTab = {
        ...(existing ?? {
          id: "changes",
          type: "changes" as const,
          openedAt: Date.now(),
          title: i18n.t("sidepane:tabs.changes") as string,
        }),
        changeFiles: files,
        changePath: path,
      };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  openTerminal: (cwd) =>
    set((state) => {
      const scope = scopeOf(state);
      const tab: SidePaneTab = {
        id: `terminal:${uid()}`,
        type: "terminal",
        openedAt: Date.now(),
        title: i18n.t("sidepane:tabs.terminal") as string,
        cwd,
      };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: [...scope.tabs, tab], activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  openBrowser: (url, conversationId) => {
    let tabId = "";
    set((state) => {
      // A background chat's browser belongs in that chat's pane, the same way a
      // delegated run does: writing to the active scope would flash the current
      // conversation's side pane and then lose the tab on the next scope swap.
      const key = conversationId ?? scopeKeyOf(state);
      const scope = state.scopes[key] ?? EMPTY_SCOPE;
      const existing = url ? undefined : scope.tabs.find((item) => item.type === "browser");
      const focus = key === scopeKeyOf(state) ? { collapsed: false } : undefined;
      if (existing) {
        tabId = existing.id;
        return writeScope(state, key, { ...scope, activeTabId: existing.id, collapsed: false }, focus);
      }
      const tab: SidePaneTab = {
        id: `browser:${uid()}`,
        type: "browser",
        openedAt: Date.now(),
        title: i18n.t("sidepane:tabs.browser") as string,
        // No URL means an empty tab: the pane opens blank and waits for the user.
        url: url?.trim() || "",
        conversationId: key === DRAFT_SCOPE ? undefined : key,
      };
      tabId = tab.id;
      return writeScope(
        state,
        key,
        { ...scope, tabs: [...scope.tabs, tab], activeTabId: tab.id, collapsed: false },
        focus,
      );
    });
    return tabId;
  },
  openSideChat: (parentSessionId, ordinal) =>
    set((state) => {
      if (!parentSessionId) return state;
      const scope = scopeOf(state);
      const tab: SidePaneTab = {
        id: `selection-side-chat:${uid()}`,
        type: "selection-side-chat",
        openedAt: Date.now(),
        title: i18n.t("sidepane:tabs.sideChat", { n: ordinal }) as string,
        ordinal,
        parentSessionId,
        messages: [],
        streaming: false,
        draft: "",
      };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: [...scope.tabs, tab], activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  openFiles: () =>
    set((state) => {
      const scope = scopeOf(state);
      const existing = scope.tabs.find((item) => item.type === "files");
      const tab: SidePaneTab = {
        ...(existing ?? { id: "files", type: "files" as const, openedAt: Date.now() }),
        title: i18n.t("sidepane:tabs.files") as string,
      };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  openSubagent: (subagentId, init) =>
    set((state) => {
      // A run belongs to the conversation that spawned it: focus its tab there even
      // when a background chat's stream is what triggered the open.
      const key = init?.conversationId ?? scopeKeyOf(state);
      const scope = state.scopes[key] ?? EMPTY_SCOPE;
      const tab = upsertSubagentTab(scope.tabs, subagentId, stampScope(key, init));
      return writeScope(
        state,
        key,
        { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id },
        key === scopeKeyOf(state) ? { collapsed: false } : undefined,
      );
    }),
  registerSubagent: (subagentId, init) =>
    set((state) => {
      // A run only gains a tab; it never steals the pane or un-collapses it — that
      // is the tool card's job. Route it to its own conversation's scope so a
      // background run cannot appear in the chat on screen.
      const key = init?.conversationId ?? scopeOwningSubagent(state, subagentId) ?? scopeKeyOf(state);
      const scope = state.scopes[key] ?? EMPTY_SCOPE;
      const tab = upsertSubagentTab(scope.tabs, subagentId, stampScope(key, init));
      const existing = scope.tabs.find((item) => item.id === tab.id);
      if (
        existing &&
        existing.title === tab.title &&
        existing.subagentConversationId === tab.subagentConversationId &&
        existing.subagentStatus === tab.subagentStatus &&
        existing.subagentBrief === tab.subagentBrief
      ) {
        return state;
      }
      return writeScope(state, key, { ...scope, tabs: upsert(scope.tabs, tab) });
    }),
  openPlanPreview: (preview, title) =>
    set((state) => {
      const scope = scopeOf(state);
      const tab: SidePaneTab = {
        id: `plan:${preview.path}`,
        type: "plan",
        openedAt: Date.now(),
        title,
        path: preview.path,
        preview,
      };
      return writeScope(state, scopeKeyOf(state), { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id }, { collapsed: false });
    }),
  openFilePreview: (preview, title) =>
    set((state) => {
      const scope = scopeOf(state);
      const existing = scope.tabs.find((item) => item.type === "files");
      const tab: SidePaneTab = existing
        ? { ...existing, path: preview.path, preview, ...(title ? { title } : {}) }
        : {
            id: "files",
            type: "files",
            openedAt: Date.now(),
            title: title || i18n.t("sidepane:tabs.files") as string,
            path: preview.path,
            preview,
          };
      return writeScope(
        state,
        scopeKeyOf(state),
        { ...scope, tabs: upsert(scope.tabs, tab), activeTabId: tab.id },
        { collapsed: false },
      );
    }),
  patchTab: (id, patch) =>
    set((state) => {
      // `files` / `git` share one id across conversations, so the active scope must
      // win; a background stream patches its own tab by id only as a fallback.
      const activeKey = scopeKeyOf(state);
      const keys = [activeKey, ...Object.keys(state.scopes).filter((key) => key !== activeKey)];
      for (const key of keys) {
        const scope = state.scopes[key];
        if (!scope?.tabs.some((item) => item.id === id)) continue;
        const tabs = scope.tabs.map((item) => (item.id === id ? { ...item, ...patch } : item));
        return writeScope(state, key, { ...scope, tabs });
      }
      return state;
    }),
  applyConversationEvent: (conversationId, event) => {
    if (COALESCED_EVENTS.has(event.type)) {
      const list = queued.get(conversationId);
      if (list) list.push(event);
      else queued.set(conversationId, [event]);
      scheduleFlush();
      return;
    }
    flushQueued();
    set((state) => {
      const applied = applyEvents(state.scopes, conversationId, [event]);
      if (!applied) return state;
      const active = applied.scopes[scopeKeyOf(state)] ?? EMPTY_SCOPE;
      return {
        scopes: applied.scopes,
        tabs: active.tabs,
        activeTabId: active.activeTabId,
        maximized: active.maximized,
      };
    });
  },
  browserTabIds: (conversationId) => {
    const state = get();
    const key = conversationId ?? scopeKeyOf(state);
    const scope = state.scopes[key] ?? (key === scopeKeyOf(state) ? scopeOf(state) : EMPTY_SCOPE);
    return scope.tabs.filter((item) => item.type === "browser").map((item) => item.id);
  },
  filesPreviewPath: () => scopeOf(get()).tabs.find((item) => item.type === "files")?.path,
  nextSideChatOrdinal: (parentSessionId?: string) => {
    const ordinals = scopeOf(get())
      .tabs.filter(
        (item) =>
          item.type === "selection-side-chat" && (!parentSessionId || item.parentSessionId === parentSessionId),
      )
      .map((item) => item.ordinal ?? 0);
    return (ordinals.length ? Math.max(...ordinals) : 0) + 1;
  },
  hasReviewTab: () => scopeOf(get()).tabs.some((item) => item.type === "git"),
  };
});

migrateWidth();

export { MIN_WIDTH };
