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
import { applyEngineEvent, lastUserIsLocal, userMessageText } from "@/lib/apply-engine-event";
import { i18n } from "@/lib/i18n";
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
  /**
   * Where a model switch recorded *now* belongs in the reply being streamed: the part
   * index the engine's current message began at.
   *
   * The switch is a divider part, and the SDK anchors its `model_change` entry to the
   * last *completed* message — so a switch made mid-run lands between the parts of the
   * reply that spans it, not after it. Tracking that index lets the divider be drawn
   * in place immediately; without it the only option would be the end of the
   * transcript, which is where the divider would then sit until the next reload moved
   * it. Kept across streamed deltas, reset at every engine message boundary.
   */
  partBoundary: number;
  error: string | null;
  draft: string;
  commands: SlashCommand[];
  subagents: SubagentInfo[];
  permission: PermissionRequest | null;
  /** Blocking extension prompts retained while another conversation is active. */
  pendingPermissions: Record<string, PermissionRequest>;
  /** Transient notices from extension `ctx.ui.notify()`. */
  notices: ExtensionNotice[];
  /** Extension status entries (`ctx.ui.setStatus`), keyed by the extension's key. */
  extensionStatus: Record<string, string>;
  /** String-line widgets (`ctx.ui.setWidget`), keyed by the extension's key. */
  extensionWidgets: Record<string, ExtensionWidget>;
  attachments: ChatAttachment[];
  queued: QueuedPrompt[];
  queuePause: QueuePauseReason | null;
  /**
   * How the last run ended early, if it did: `error` (failure) or `aborted` (the
   * user stopped it). Cleared when a new run starts. Drives the composer's resume
   * control — a half-finished reply can be continued without retyping anything.
   */
  runInterrupted: "aborted" | "error" | null;
  permissionAlways: string[];
  preview: FilePreview | null;
  subagentStreams: Record<string, ChatMessage[]>;
  setStatus: (status: EngineStatus) => void;
  setSession: (session: EngineSessionState | null) => void;
  setModels: (models: FastVibeModel[]) => void;
  setStats: (stats: SessionStats | null) => void;
  applySnapshot: (snapshot: WorkspaceSnapshot) => void;
  setActiveId: (activeId: string | null) => void;
  /**
   * Replace the whole transcript.
   *
   * `conversationId` names the conversation the list was read from. A list that
   * belongs to a chat the user has already left is ignored rather than written:
   * everything here travels one IPC hop, so a slow reply can land after the switch.
   */
  setMessages: (messages: ChatMessage[], conversationId?: string) => void;
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
  /** Drag-to-reorder: persist the full id order the sortable list produced. */
  setQueuedOrder: (ids: string[]) => void;
  prependQueued: (item: QueuedPrompt) => void;
  /** Mark a queued row as 发送中 and record the payload the engine was given. */
  markQueuedSending: (id: string, sentText: string) => void;
  /** 撤回: put a 发送中 row back to pending. */
  unmarkQueuedSending: (id: string) => void;
  /** Abort dropped the engine's steering queue; those rows are pending again. */
  unmarkAllQueuedSending: () => void;
  clearQueued: () => void;
  setQueuePause: (reason: QueuePauseReason | null) => void;
  /** Clear the interrupted-run marker once a resume (or fresh prompt) takes over. */
  setRunInterrupted: (reason: "aborted" | "error" | null) => void;
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
 * Part index a model switch recorded from here on belongs at.
 *
 * A transcript read back from the engine is settled, so a divider recorded while the
 * user is reading it trails the last reply; with no reply on screen it opens the next
 * one instead (the reply's own content is inserted after it).
 */
function settledBoundary(messages: ChatMessage[]): number {
  const last = messages.at(-1);
  return last?.role === "assistant" ? (last.parts?.length ?? 0) : 0;
}

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

/**
 * Whether a conversation is still working.
 *
 * Two different things can be in flight, and the sidebar's 运行中 mark covers both:
 * an agent run (`running`, which spans the whole run — `agent_start` through
 * `agent_settled`, retries, auto-compaction and continuations included), and a
 * compaction that runs with no run at all (`/compact`, and the threshold check a
 * fresh prompt runs before it is sent) — so a run flag alone reads a chat that is
 * mid-compaction as idle.
 */
export function working(session: EngineSessionState | null | undefined): boolean {
  return session?.running === true || session?.isCompacting === true;
}

/**
 * Whether the conversation on screen is still working — the same verdict the
 * sidebar's 运行中 mark carries (an agent run, or the compaction that follows one).
 *
 * Read from the per-conversation map rather than `session`: the map is keyed by id,
 * so it cannot describe the chat the user just left, and it is written on every
 * `conversation_running` broadcast — the only thing that clears it when a session is
 * torn down mid-run.
 */
export function useConversationWorking(): boolean {
  return useSessionStore((state) => (state.activeId ? state.running[state.activeId] === true : false));
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
    conversationId: typeof event.conversationId === "string" ? event.conversationId : undefined,
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
  let partBoundary = state.partBoundary;
  let permission = state.permission;
  let subagents = state.subagents;
  let subagentStreams = state.subagentStreams;
  let notices = state.notices;
  let extensionStatus = state.extensionStatus;
  let extensionWidgets = state.extensionWidgets;
  let draft = state.draft;
  let pendingPermissions = state.pendingPermissions;
  let queued = state.queued;
  let queuePause = state.queuePause;
  let runInterrupted = state.runInterrupted;
  /** Sidebar mark for this batch when it is not simply `streaming` (a compaction). */
  let workingOverride: boolean | undefined;
  /**
   * Main's own `conversation_running` verdict for this batch, when it carried one.
   *
   * That event is never coalesced, so it arrives alone: it is the engine answering
   * for one named conversation (a run *or* a compaction), and it is recorded as
   * given instead of being re-derived from the chat on screen. Deriving it from the
   * batch's `streaming` undid the answer until the transcript event it accompanies
   * landed a message later — the sidebar blinked 运行中 off for a frame at every run
   * start. It is also the only verdict that can lower the mark of a chat the user
   * is *not* looking at.
   */
  let broadcast: { id: string; running: boolean } | undefined;
  for (const event of events) {
    // A steered user turn has no optimistic copy. Once the engine injects it,
    // drop the matching 发送中 row so the tray no longer shows it.
    const delivered = userMessageText(event);
    if (delivered !== undefined && !lastUserIsLocal(messages)) {
      const sending = queued.filter((item) => item.sending);
      if (sending.length > 0) {
        const match = sending.find((item) => item.sentText === delivered) ?? sending[0];
        queued = queued.filter((item) => item.id !== match.id);
      }
    }
    const applied = applyEngineEvent(messages, event, streaming, partBoundary);
    messages = applied.messages;
    streaming = applied.streaming;
    if (applied.partBoundary !== undefined) partBoundary = applied.partBoundary;
    /**
     * How the run stopped early, if it did.
     *
     * `agent_end` reports a failure or an abort itself. The one case it cannot is a
     * retry chain the user stopped while it waited out the backoff: the SDK has
     * already dropped the failed attempt from agent state by then, so the run ends
     * with a bare `auto_retry_end` and the turn would otherwise look like a clean one
     * (no error to show, and a bare 发送 where 继续 belongs). When the retry budget
     * simply ran out, the `agent_end` before this event has already marked the failure
     * as `error` — hence the `runInterrupted === null` guard, which keeps that verdict.
     */
    const stoppedEarly: "aborted" | "error" | undefined = applied.interrupted
      ? applied.interrupted
      : event.type === "auto_retry_end" && event.success === false && runInterrupted === null
        ? "aborted"
        : undefined;
    if (stoppedEarly) {
      // A run that stopped early may have queued follow-ups. Hold them: the reply is
      // half-written, so silently sending the rest of the queue would continue from a
      // broken turn. The composer shows a resume control instead.
      runInterrupted = stoppedEarly;
      if (state.queued.length > 0) {
        queuePause = stoppedEarly === "error" ? "error" : "stopped";
      }
    } else if (event.type === "agent_start" || event.type === "turn_start") {
      // A new run (resume, retry, or fresh prompt) clears the interrupted state.
      runInterrupted = null;
    }
    const parsed = parsePermission(event);
    if (parsed) {
      const conversationId = parsed.conversationId ?? state.activeId ?? "__active__";
      // Keep one request per conversation. A later request from the same session
      // supersedes a stale one, while requests from background sessions remain
      // available when the user switches back to them.
      pendingPermissions = { ...pendingPermissions, [conversationId]: parsed };
      if (!parsed.conversationId || parsed.conversationId === state.activeId) permission = parsed;
    }
    const ui = applyExtensionUi(event, { notices, extensionStatus, extensionWidgets, draft });
    if (ui.notices) notices = ui.notices;
    if (ui.extensionStatus) extensionStatus = ui.extensionStatus;
    if (ui.extensionWidgets) extensionWidgets = ui.extensionWidgets;
    if (ui.draft !== undefined) draft = ui.draft;
    if (event.type === "conversation_running" && typeof event.conversationId === "string") {
      broadcast = { id: event.conversationId, running: event.running === true };
      // Main is the authority on 「is this chat working」, so its verdict also ends the
      // transcript's run flag for the chat on screen: a session torn down mid-run never
      // emits `agent_settled`, and nothing else would clear the caret or the stop button.
      if (event.running !== true && event.conversationId === state.activeId) streaming = false;
    }
    if (event.type === "compaction_start" || event.type === "auto_compaction_start") {
      // A compaction can run with no agent run at all (`/compact`), so this is not
      // just book-keeping for the run flag: it is what keeps the mark lit for a chat
      // whose run has already settled.
      workingOverride = true;
    } else if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
      // Back to whatever the run flag says: an auto-compaction the SDK is about to
      // continue has one, a standalone one does not.
      workingOverride = streaming;
    }
    subagents = upsertSubagent(subagents, event);
    subagentStreams = applySubagentStream(subagentStreams, event);
  }
  return {
    messages,
    streaming,
    partBoundary,
    // Keep the sidebar indicator in step for slash commands that never start an
    // agent run (the optimistic flip has to be undone by `prompt_result`), and
    // across a compaction, which is work without being a run.
    running: broadcast
      ? { ...state.running, [broadcast.id]: broadcast.running }
      : activeRunning(state, workingOverride ?? streaming),
    permission,
    pendingPermissions,
    notices,
    extensionStatus,
    extensionWidgets,
    draft,
    subagents,
    subagentStreams,
    queued,
    queuePause,
    runInterrupted,
  };
}

/**
 * Does this event belong to the transcript the store is holding?
 *
 * The transcript is one array owned by `activeId`, while every engine event names
 * the conversation it came from. The subscriber in `App.tsx` routes by that id, but
 * it compares against the id at *delivery* time — and a switch is not instant: the
 * `openConversation` round trip (session creation included) leaves the previous
 * chat on screen for hundreds of milliseconds, so the events that arrive during it
 * are legitimately applied to the old transcript. Anything still coalesced when the
 * new chat's transcript lands has to be re-checked against the new owner, or the
 * tail of the conversation being left is flushed into the one being opened.
 *
 * Subagent traffic is exempt: it is keyed by run id, feeds `subagentStreams`, and is
 * deliberately applied whichever chat is on screen so a backgrounded run stays live.
 * An event with no conversation of its own (an extension load failure) is global.
 */
function belongsToTranscript(event: EngineEvent, ownerId: string | null): boolean {
  if (event.type.startsWith("subagent_")) return true;
  const conversationId = typeof event.conversationId === "string" ? event.conversationId : null;
  if (!conversationId) return true;
  return conversationId === ownerId;
}

/**
 * Cap transcript updates at ~30fps. One commit per animation frame was still enough
 * to saturate layout: the message scroller re-measures its children on every content
 * mutation (`getBoundingClientRect` + `scrollTo`), so a fast model drove that on
 * every frame. 30fps text still reads as smooth, and control events flush
 * synchronously so run start/end stay immediate.
 */
const STREAM_FLUSH_MS = 32;

export const useSessionStore = create<SessionStore>((set, get) => {
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
    // Resolve the owner now rather than when the events were queued: the transcript
    // may have been swapped for another conversation while these waited.
    const owner = get().activeId;
    const events = queued.filter((event) => belongsToTranscript(event, owner));
    queued = [];
    if (events.length > 0) set((state) => reduceEvents(state, events));
  };

  /**
   * Forget coalesced events that were writing into the transcript just replaced
   * by a fresh engine read. Subagent traffic is keyed by run id, not the chat on
   * screen: dropping it here is what blanked a live subagent pane every time the
   * parent reloaded its own transcript (`reloadActiveMessages` / `applyOpen`).
   */
  const dropQueued = (): void => {
    clearTimer();
    queued = queued.filter((event) => event.type.startsWith("subagent_"));
    if (queued.length > 0) flushQueued();
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
  partBoundary: 0,
  error: null,
  draft: "",
  commands: [],
  subagents: [],
  permission: null,
  pendingPermissions: {},
  notices: [],
  extensionStatus: {},
  extensionWidgets: {},
  attachments: [],
  queued: [],
  queuePause: null,
  runInterrupted: null,
  permissionAlways: [],
  preview: null,
  subagentStreams: {},
  setStatus: (status) => set({ status, error: status.state === "error" ? status.message ?? null : null }),
  setSession: (session) =>
    set((state) => {
      // A state reply travels one IPC hop, so it can land after the user opened
      // another chat. It still describes the surface the composer reads
      // (`session.model` is shared by the side pane's own composer), but its run
      // flags speak only for the conversation they belong to: adopting them for
      // the chat on screen lit a finished conversation as 运行中 with no event
      // left to clear it.
      const mine = !session?.conversationId || !state.activeId || session.conversationId === state.activeId;
      return {
        session,
        streaming: mine ? (session?.running ?? false) : state.streaming,
        // `working`, not just `running`: the sidebar's mark means 「still busy」, which
        // a compaction also is — and a chat that compacts in the background keeps it
        // lit, so switching to it and back no longer loses the state. This map is the
        // **only** busy state the UI reads (sidebar mark, composer's stop button, todo
        // panel): a third copy of it could disagree with these by an IPC hop.
        running:
          mine && state.activeId ? { ...state.running, [state.activeId]: working(session) } : state.running,
      };
    }),
  setModels: (models) => set({ models }),
  setStats: (stats) => set({ stats }),
  applySnapshot: (snapshot) =>
    set({
      projects: snapshot.projects,
      conversations: snapshot.conversations,
    }),
  setActiveId: (activeId) => {
    // The right pane is conversation-bound: switching chats swaps its tabs, its
    // active tab and its collapsed/maximized state onto the incoming chat.
    useSidePaneStore.getState().setScope(activeId);
    set((state) => ({
      activeId,
      permission: activeId ? state.pendingPermissions[activeId] ?? null : null,
    }));
  },
  setMessages: (messages, conversationId) => {
    dropQueued();
    set((state) => {
      if (conversationId && state.activeId && conversationId !== state.activeId) return state;
      return {
        messages,
        // The run flags are deliberately left alone: a transcript read says nothing
        // about whether a run is in flight. `reloadActiveMessages()` fires at every
        // `agent_end` and `compaction_end`, and its reply is an expensive full
        // transcript replay — the engine may long since be retrying, continuing or
        // answering the *next* request when it lands. Clearing them here reported a
        // working chat as idle in the middle of that request (footer, stop button and
        // sidebar mark alike) until the next `turn_start` re-lit it. Main owns these
        // flags — it broadcasts every change — and `setSession` seeds them from the
        // engine's own state when a conversation is opened or re-read.
        streaming: state.streaming,
        partBoundary: settledBoundary(messages),
        running: state.running,
      };
    });
  },
  setDraft: (draft) => set({ draft }),
  setError: (error) => set({ error }),
  setCommands: (commands) => set({ commands }),
  setSubagents: (subagents) =>
    set((state) => {
      // Merge the engine's snapshot by id rather than replacing the list. A snapshot
      // lands on every lifecycle event, and a wholesale replacement handed every
      // subagent pane a brand-new entry object each time — re-rendering the pane (and
      // re-deriving each run's brief) several times per run for identical data.
      const previous = new Map(state.subagents.map((item) => [item.id, item]));
      let changed = state.subagents.length !== subagents.length;
      const next = subagents.map((item) => {
        const before = previous.get(item.id);
        if (!before) {
          changed = true;
          return item;
        }
        const merged: SubagentInfo = { ...before, ...item };
        const same =
          before.status === merged.status &&
          before.detail === merged.detail &&
          before.progress === merged.progress &&
          before.error === merged.error &&
          before.endedAt === merged.endedAt &&
          before.startedAt === merged.startedAt &&
          before.name === merged.name &&
          before.agent === merged.agent;
        if (same) return before;
        changed = true;
        return merged;
      });
      // The engine's order is by recency; only adopt it when it really differs, so an
      // unchanged snapshot leaves the store (and every subscriber) untouched.
      const reordered = next.some((item, index) => item !== state.subagents[index]);
      return changed || reordered ? { subagents: next } : state;
    }),
  setPermission: (permission) => set((state) => {
    const pendingPermissions = { ...state.pendingPermissions };
    const conversationId = permission?.conversationId ?? state.activeId;
    if (conversationId) {
      if (permission) pendingPermissions[conversationId] = permission;
      else delete pendingPermissions[conversationId];
    }
    return { permission, pendingPermissions };
  }),
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
  setQueuedOrder: (ids) =>
    set((state) => {
      const rank = new Map(ids.map((id, index) => [id, index]));
      // Unknown ids keep their relative order at the end, so a stale drop can't drop items.
      const queued = [...state.queued].sort((a, b) => {
        const left = rank.get(a.id);
        const right = rank.get(b.id);
        if (left === undefined && right === undefined) return 0;
        if (left === undefined) return 1;
        if (right === undefined) return -1;
        return left - right;
      });
      return { queued };
    }),
  prependQueued: (item) => set((state) => ({ queued: [item, ...state.queued] })),
  markQueuedSending: (id, sentText) =>
    set((state) => ({
      queued: state.queued.map((item) => (item.id === id ? { ...item, sending: true, sentText } : item)),
    })),
  unmarkQueuedSending: (id) =>
    set((state) => ({
      queued: state.queued.map((item) =>
        item.id === id ? { ...item, sending: false, sentText: undefined } : item,
      ),
    })),
  unmarkAllQueuedSending: () =>
    set((state) => ({
      queued: state.queued.map((item) =>
        item.sending ? { ...item, sending: false, sentText: undefined } : item,
      ),
    })),
  clearQueued: () => set({ queued: [], queuePause: null }),
  setQueuePause: (queuePause) => set({ queuePause }),
  setRunInterrupted: (runInterrupted) => set({ runInterrupted }),
  rememberPermission: (key) =>
    set((state) =>
      state.permissionAlways.includes(key) ? state : { permissionAlways: [...state.permissionAlways, key] },
    ),
  setPreview: (preview) => set({ preview }),
  openPreview: async (path) => {
    // The open file lives on the *conversation's* files tab, so the same file can be
    // previewed in two chats without one suppressing the other. The session-level
    // `preview` field is kept for callers that only want the last preview read.
    try {
      const preview = await window.fastvibe.workspace.preview(path);
      set({ preview });
      useSidePaneStore.getState().openFilePreview(preview);
    } catch (error) {
      const preview: FilePreview = {
        kind: "error",
        path,
        name: path.split("/").at(-1) ?? path,
        message: error instanceof Error ? error.message : (i18n.t("common:errors.previewFailed") as string),
      };
      set({ preview });
      useSidePaneStore.getState().openFilePreview(preview);
    }
  },
  applyEvent: (event) => {
    if (!belongsToTranscript(event, get().activeId)) return;
    if (COALESCED_EVENTS.has(event.type)) {
      queued.push(event);
      scheduleFlush();
      return;
    }
    flushQueued();
    set((state) => reduceEvents(state, [event]));
  },
  resetConversation: () => {
    useSidePaneStore.getState().setScope(null);
    dropQueued();
    set({
      messages: [],
      streaming: false,
      partBoundary: 0,
      // `running` is deliberately kept: it is keyed by conversation and covers chats
      // other than the one being cleared. Wiping it here left every *other* running
      // chat looking idle — and since Main broadcasts `conversation_running` only
      // when the value changes, nothing would have raised the mark back.
      stats: null,
      error: null,
      activeId: null,
      permission: null,
      pendingPermissions: {},
      notices: [],
      extensionStatus: {},
      extensionWidgets: {},
      // Delegated runs outlive the chat on screen: wiping these made a background
      // subagent's pane empty after a new-session / archive, and nothing would have
      // rebuilt the stream until the next token.
      preview: null,
      queued: [],
      queuePause: null,
      runInterrupted: null,
    });
  },
  setStreaming: (streaming) =>
    set((state) => ({ streaming, running: activeRunning(state, streaming) })),
  setConversationRunning: (id, running) =>
    set((state) =>
      state.running[id] === running ? state : { running: { ...state.running, [id]: running } },
    ),
  /**
   * Seed the sidebar's run marks from a fresh engine read (a new window or reload).
   *
   * Only ids the store has not heard about are filled in. The read is one IPC hop
   * old: a `conversation_running` broadcast that arrived while it was in flight is
   * newer than it, and replacing the map wholesale would resurrect a run that had
   * already ended — a stale mark Main would never correct, because it only
   * broadcasts on change.
   */
  setRunningConversations: (ids) =>
    set((state) => {
      const running = { ...state.running };
      for (const id of ids) if (running[id] === undefined) running[id] = true;
      return { running };
    }),
  };
});

function upsertSubagent(list: SubagentInfo[], event: EngineEvent): SubagentInfo[] {
  if (event.type !== "subagent_lifecycle" && event.type !== "subagent_progress") return list;
  const id = typeof event.subagentId === "string" ? event.subagentId : typeof event.id === "string" ? event.id : "";
  if (!id) return list;
  const previous = list.find((item) => item.id === id);
  const now = Date.now();
  const next: SubagentInfo = {
    id,
    conversationId:
      typeof event.conversationId === "string" ? event.conversationId : previous?.conversationId,
    agent: typeof event.agent === "string" ? event.agent : previous?.agent,
    name: typeof event.name === "string" ? event.name : previous?.name,
    status: typeof event.status === "string" ? event.status : previous?.status,
    detail:
      typeof event.detail === "string"
        ? event.detail
        : typeof event.progress === "string"
          ? event.progress
          : previous?.detail,
    progress: typeof event.progress === "number" ? event.progress : previous?.progress,
    // Recorded once, so a run's brief keeps a stable `createdAt` (and therefore a
    // stable object identity in the pane) across every later lifecycle event.
    startedAt: previous?.startedAt ?? now,
    endedAt:
      typeof event.status === "string" && event.status !== "running" ? now : previous?.endedAt,
    error: typeof event.error === "string" ? event.error : previous?.error,
  };
  if (previous) {
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
  // The delegated brief is rebuilt from the run's `detail`; the engine's echo of
  // the task would stack a second copy under it.
  if (nested.type === "message_start") {
    const message = nested.message;
    if (message && typeof message === "object" && (message as { role?: unknown }).role === "user") {
      return streams;
    }
  }
  const applied = applyEngineEvent(streams[id] ?? [], nested, true);
  return { ...streams, [id]: applied.messages };
}
