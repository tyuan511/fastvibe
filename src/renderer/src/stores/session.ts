import { create } from "zustand";
import type {
  ChatAttachment,
  ChatMessage,
  Conversation,
  FastVibeModel,
  EngineSessionState,
  EngineStatus,
  EngineEvent,
  ExtensionNotice,
  ExtensionNoticeLevel,
  ExtensionWidget,
  PermissionQuestion,
  PermissionRequest,
  TuiRun,
  Project,
  QueuePauseReason,
  QueuedPrompt,
  SessionStats,
  FilePreview,
  SlashCommand,
  SubagentInfo,
  WorkspaceSnapshot,
} from "@shared/types";
import { applyEngineEvent } from "@/lib/apply-engine-event";
import { useSidePaneStore } from "@/stores/side-pane";

type SessionStore = {
  status: EngineStatus;
  session: EngineSessionState | null;
  models: FastVibeModel[];
  projects: Project[];
  conversations: Conversation[];
  activeId: string | null;
  messages: ChatMessage[];
  streaming: boolean;
  /** Per-conversation run state, keyed by conversation id. Kept beyond the active
   *  chat so the sidebar can show which conversations are still working. */
  running: Record<string, boolean>;
  /** Turn statistics for the active conversation (tokens, timing, cost). */
  stats: SessionStats | null;
  compacting: boolean;
  error: string | null;
  draft: string;
  commands: SlashCommand[];
  subagents: SubagentInfo[];
  permission: PermissionRequest | null;
  /** Transient notices from extension `ctx.ui.notify()`. */
  notices: ExtensionNotice[];
  /** Extension status entries (`ctx.ui.setStatus`), keyed by the extension's key. */
  extensionStatus: Record<string, string>;
  /** String-line widgets (`ctx.ui.setWidget`), keyed by the extension's key. */
  extensionWidgets: Record<string, ExtensionWidget>;
  attachments: ChatAttachment[];
  queued: QueuedPrompt[];
  queuePause: QueuePauseReason | null;
  permissionAlways: string[];
  preview: FilePreview | null;
  subagentStreams: Record<string, ChatMessage[]>;
  setStatus: (status: EngineStatus) => void;
  setSession: (session: EngineSessionState | null) => void;
  setModels: (models: FastVibeModel[]) => void;
  setStats: (stats: SessionStats | null) => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  setActiveId: (activeId: string | null) => void;
  setMessages: (messages: ChatMessage[]) => void;
  setDraft: (draft: string) => void;
  setError: (error: string | null) => void;
  setCommands: (commands: SlashCommand[]) => void;
  setSubagents: (subagents: SubagentInfo[]) => void;
  setPermission: (permission: PermissionRequest | null) => void;
  dismissNotice: (id: string) => void;
  addUserMessage: (text: string, attachments?: ChatAttachment[]) => void;
  dropEmptyAssistant: () => void;
  setAttachments: (attachments: ChatAttachment[]) => void;
  enqueue: (item: QueuedPrompt) => void;
  removeQueued: (id: string) => void;
  /** Drag-to-reorder: place `fromId` at `toId`'s position, shifting the rest. */
  moveQueued: (fromId: string, toId: string) => void;
  prependQueued: (item: QueuedPrompt) => void;
  clearQueued: () => void;
  setQueuePause: (reason: QueuePauseReason | null) => void;
  rememberPermission: (key: string) => void;
  setPreview: (preview: FilePreview | null) => void;
  openPreview: (path: string) => Promise<void>;
  applyEvent: (event: EngineEvent) => void;
  resetConversation: () => void;
  setStreaming: (streaming: boolean) => void;
  setConversationRunning: (id: string, running: boolean) => void;
  setRunningConversations: (ids: string[]) => void;
};

/**
 * Mirror the active conversation's busy state into the per-conversation map so the
 * sidebar lights up the moment a prompt is sent, without waiting for the engine's
 * `agent_start` IPC round-trip.
 */
function activeRunning(
  state: { activeId: string | null; running: Record<string, boolean> },
  running: boolean,
): Record<string, boolean> {
  if (!state.activeId || state.running[state.activeId] === running) return state.running;
  return { ...state.running, [state.activeId]: running };
}

function parseStringList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : undefined;
}

function parseOptionDetails(value: unknown): Array<{ description?: string }> | undefined {
  return Array.isArray(value)
    ? value.map((item) =>
        item && typeof item === "object" && "description" in item
          ? { description: typeof item.description === "string" ? item.description : undefined }
          : {},
      )
    : undefined;
}

function parseQuestions(value: unknown): PermissionQuestion[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value
    .map((item): PermissionQuestion | null => {
      if (!item || typeof item !== "object") return null;
      const entry = item as Record<string, unknown>;
      if (typeof entry.question !== "string" || !entry.question) return null;
      return {
        question: entry.question,
        header: typeof entry.header === "string" ? entry.header : undefined,
        options: parseStringList(entry.options),
        optionDetails: parseOptionDetails(entry.optionDetails),
        allowOther: typeof entry.allowOther === "boolean" ? entry.allowOther : undefined,
      };
    })
    .filter((item): item is PermissionQuestion => item !== null);
}

function parsePermission(event: EngineEvent): PermissionRequest | null {
  if (event.type !== "extension_ui_request") return null;
  const method = event.method;
  if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor" && method !== "questions") {
    return null;
  }
  const id = typeof event.id === "string" ? event.id : "";
  if (!id) return null;
  return {
    id,
    method,
    title: typeof event.title === "string" ? event.title : undefined,
    message: typeof event.message === "string" ? event.message : undefined,
    placeholder: typeof event.placeholder === "string" ? event.placeholder : undefined,
    options: parseStringList(event.options),
    optionDetails: parseOptionDetails(event.optionDetails),
    questions: parseQuestions(event.questions),
    timeout: typeof event.timeout === "number" ? event.timeout : undefined,
  };
}

/**
 * High-frequency events that only grow the trailing assistant. Applying each one in
 * its own `set` re-rendered the whole transcript on every token; under a fast model
 * that saturates the main thread and freezes the UI (spinner included). Coalesce
 * them into a single store update at a capped cadence. Control events still apply
 * synchronously so their ordering and side effects are untouched.
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

/** Fire-and-forget extension UI (`notify` / `setStatus` / `setWidget` / `set_editor_text`). */
function applyExtensionUi(
  event: EngineEvent,
  state: { notices: ExtensionNotice[]; extensionStatus: Record<string, string>; extensionWidgets: Record<string, ExtensionWidget>; draft: string },
): Partial<{ notices: ExtensionNotice[]; extensionStatus: Record<string, string>; extensionWidgets: Record<string, ExtensionWidget>; draft: string }> {
  if (event.type !== "extension_ui_request") return {};
  const method = event.method;
  if (method === "notify" && typeof event.message === "string") {
    const level: ExtensionNoticeLevel =
      event.notifyType === "warning" || event.notifyType === "error" ? event.notifyType : "info";
    // Drop the oldest so a chatty extension cannot grow the stack without bound.
    const next = [...state.notices, { id: String(event.id ?? crypto.randomUUID()), message: event.message, level, createdAt: Date.now() }];
    return { notices: next.slice(-4) };
  }
  if (method === "setStatus" && typeof event.statusKey === "string") {
    const extensionStatus = { ...state.extensionStatus };
    if (typeof event.statusText === "string" && event.statusText) extensionStatus[event.statusKey] = event.statusText;
    else delete extensionStatus[event.statusKey];
    return { extensionStatus };
  }
  if (method === "setWidget" && typeof event.widgetKey === "string") {
    const extensionWidgets = { ...state.extensionWidgets };
    const lines = Array.isArray(event.widgetLines)
      ? event.widgetLines.filter((line): line is string => typeof line === "string")
      : [];
    const runs = Array.isArray(event.widgetRuns) ? (event.widgetRuns as TuiRun[][]) : undefined;
    if (lines.length > 0 || (runs?.length ?? 0) > 0) {
      extensionWidgets[event.widgetKey] = {
        key: event.widgetKey,
        lines,
        runs,
        placement: typeof event.widgetPlacement === "string" ? event.widgetPlacement : undefined,
      };
    } else {
      delete extensionWidgets[event.widgetKey];
    }
    return { extensionWidgets };
  }
  if (method === "set_editor_text" && typeof event.text === "string") {
    return { draft: event.text };
  }
  return {};
}

function reduceEvents(state: SessionStore, events: EngineEvent[]): Partial<SessionStore> {
  let messages = state.messages;
  let streaming = state.streaming;
  let compacting = state.compacting;
  let permission = state.permission;
  let subagents = state.subagents;
  let subagentStreams = state.subagentStreams;
  let notices = state.notices;
  let extensionStatus = state.extensionStatus;
  let extensionWidgets = state.extensionWidgets;
  let draft = state.draft;
  for (const event of events) {
    const applied = applyEngineEvent(messages, event, streaming);
    messages = applied.messages;
    streaming = applied.streaming;
    const parsed = parsePermission(event);
    if (parsed) permission = parsed;
    const ui = applyExtensionUi(event, { notices, extensionStatus, extensionWidgets, draft });
    if (ui.notices) notices = ui.notices;
    if (ui.extensionStatus) extensionStatus = ui.extensionStatus;
    if (ui.extensionWidgets) extensionWidgets = ui.extensionWidgets;
    if (ui.draft !== undefined) draft = ui.draft;
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      compacting = true;
    } else if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
      compacting = false;
    }
    subagents = upsertSubagent(subagents, event);
    subagentStreams = applySubagentStream(subagentStreams, event);
  }
  return {
    messages,
    streaming,
    // Keep the sidebar indicator in step for slash commands that never start an
    // agent run (the optimistic flip has to be undone by `prompt_result`).
    running: activeRunning(state, streaming),
    compacting,
    permission,
    notices,
    extensionStatus,
    extensionWidgets,
    draft,
    subagents,
    subagentStreams,
  };
}

/**
 * Cap transcript updates at ~30fps. One commit per animation frame was still enough
 * to saturate layout: the message scroller re-measures its children on every content
 * mutation (`getBoundingClientRect` + `scrollTo`), so a fast model drove that on
 * every frame. 30fps text still reads as smooth, and control events flush
 * synchronously so run start/end stay immediate.
 */
const STREAM_FLUSH_MS = 32;

export const useSessionStore = create<SessionStore>((set) => {
  let queued: EngineEvent[] = [];
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
    if (queued.length === 0) return;
    lastFlush = Date.now();
    const events = queued;
    queued = [];
    set((state) => reduceEvents(state, events));
  };

  // Trailing throttle: the first delta lands immediately, then bursts coalesce.
  const scheduleFlush = (): void => {
    if (timer !== null) return;
    timer = window.setTimeout(flushQueued, Math.max(0, STREAM_FLUSH_MS - (Date.now() - lastFlush)));
  };

  return {
  status: { state: "idle" },
  session: null,
  models: [],
  projects: [],
  conversations: [],
  activeId: null,
  messages: [],
  streaming: false,
  running: {},
  stats: null,
  compacting: false,
  error: null,
  draft: "",
  commands: [],
  subagents: [],
  permission: null,
  notices: [],
  extensionStatus: {},
  extensionWidgets: {},
  attachments: [],
  queued: [],
  queuePause: null,
  permissionAlways: [],
  preview: null,
  subagentStreams: {},
  setStatus: (status) => set({ status, error: status.state === "error" ? status.message ?? null : null }),
  setSession: (session) =>
    set((state) => ({
      session,
      streaming: session?.isStreaming ?? false,
      compacting: session?.isCompacting ?? false,
      // Keep the per-conversation map in sync when a session is (re)opened.
      running: state.activeId
        ? { ...state.running, [state.activeId]: session?.isStreaming ?? false }
        : state.running,
    })),
  setModels: (models) => set({ models }),
  setStats: (stats) => set({ stats }),
  applySnapshot: (snapshot) =>
    set({
      projects: snapshot.projects,
      conversations: snapshot.conversations,
    }),
  setActiveId: (activeId) => set({ activeId }),
  setMessages: (messages) =>
    set((state) => ({ messages, streaming: false, running: activeRunning(state, false) })),
  setDraft: (draft) => set({ draft }),
  setError: (error) => set({ error }),
  setCommands: (commands) => set({ commands }),
  setSubagents: (subagents) => set({ subagents }),
  setPermission: (permission) => set({ permission }),
  dismissNotice: (id) => set((state) => ({ notices: state.notices.filter((item) => item.id !== id) })),
  addUserMessage: (text, attachments) =>
    set((state) => {
      const messages: ChatMessage[] = [
        ...state.messages,
        {
          id: `local:${crypto.randomUUID()}`,
          role: "user",
          text,
          tools: [],
          parts: text ? [{ kind: "text", text }] : [],
          createdAt: Date.now(),
          attachments,
        },
      ];
      // A slash command can be handled by an extension without starting an agent
      // turn (plan/goal menus, `/plan start`, …). Only a plain prompt pre-creates
      // the assistant bubble; for `/…` the bubble is created by `agent_start`
      // when a turn actually runs, so the UI never hangs in a fake "streaming".
      const startsTurn = !text.trim().startsWith("/");
      if (startsTurn) {
        messages.push({
          id: crypto.randomUUID(),
          role: "assistant",
          text: "",
          tools: [],
          parts: [],
          createdAt: Date.now(),
        });
      }
      return {
        messages,
        streaming: startsTurn,
        error: null,
        attachments: [],
        running: activeRunning(state, startsTurn),
      };
    }),
  dropEmptyAssistant: () =>
    set((state) => {
      const last = state.messages.at(-1);
      if (
        last?.role === "assistant" &&
        !last.text &&
        !last.thinking &&
        last.tools.length === 0 &&
        !last.error
      ) {
        return { messages: state.messages.slice(0, -1), streaming: false, running: activeRunning(state, false) };
      }
      return { streaming: false, running: activeRunning(state, false) };
    }),
  setAttachments: (attachments) => set({ attachments }),
  enqueue: (item) => set((state) => ({ queued: [...state.queued, item] })),
  removeQueued: (id) => set((state) => ({ queued: state.queued.filter((item) => item.id !== id) })),
  moveQueued: (fromId, toId) =>
    set((state) => {
      const from = state.queued.findIndex((item) => item.id === fromId);
      const to = state.queued.findIndex((item) => item.id === toId);
      if (from < 0 || to < 0 || from === to) return state;
      const next = state.queued.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      return { queued: next };
    }),
  prependQueued: (item) => set((state) => ({ queued: [item, ...state.queued] })),
  clearQueued: () => set({ queued: [], queuePause: null }),
  setQueuePause: (queuePause) => set({ queuePause }),
  rememberPermission: (key) =>
    set((state) =>
      state.permissionAlways.includes(key) ? state : { permissionAlways: [...state.permissionAlways, key] },
    ),
  setPreview: (preview) => set({ preview }),
  openPreview: async (path) => {
    try {
      const preview = await window.fastvibe.workspace.preview(path);
      set({ preview });
      useSidePaneStore.getState().openFilePreview(preview);
    } catch (error) {
      const preview: FilePreview = {
        kind: "error",
        path,
        name: path.split("/").at(-1) ?? path,
        message: error instanceof Error ? error.message : "无法预览",
      };
      set({ preview });
      useSidePaneStore.getState().openFilePreview(preview);
    }
  },
  applyEvent: (event) => {
    if (COALESCED_EVENTS.has(event.type)) {
      queued.push(event);
      scheduleFlush();
      return;
    }
    flushQueued();
    set((state) => reduceEvents(state, [event]));
  },
  resetConversation: () =>
    set({
      messages: [],
      streaming: false,
      running: {},
      stats: null,
      compacting: false,
      error: null,
      activeId: null,
      permission: null,
      notices: [],
      extensionStatus: {},
      extensionWidgets: {},
      subagents: [],
      subagentStreams: {},
      preview: null,
      queued: [],
      queuePause: null,
    }),
  setStreaming: (streaming) =>
    set((state) => ({ streaming, running: activeRunning(state, streaming) })),
  setConversationRunning: (id, running) =>
    set((state) =>
      state.running[id] === running ? state : { running: { ...state.running, [id]: running } },
    ),
  setRunningConversations: (ids) =>
    set({ running: Object.fromEntries(ids.map((id) => [id, true])) }),
  };
});

function upsertSubagent(list: SubagentInfo[], event: EngineEvent): SubagentInfo[] {
  if (event.type !== "subagent_lifecycle" && event.type !== "subagent_progress") return list;
  const id = typeof event.subagentId === "string" ? event.subagentId : typeof event.id === "string" ? event.id : "";
  if (!id) return list;
  const next: SubagentInfo = {
    id,
    name: typeof event.name === "string" ? event.name : list.find((item) => item.id === id)?.name,
    status: typeof event.status === "string" ? event.status : list.find((item) => item.id === id)?.status,
    detail:
      typeof event.detail === "string"
        ? event.detail
        : typeof event.progress === "string"
          ? event.progress
          : list.find((item) => item.id === id)?.detail,
  };
  if (list.some((item) => item.id === id)) {
    return list.map((item) => (item.id === id ? { ...item, ...next } : item));
  }
  return [next, ...list];
}

function applySubagentStream(
  streams: Record<string, ChatMessage[]>,
  event: EngineEvent,
): Record<string, ChatMessage[]> {
  if (event.type !== "subagent_event") return streams;
  const id =
    typeof event.subagentId === "string"
      ? event.subagentId
      : typeof event.id === "string"
        ? event.id
        : "";
  if (!id) return streams;
  const nested =
    event.event && typeof event.event === "object"
      ? (event.event as EngineEvent)
      : event.payload && typeof event.payload === "object"
        ? (event.payload as EngineEvent)
        : event;
  if (typeof nested.type !== "string" || nested.type === "subagent_event") return streams;
  const applied = applyEngineEvent(streams[id] ?? [], nested, true);
  return { ...streams, [id]: applied.messages };
}
