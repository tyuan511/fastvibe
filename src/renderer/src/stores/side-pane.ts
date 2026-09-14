import { create } from "zustand";
import { applyEngineEvent } from "@/lib/apply-engine-event";
import { useSettingsStore } from "@/stores/settings";
import type { ChatMessage, EngineEvent, FilePreview } from "@shared/types";

export type SidePaneTabType = "git" | "terminal" | "browser" | "selection-side-chat" | "code-viewer";

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
  ordinal?: number;
  parentSessionId?: string;
  conversationId?: string;
  messages?: ChatMessage[];
  streaming?: boolean;
  draft?: string;
};

const WIDTH_KEY = "fastvibe.side-pane.width";
const COLLAPSED_KEY = "fastvibe.side-pane.collapsed";
const MIN_WIDTH = 240;
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
  width: number;
  tabs: SidePaneTab[];
  activeTabId: string | null;
  setCollapsed: (collapsed: boolean) => void;
  toggle: () => void;
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
  openBrowser: (url?: string) => void;
  openSideChat: (parentSessionId: string, ordinal: number) => void;
  openCodeViewer: (preview: FilePreview) => void;
  patchTab: (id: string, patch: Partial<SidePaneTab>) => void;
  applyConversationEvent: (conversationId: string, event: EngineEvent) => void;
  nextSideChatOrdinal: (parentSessionId?: string) => number;
  hasReviewTab: () => boolean;
};

export const useSidePaneStore = create<SidePaneStore>((set, get) => ({
  collapsed: readCollapsed(),
  width: readWidth(),
  tabs: [],
  activeTabId: null,
  setCollapsed: (collapsed) => {
    try {
      localStorage.setItem(COLLAPSED_KEY, collapsed ? "1" : "0");
    } catch {
      // ignore
    }
    set({ collapsed });
  },
  toggle: () => get().setCollapsed(!get().collapsed),
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
      return { tabs, activeTabId, collapsed: tabs.length === 0 ? state.collapsed : state.collapsed };
    }),
  closeOthers: (id) =>
    set((state) => {
      const tabs = state.tabs.filter((item) => item.id === id);
      return { tabs, activeTabId: tabs[0]?.id ?? null };
    }),
  closeAll: () => set({ tabs: [], activeTabId: null }),
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
  openBrowser: (url) =>
    set((state) => {
      const existing = state.tabs.find((item) => item.type === "browser" && !url);
      if (existing && !url) {
        return { activeTabId: existing.id, collapsed: false };
      }
      const tab: SidePaneTab = {
        id: `browser:${uid()}`,
        type: "browser",
        openedAt: Date.now(),
        title: "浏览器",
        url: url?.trim() || "https://fastvibe.dev",
      };
      return { tabs: [...state.tabs, tab], activeTabId: tab.id, collapsed: false };
    }),
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
  openCodeViewer: (preview) =>
    set((state) => {
      const existing = state.tabs.find((item) => item.type === "code-viewer" && item.path === preview.path);
      const tab: SidePaneTab = {
        id: existing?.id ?? `code-viewer:${preview.path}`,
        type: "code-viewer",
        openedAt: existing?.openedAt ?? Date.now(),
        title: preview.name,
        path: preview.path,
        preview,
      };
      return { tabs: upsert(state.tabs, tab), activeTabId: tab.id, collapsed: false };
    }),
  patchTab: (id, patch) =>
    set((state) => ({
      tabs: state.tabs.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    })),
  applyConversationEvent: (conversationId, event) =>
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
    }),
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
}));

migrateWidth();

export { MIN_WIDTH };
