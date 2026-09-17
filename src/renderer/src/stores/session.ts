import { create } from "zustand";
import type {
  ChatAttachment,
  ChatMessage,
  ContextUsage,
  Conversation,
  EngineModel,
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
  /**
   * Blocking extension prompts per conversation, in arrival order.
   *
   * A list, not one slot: a conversation can have several parked at once. Parallel
   * subagents share their parent conversation's UI context, so a fan-out of eight
   * runs each asking for approval arrives here with the same `conversationId`, and
   * the single-slot version silently kept only the last one — the other seven stayed
   * parked on the engine side with nothing on screen to answer them.
   */
  pendingPermissions: Record<string, PermissionRequest[]>;
  /**
   * Conversations parked on a blocking prompt, whether or not they are on screen.
   *
   * Drives the sidebar's 「等你」 mark and the approval notification: a prompt is only
   * drawn for the active conversation, so without this a background chat waiting on a
   * tool approval looked exactly like an idle one.
   */
  waitingForUser: Record<string, boolean>;
  /** Transient notices from extension `ctx.ui.notify()`. */
  notices: ExtensionNotice[];
  /**
   * Extension status entries (`ctx.ui.setStatus`), bucketed by conversation.
   *
   * Status belongs to the session that published it: the goal extension's objective
   * panel, plan mode's badge and any plugin widget are all per-conversation state,
   * and a single shared map put one chat's panel on another chat's screen — a chat
   * with no goal at all showed the running one's objective, and its 暂停 button
   * dispatched `/goal pause` into the conversation that had nothing to pause. Keyed
   * by owner id, and read through `useExtensionStatus` for the chat on screen.
   */
  extensionStatus: Record<string, Record<string, string>>;
  /** String-line widgets (`ctx.ui.setWidget`), bucketed by conversation. */
  extensionWidgets: Record<string, Record<string, ExtensionWidget>>;
  attachments: ChatAttachment[];
  queued: QueuedPrompt[];
  queuePause: QueuePauseReason | null;
  /**
   * How the last run ended early, if it did: `error` (failure) or `aborted` (the
   * user stopped it). Cleared when a new run starts. Drives the composer's resume
   * control — a half-finished reply can be continued without retyping anything.
   */
  runInterrupted: "aborted" | "error" | null;
  preview: FilePreview | null;
  subagentStreams: Record<string, ChatMessage[]>;
  /**
   * Forget one conversation's extension status / widgets.
   *
   * Called when a conversation is deleted: the buckets are keyed by id, and a
   * deleted chat's goal panel must not be reachable afterwards.
   */
  forgetConversationExtensionState: (conversationId: string) => void;
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
  /**
   * Seed a conversation's extension statuses from a fresh engine read.
   *
   * The engine replays what `session_start` published (a goal restored from its
   * transcript, brought back paused). It *replaces* that conversation's bucket rather
   * than merging: the reply is the whole state, so a key it no longer names — a goal
   * that was cleared, a plan mode that exited while the chat was closed — has to go.
   * An empty map therefore clears the bucket.
   */
  setExtensionStatus: (conversationId: string, status: Record<string, string>) => void;
  setDraft: (draft: string) => void;
  setError: (error: string | null) => void;
  setCommands: (commands: SlashCommand[]) => void;
  setSubagents: (subagents: SubagentInfo[]) => void;
  /**
   * Take one prompt off the queue, by id.
   *
   * By id, not "the head": the engine can withdraw a prompt itself (the confirm
   * timeout, an abort) and the dismiss event may already have removed it, in which
   * case a head-drop would silently discard the *next* queued prompt — one the engine
   * is still parked on and will never re-announce, so the run hangs until its own
   * timeout. Parallel subagents share one `conversationId`, so several prompts really
   * do queue up here.
   */
  resolvePermission: (id: string) => void;
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

/**
 * The extension statuses the conversation on screen owns.
 *
 * Status is per-conversation (see `SessionStore.extensionStatus`), so every reader
 * goes through the active id rather than reaching for the whole map — a chat with
 * no goal must not draw the one a different chat is running. The empty object is a
 * module constant so the selector does not allocate a new snapshot per render.
 */
const NO_EXTENSION_STATUS: Record<string, string> = {};
export function useExtensionStatus(): Record<string, string> {
  return useSessionStore((state) =>
    state.activeId ? state.extensionStatus[state.activeId] ?? NO_EXTENSION_STATUS : NO_EXTENSION_STATUS,
  );
}

/** The string-line widgets the conversation on screen owns. Same rule as status. */
const NO_EXTENSION_WIDGETS: Record<string, ExtensionWidget> = {};
export function useExtensionWidgets(): Record<string, ExtensionWidget> {
  return useSessionStore((state) =>
    state.activeId ? state.extensionWidgets[state.activeId] ?? NO_EXTENSION_WIDGETS : NO_EXTENSION_WIDGETS,
  );
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

/** Remove one prompt by id, optionally restricted to its owner conversation. */
function dropPending(
  pending: Record<string, PermissionRequest[]>,
  id: string,
  conversationId?: string,
): Record<string, PermissionRequest[]> {
  const next: Record<string, PermissionRequest[]> = {};
  for (const [key, list] of Object.entries(pending)) {
    if (conversationId && key !== conversationId) {
      next[key] = list;
      continue;
    }
    const remaining = list.filter((item) => item.id !== id);
    if (remaining.length > 0) next[key] = remaining;
  }
  return next;
}

/** The prompt the composer should draw: the head of the active conversation's queue. */
export function activePermission(
  pending: Record<string, PermissionRequest[]>,
  activeId: string | null,
): PermissionRequest | null {
  if (!activeId) return null;
  return pending[activeId]?.[0] ?? null;
}

/**
 * Waiting-for-user mark, recomputed from the conversation that just reported state.
 *
 * A state reply only says what the engine's own bookkeeping knows; it cannot say
 * whether a prompt is on screen. The pending queue can, so a chat that comes back
 * with a prompt parked on it is marked as waiting even though the `extension_ui_request`
 * itself may have arrived while a different chat was being viewed.
 */
function waitingForUserAfter(
  state: { waitingForUser: Record<string, boolean>; pendingPermissions: Record<string, PermissionRequest[]> },
  session: EngineSessionState | null,
): Record<string, boolean> {
  const id = session?.conversationId;
  if (!id) return state.waitingForUser;
  const waiting = (state.pendingPermissions[id]?.length ?? 0) > 0;
  if (state.waitingForUser[id] === waiting) return state.waitingForUser;
  return { ...state.waitingForUser, [id]: waiting };
}

/**
 * Structural equality with a node budget, for transcript reconciliation.
 *
 * Bounded because a tool call's `args`/`details` are arbitrary engine payloads: a
 * pathological one must cost a fixed amount rather than walking an unbounded
 * graph. Running out of budget answers "not equal", which is the conservative
 * direction — the caller then takes the fresh object, exactly as it did before any
 * reconciliation existed. Strings are compared with `===`, which the engine does
 * as a length check plus a memcmp; that is far cheaper than re-parsing the
 * markdown the comparison saves.
 */
function equalValue(a: unknown, b: unknown, budget: { left: number }): boolean {
  if (a === b) return true;
  if (budget.left-- <= 0) return false;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((item, index) => equalValue(item, b[index], budget));
  }
  const left = a as Record<string, unknown>;
  const right = b as Record<string, unknown>;
  const keys = Object.keys(left);
  if (keys.length !== Object.keys(right).length) return false;
  return keys.every((key) => key in right && equalValue(left[key], right[key], budget));
}

/** Budget per message. Generous enough for a real tool payload, finite for a hostile one. */
const EQUAL_BUDGET = 20_000;

/**
 * Reconcile an authoritative transcript read against the one already on screen.
 *
 * `reloadActiveMessages()` fires at the end of every turn and its reply is a fresh
 * object graph off the IPC boundary, so every row lost its identity — which made
 * `ChatMessageRow`'s memo miss for the entire thread and re-ran `mergeAssistantRun`,
 * `groupParts` (diff stats included) and a full `react-markdown` parse for every
 * message in the conversation. A hundred-turn chat hitched visibly at each turn's
 * end for a transcript that had changed in one place.
 *
 * Matching is by id rather than position, so an inserted row (a model-change divider,
 * a compaction notice) only costs the rows that actually differ. The array itself
 * keeps its identity when nothing moved at all.
 */
function reconcileMessages(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
  if (previous === next) return previous;
  const byId = new Map<string, ChatMessage>();
  for (const message of previous) byId.set(message.id, message);
  let reused = 0;
  const merged = next.map((message) => {
    const old = byId.get(message.id);
    if (old && equalValue(old, message, { left: EQUAL_BUDGET })) {
      reused += 1;
      return old;
    }
    return message;
  });
  return reused === next.length && next.length === previous.length ? previous : merged;
}

/**
 * Recompute the sidebar's 等你 set from the prompt queue.
 *
 * Returns `previous` unchanged when the set is the same. This runs on every store
 * update, coalesced token batches included, and `App` subscribes to the map by
 * identity — handing back a fresh object each time re-rendered the whole shell
 * (sidebar, composer, side pane) at the stream's flush cadence for a value that
 * only changes when a tool approval appears or is answered.
 */
function waitingFrom(
  pending: Record<string, PermissionRequest[]>,
  previous: Record<string, boolean>,
): Record<string, boolean> {
  const next: Record<string, boolean> = {};
  for (const key of Object.keys(pending)) {
    if ((pending[key]?.length ?? 0) > 0) next[key] = true;
  }
  const keys = Object.keys(next);
  const same =
    keys.length === Object.keys(previous).length && keys.every((key) => previous[key] === true);
  return same ? previous : next;
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

/**
 * The bucket an extension UI event belongs to.
 *
 * Main stamps `conversationId` on everything a session's extension publishes; an
 * event without one (a plugin that loaded globally) falls back to the chat on
 * screen, which is where such a status has always been drawn.
 */
function extensionScope(ownerId: string | null | undefined, activeId: string | null): string {
  return ownerId ?? activeId ?? "__active__";
}

/** Fire-and-forget extension UI (`notify` / `setStatus` / `setWidget` / `set_editor_text`). */
function applyExtensionUi(
  event: EngineEvent,
  ownerId: string,
  state: {
    notices: ExtensionNotice[];
    extensionStatus: Record<string, Record<string, string>>;
    extensionWidgets: Record<string, Record<string, ExtensionWidget>>;
    draft: string;
  },
): Partial<{
  notices: ExtensionNotice[];
  extensionStatus: Record<string, Record<string, string>>;
  extensionWidgets: Record<string, Record<string, ExtensionWidget>>;
  draft: string;
}> {
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
    const bucket = { ...(state.extensionStatus[ownerId] ?? {}) };
    if (typeof event.statusText === "string" && event.statusText) bucket[event.statusKey] = event.statusText;
    else delete bucket[event.statusKey];
    const extensionStatus = { ...state.extensionStatus };
    if (Object.keys(bucket).length > 0) extensionStatus[ownerId] = bucket;
    else delete extensionStatus[ownerId];
    return { extensionStatus };
  }
  if (method === "setWidget" && typeof event.widgetKey === "string") {
    const bucket = { ...(state.extensionWidgets[ownerId] ?? {}) };
    const lines = Array.isArray(event.widgetLines)
      ? event.widgetLines.filter((line): line is string => typeof line === "string")
      : [];
    const runs = Array.isArray(event.widgetRuns) ? (event.widgetRuns as TuiRun[][]) : undefined;
    if (lines.length > 0 || (runs?.length ?? 0) > 0) {
      bucket[event.widgetKey] = {
        key: event.widgetKey,
        lines,
        runs,
        placement: typeof event.widgetPlacement === "string" ? event.widgetPlacement : undefined,
      };
    } else {
      delete bucket[event.widgetKey];
    }
    const extensionWidgets = { ...state.extensionWidgets };
    if (Object.keys(bucket).length > 0) extensionWidgets[ownerId] = bucket;
    else delete extensionWidgets[ownerId];
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
      // Append rather than replace: one conversation can have several prompts parked
      // at once (a parallel subagent fan-out shares the parent's UI context). A prompt
      // whose id is already in the list is the same question redrawn, not a new one.
      const existing = pendingPermissions[conversationId] ?? [];
      pendingPermissions = {
        ...pendingPermissions,
        [conversationId]: existing.some((item) => item.id === parsed.id)
          ? existing.map((item) => (item.id === parsed.id ? parsed : item))
          : [...existing, parsed],
      };
    }
    // The engine answered for the user (timeout) or withdrew the question (abort,
    // session teardown). Either way the panel must come down: the entry it addresses
    // is gone on the engine side, so a click on it would do nothing.
    if (event.type === "extension_ui_dismiss") {
      const dismissId = typeof event.id === "string" ? event.id : "";
      const owner = typeof event.conversationId === "string" ? event.conversationId : undefined;
      if (dismissId) pendingPermissions = dropPending(pendingPermissions, dismissId, owner);
    }
    const ui = applyExtensionUi(
      event,
      extensionScope(
        typeof event.conversationId === "string" ? event.conversationId : undefined,
        state.activeId,
      ),
      { notices, extensionStatus, extensionWidgets, draft },
    );
    if (ui.notices) notices = ui.notices;
    if (ui.extensionStatus) extensionStatus = ui.extensionStatus;
    if (ui.extensionWidgets) extensionWidgets = ui.extensionWidgets;
    if (ui.draft !== undefined) {
      // Only the chat on screen owns the composer. Status and widgets are bucketed by
      // conversation (so switching to a background chat shows what it set), but the draft
      // is one value for the open composer — and a blocking-prompt event is no longer
      // filtered to the active conversation up front (it has to be seen for *every* chat,
      // so a parked approval can raise the sidebar's 等你 mark). Without this check a
      // background chat, or a subagent sharing its parent's UI context, would overwrite
      // what the user is typing.
      const owner = typeof event.conversationId === "string" ? event.conversationId : null;
      if (!owner || owner === state.activeId) draft = ui.draft;
    }
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
    permission: activePermission(pendingPermissions, state.activeId),
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
    waitingForUser: waitingFrom(pendingPermissions, state.waitingForUser),
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
 *
 * A blocking prompt is exempt for the same reason as subagent traffic: it has nothing
 * to do with the transcript, and a chat parked on one must be able to raise the
 * sidebar's 等你 mark and the approval notification while a different chat is on
 * screen. Only the *panel* is scoped to the active conversation, by `activePermission`.
 */
function belongsToTranscript(event: EngineEvent, ownerId: string | null): boolean {
  if (event.type.startsWith("subagent_")) return true;
  if (event.type === "extension_ui_request" || event.type === "extension_ui_dismiss") return true;
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
  waitingForUser: {},
  notices: [],
  extensionStatus: {},
  extensionWidgets: {},
  attachments: [],
  queued: [],
  queuePause: null,
  runInterrupted: null,
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
        // The chat just came back from the engine: if it is parked on a prompt, that
        // is news the event stream may have delivered while another chat was on screen.
        waitingForUser: waitingForUserAfter(state, session),
      };
    }),
  setModels: (models) => set({ models }),
  setStats: (stats) => set({ stats }),
  applySnapshot: (snapshot) =>
    set((state) => {
      // Drop per-conversation state for chats the catalog no longer lists. A deleted
      // chat's parked prompt would otherwise be kept forever (the sidebar cannot even
      // draw it, because the conversation is gone), and its 等你 mark with it. Only ids
      // that are definitively absent are pruned, so a snapshot cannot resurrect a run
      // mark the engine has since corrected.
      const live = new Set(snapshot.conversations.map((item) => item.id));
      const prune = <T,>(map: Record<string, T>): Record<string, T> => {
        const keys = Object.keys(map).filter((key) => !live.has(key));
        if (keys.length === 0) return map;
        const next = { ...map };
        for (const key of keys) delete next[key];
        return next;
      };
      return {
        projects: snapshot.projects,
        conversations: snapshot.conversations,
        pendingPermissions: prune(state.pendingPermissions),
        waitingForUser: prune(state.waitingForUser),
        running: prune(state.running),
      };
    }),
  setActiveId: (activeId) => {
    // The right pane is conversation-bound: switching chats swaps its tabs, its
    // active tab and its collapsed/maximized state onto the incoming chat.
    useSidePaneStore.getState().setScope(activeId);
    set((state) => ({
      activeId,
      permission: activePermission(state.pendingPermissions, activeId),
    }));
  },
  setMessages: (messages, conversationId) => {
    dropQueued();
    set((state) => {
      if (conversationId && state.activeId && conversationId !== state.activeId) return state;
      // Keep the object identity of every row the read did not actually change, so
      // the thread re-renders only where it differs.
      const reconciled = reconcileMessages(state.messages, messages);
      if (reconciled === state.messages) return state;
      return {
        messages: reconciled,
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
        partBoundary: settledBoundary(reconciled),
        running: state.running,
      };
    });
  },
  setExtensionStatus: (conversationId, status) =>
    set((state) => {
      const extensionStatus = { ...state.extensionStatus };
      if (Object.keys(status).length > 0) extensionStatus[conversationId] = { ...status };
      else delete extensionStatus[conversationId];
      return { extensionStatus };
    }),
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
  resolvePermission: (id) =>
    set((state) => {
      const conversationId = state.activeId;
      if (!conversationId) return {};
      const list = state.pendingPermissions[conversationId] ?? [];
      const remaining = list.filter((item) => item.id !== id);
      const pendingPermissions = { ...state.pendingPermissions };
      if (remaining.length > 0) pendingPermissions[conversationId] = remaining;
      else delete pendingPermissions[conversationId];
      return {
        pendingPermissions,
        permission: activePermission(pendingPermissions, state.activeId),
        waitingForUser: waitingFrom(pendingPermissions, state.waitingForUser),
      };
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
    set((state) => ({
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
      // Prompts of *other* conversations are deliberately kept, like `running`: a
      // background chat parked on an approval must not lose its question because the
      // user started a new chat. Only the id-scoped marks are rebuilt accordingly.
      waitingForUser: waitingFrom(state.pendingPermissions, state.waitingForUser),
      notices: [],
      // Only the chat on screen is being cleared: status and widgets are bucketed by
      // conversation, so a background chat's goal panel survives a new session. This
      // bucket goes because the hero has no conversation to own it.
      extensionStatus: state.activeId
        ? Object.fromEntries(Object.entries(state.extensionStatus).filter(([key]) => key !== state.activeId))
        : state.extensionStatus,
      extensionWidgets: state.activeId
        ? Object.fromEntries(Object.entries(state.extensionWidgets).filter(([key]) => key !== state.activeId))
        : state.extensionWidgets,
      // Delegated runs outlive the chat on screen: wiping these made a background
      // subagent's pane empty after a new-session / archive, and nothing would have
      // rebuilt the stream until the next token.
      preview: null,
      queued: [],
      queuePause: null,
      runInterrupted: null,
    }));
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
  forgetConversationExtensionState: (conversationId) =>
    set((state) => {
      if (!(conversationId in state.extensionStatus) && !(conversationId in state.extensionWidgets)) {
        return state;
      }
      const extensionStatus = { ...state.extensionStatus };
      const extensionWidgets = { ...state.extensionWidgets };
      delete extensionStatus[conversationId];
      delete extensionWidgets[conversationId];
      return { extensionStatus, extensionWidgets };
    }),
  };
});

function upsertSubagent(list: SubagentInfo[], event: EngineEvent): SubagentInfo[] {
  if (
    event.type !== "subagent_lifecycle" &&
    event.type !== "subagent_progress" &&
    event.type !== "subagent_state"
  ) {
    return list;
  }
  const id = typeof event.subagentId === "string" ? event.subagentId : typeof event.id === "string" ? event.id : "";
  if (!id) return list;
  const previous = list.find((item) => item.id === id);
  const now = Date.now();
  const state = event.type === "subagent_state";
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
      !state && typeof event.status === "string" && event.status !== "running" ? now : previous?.endedAt,
    error: typeof event.error === "string" ? event.error : previous?.error,
    // A state push only ever carries these; every other event leaves them alone.
    model: isEngineModel(event.model) ? event.model : previous?.model,
    thinkingLevel: typeof event.thinkingLevel === "string" ? event.thinkingLevel : previous?.thinkingLevel,
    contextUsage: isContextUsage(event.contextUsage) ? event.contextUsage : previous?.contextUsage,
  };
  if (previous) {
    return list.map((item) => (item.id === id ? { ...item, ...next } : item));
  }
  return [next, ...list];
}

function isEngineModel(value: unknown): value is EngineModel {
  return isRecord(value) && typeof value.provider === "string" && typeof value.id === "string";
}

function isContextUsage(value: unknown): value is ContextUsage {
  return isRecord(value) && typeof value.contextWindow === "number";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
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
