import { create } from "zustand";
import { applyEngineEvent } from "@/lib/apply-engine-event";
import { useSettingsStore } from "@/stores/settings";
import type { ChatMessage, EngineEvent, FilePreview } from "@shared/types";

export type SidePaneTabType = "git" | "terminal" | "browser" | "selection-side-chat" | "files";

export type SidePaneTab = {
  id: string;
  type: SidePaneTabType;
  openedAt: number;
  title: string;
  path?: string;
  preview?: FilePreview;
  cwd?: string;
  sessionId?: string;
  url?: string;
  faviconUrl?: string | null;
  ordinal?: number;
  parentSessionId?: string;
  conversationId?: string;
  messages?: ChatMessage[];
  streaming?: boolean;
  draft?: string;
};

const WIDTH_KEY = "fastvibe.side-pane.width";
const COLLAPSED_KEY = "fastvibe.side-pane.collapsed";
const MIN_WIDTH = 280;
const DEFAULT_WIDTH = 380;

/**
 * Width persisted in `userData/settings.json` (the settings store), with
 * localStorage kept only as a first-paint cache and a migration source: the
 * localStorage origin differs between dev (`localhost`) and packaged (`file://`).
 */
function readWidth(): number {
  const stored = useSettingsStore.getState().settings.sidePaneWidth;
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
  collapsed: boolean;
  /** Right pane fills the shell and the conversation column is hidden. */
  maximized: boolean;
  width: number;
  tabs: SidePaneTab[];
  activeTabId: string | null;
  setCollapsed: (collapsed: boolean) => void;
  setMaximized: (maximized: boolean) => void;
  toggle: () => void;
  toggleMaximized: () => void;
  /** Live width while dragging; call `persistWidth` when the drag ends. */
  setWidth: (width: number) => void;
  /** Write the current width to settings.json and the first-paint cache. */
  persistWidth: () => void;
  activate: (id: string) => void;
  close: (id: string) => void;
  closeOthers: (id: string) => void;
  closeAll: () => void;
  openGit: () => void;
  openTerminal: (cwd?: string) => void;
  openBrowser: (url?: string) => string;
  openSideChat: (parentSessionId: string, ordinal: number) => void;
  /** Open (or focus) the project file view, starting on the directory tree. */
  openFiles: () => void;
  /** Open the file view focused on one file's preview. */
  openFilePreview: (preview: FilePreview) => void;
  patchTab: (id: string, patch: Partial<SidePaneTab>) => void;
  applyConversationEvent: (conversationId: string, event: EngineEvent) => void;
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

  const flushQueued = (): void => {
    clearTimer();
    if (queued.size === 0) return;
    lastFlush = Date.now();
    const batch = new Map(queued);
    queued.clear();
    set((state) => {
      let tabs = state.tabs;
      for (const [conversationId, events] of batch) {
        const index = tabs.findIndex((item) => item.conversationId === conversationId);
        if (index < 0) continue;
        const tab = tabs[index];
        let messages = tab.messages ?? [];
        let streaming = tab.streaming ?? false;
        for (const event of events) {
          const applied = applyEngineEvent(messages, event, streaming);
          messages = applied.messages;
          streaming = applied.streaming;
        }
        tabs = tabs.slice();
        tabs[index] = { ...tab, messages, streaming };
      }
      return tabs === state.tabs ? state : { tabs };
    });
  };

  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(flushQueued, Math.max(0, STREAM_FLUSH_MS - (Date.now() - lastFlush)));
  };

  return {
  collapsed: readCollapsed(),
  maximized: false,
  width: readWidth(),
  tabs: [],
  activeTabId: null,
  setCollapsed: (collapsed) => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
    set({ collapsed, maximized: collapsed ? false : get().maximized });
  },
  setMaximized: (maximized) => set({ maximized: maximized && !get().collapsed }),
  toggle: () => get().setCollapsed(!get().collapsed),
  toggleMaximized: () => {
    if (get().collapsed) get().setCollapsed(false);
    get().setMaximized(!get().maximized);
  },
  setWidth: (width) => set({ width: Math.max(MIN_WIDTH, Math.round(width)) }),
  persistWidth: () => {
    const width = get().width;
    try {
      localStorage.setItem(WIDTH_KEY, String(width));
    } catch {
      // ignore
    }
    useSettingsStore.getState().update({ sidePaneWidth: width });
  },
  activate: (id) => set({ activeTabId: id, collapsed: false }),
  close: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((item) => item.id !== id);
      const activeTabId =
        state.activeTabId === id ? (tabs.at(-1)?.id ?? null) : state.activeTabId;
      return { tabs, activeTabId, collapsed: tabs.length === 0 ? true : state.collapsed, maximized: tabs.length === 0 ? false : state.maximized };
    }),
  closeOthers: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((item) => item.id === id);
      return { tabs, activeTabId: tabs[0]?.id ?? null };
    }),
  closeAll: () => set({ tabs: [], activeTabId: null, collapsed: true, maximized: false }),
  openGit: () =>
    set((state) => {
      const existing = state.tabs.find((item) => item.type === "git");
      const tab = existing ?? { id: "git", type: "git", openedAt: Date.now(), title: "审查" };
      return { tabs: upsert(state.tabs, tab), activeTabId: tab.id, collapsed: false };
    }),
  openTerminal: (cwd) =>
    set((state) => {
      const tab: SidePaneTab = {
        id: `terminal:${uid()}`,
        type: "terminal",
        openedAt: Date.now(),
        title: "终端",
        cwd,
      };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id, collapsed: false };
    }),
  openBrowser: (url) => {
    let tabId = "";
    set((state) => {
      const existing = state.tabs.find((item) => item.type === "browser" && !url);
      if (existing && !url) {
        tabId = existing.id;
        return { activeTabId: existing.id, collapsed: false };
      }
      const tab: SidePaneTab = {
        id: `browser:${uid()}`,
        type: "browser",
        openedAt: Date.now(),
        title: "浏览器",
        url: url?.trim() || "https://fastvibe.dev",
      };
      tabId = tab.id;
      return { tabs: [...state.tabs, tab], activeTabId: tab.id, collapsed: false };
    });
    return tabId;
  },
  openSideChat: (parentSessionId, ordinal) =>
    set((state) => {
      if (!parentSessionId) return state;
      const tab: SidePaneTab = {
        id: `selection-side-chat:${uid()}`,
        type: "selection-side-chat",
        openedAt: Date.now(),
        title: `辅助对话 ${ordinal}`,
        ordinal,
        parentSessionId,
        messages: [],
        streaming: false,
        draft: "",
      };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id, collapsed: false };
    }),
  openFiles: () =>
    set((state) => {
      const existing = state.tabs.find((item) => item.type === "files");
      const tab: SidePaneTab =
        existing ?? { id: "files", type: "files", openedAt: Date.now(), title: "文件" };
      return { tabs: upsert(state.tabs, tab), activeTabId: tab.id, collapsed: false };
    }),
  openFilePreview: (preview) =>
    set((state) => {
      const existing = state.tabs.find((item) => item.type === "files");
      const tab: SidePaneTab = existing
        ? { ...existing, path: preview.path, preview }
        : {
            id: "files",
            type: "files",
            openedAt: Date.now(),
            title: "文件",
            path: preview.path,
            preview,
          };
      return { tabs: upsert(state.tabs, tab), activeTabId: tab.id, collapsed: false };
    }),
  patchTab: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
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
      const tab = state.tabs.find((item) => item.conversationId === conversationId);
      if (!tab) return state;
      const applied = applyEngineEvent(tab.messages ?? [], event, tab.streaming ?? false);
      return {
        tabs: state.tabs.map((item) =>
          item.id === tab.id
            ? { ...item, messages: applied.messages, streaming: applied.streaming }
            : item,
        ),
      };
    });
  },
  nextSideChatOrdinal: (parentSessionId?: string) => {
    const ordinals = get()
      .tabs.filter(
        (item) =>
          item.type === "selection-side-chat" && (!parentSessionId || item.parentSessionId === parentSessionId),
      )
      .map((item) => item.ordinal ?? 0);
    return (ordinals.length ? Math.max(...ordinals) : 0) + 1;
  },
  hasReviewTab: () => get().tabs.some((item) => item.type === "git"),
  };
});

migrateWidth();

export { MIN_WIDTH };
