import { randomUUID } from "../../../shared/random.ts";
import type {
  ChatMessage,
  EngineEvent,
  EngineSessionState,
  ExtensionNotice,
  ExtensionNoticeLevel,
  ExtensionWidget,
  PermissionQuestion,
  PermissionRequest,
  TuiRun,
} from "@shared/types";

/**
 * The one queued message drawn as a sent turn ahead of the engine (立即).
 *
 * `over` is the work that was on screen at the click and has not ended yet: the
 * reply being stopped for this message, or a standalone compaction it waits behind.
 * Until that ends, what the engine still says belongs *above* the new turn.
 * `revision` is the queue revision the click was made against, so only a snapshot
 * newer than the click can say the message is being held.
 */
export type SentNow = {
  conversationId: string;
  id: string;
  over: "run" | "compaction" | null;
  revision: number;
};

const QUEUED_TURN = "queue:";
const QUEUED_REPLY = "queue-reply:";

/**
 * One queued message drawn as a sent turn, before Main has stopped the run it
 * interrupts: the prompt, and the reply it is about to get. `queue:<id>` is what the
 * engine's echo is matched against, so the row it persists replaces this one instead
 * of appearing beside it.
 */
export function optimisticQueuedTurn(item: {
  id: string;
  text: string;
  attachments?: ChatMessage["attachments"];
}): ChatMessage[] {
  const now = Date.now();
  const text = item.text;
  return [
    {
      id: `${QUEUED_TURN}${item.id}`,
      role: "user",
      text,
      tools: [],
      parts: text ? [{ kind: "text", text }] : [],
      createdAt: now,
      attachments: item.attachments,
    },
    { id: `${QUEUED_REPLY}${item.id}`, role: "assistant", text: "", tools: [], parts: [], createdAt: now },
  ];
}

/**
 * Split the turn drawn at 立即 off the transcript it was appended to.
 *
 * There is at most one, and it is always the tail: nothing is written after it until
 * its own run starts, and by then the engine has adopted the prompt.
 */
export function splitOptimisticTail(messages: ChatMessage[]): { base: ChatMessage[]; tail: ChatMessage[] } {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].id.startsWith(QUEUED_TURN)) {
      return { base: messages.slice(0, index), tail: messages.slice(index) };
    }
  }
  return { base: messages, tail: [] };
}

function hasContent(message: ChatMessage | undefined): boolean {
  if (!message) return false;
  return Boolean(message.text || message.thinking || message.error || message.tools.length > 0 || (message.parts?.length ?? 0) > 0);
}

/**
 * Take the turn drawn at 立即 back out of the transcript: the engine is not sending
 * it now, and its row belongs in the queue tray again.
 *
 * A reply that already has content is not a placeholder any more — the run did
 * start, and only the acknowledgement was missed. That turn is kept and the prompt
 * becomes an ordinary sent row, which the next transcript read replaces.
 */
export function retractOptimisticTurn(messages: ChatMessage[]): ChatMessage[] {
  const { base, tail } = splitOptimisticTail(messages);
  if (tail.length === 0) return messages;
  const [prompt, ...rest] = tail;
  if (rest.some(hasContent)) {
    return [...base, { ...prompt, id: `local:${prompt.id.slice(QUEUED_TURN.length)}` }, ...rest];
  }
  return [...base, ...rest.filter((message) => !message.id.startsWith(QUEUED_REPLY))];
}

type TranscriptStep = {
  messages: ChatMessage[];
  streaming: boolean;
  interrupted?: "aborted" | "error";
  partBoundary?: number;
};

/**
 * Apply one engine event to a transcript that may hold a turn drawn at 立即.
 *
 * Everything the transcript reducer does is addressed to "the trailing reply", and
 * the click put a new, empty one there while the old run was still talking. Applied
 * as given, the rest of that run — its last deltas, its tool results, the 已中断
 * stamp of its own abort — landed in the new turn, and vanished again when the
 * transcript was next read. So until the old work ends (`over`), events are applied
 * to the transcript above the turn.
 *
 * It is also where the turn stops being ours: adopted once the engine has echoed the
 * prompt, taken back when the engine says it is sending something else or nothing.
 */
export function applyAroundSentNow(
  view: { messages: ChatMessage[]; streaming: boolean; boundary: number; sentNow: SentNow | null },
  event: EngineEvent,
  apply: (messages: ChatMessage[], event: EngineEvent, streaming: boolean, boundary: number) => TranscriptStep,
): TranscriptStep & { sentNow: SentNow | null; adopted?: string } {
  let { messages, sentNow } = view;
  const type = event.type;
  // 立即 replaced this run: its end is not an interruption to recover from, and its
  // settle is not the chat going idle. Main says so itself for a client that drew
  // nothing; one that did also knows from the turn it is holding.
  const replaced = event.replaced === true;
  // Subagent and prompt traffic is applied whichever chat is on screen; only what the
  // turn's own conversation says is read as being about it.
  if (sentNow && typeof event.conversationId === "string" && event.conversationId !== sentNow.conversationId) {
    return { ...apply(messages, event, view.streaming, view.boundary), sentNow };
  }
  if (!sentNow) {
    const applied = apply(messages, event, view.streaming, view.boundary);
    return {
      ...applied,
      streaming: replaced && type === "agent_settled" ? view.streaming : applied.streaming,
      interrupted: replaced ? undefined : applied.interrupted,
      sentNow: null,
    };
  }
  const userEcho = type === "message_start" && (event.message as { role?: unknown } | undefined)?.role === "user";
  const echoId: unknown = userEcho ? event.queueId : undefined;
  // The prompt of this very turn is being echoed, so its run has begun whatever the
  // hold believes; holding on would write that run above its own prompt.
  if (sentNow.over && echoId === sentNow.id) sentNow = { ...sentNow, over: null };
  // Main lowered the mark while the turn is still only ours: no run is coming for it.
  // The same goes for a user turn that is somebody else's — the engine is sending
  // that one, not this. (`undefined` is an engine that does not say; keep the turn.)
  const idle = type === "conversation_running" && event.running !== true;
  const other = userEcho && !sentNow.over && echoId !== undefined && echoId !== sentNow.id;
  if (idle || other) {
    messages = retractOptimisticTurn(messages);
    sentNow = null;
    return { ...apply(messages, event, view.streaming, view.boundary), sentNow };
  }
  let applied: TranscriptStep;
  if (sentNow.over) {
    const { base, tail } = splitOptimisticTail(messages);
    applied = apply(base, event, view.streaming, view.boundary);
    applied = { ...applied, messages: tail.length > 0 ? [...applied.messages, ...tail] : applied.messages };
    const ended = sentNow.over === "run"
      ? type === "agent_settled"
      : type === "compaction_end" || type === "auto_compaction_end";
    // The stop of the run being replaced is the click's own doing, not a verdict.
    if (sentNow.over === "run") applied = { ...applied, interrupted: undefined };
    if (ended) sentNow = { ...sentNow, over: null };
  } else {
    applied = apply(messages, event, view.streaming, view.boundary);
  }
  if (replaced) applied = { ...applied, interrupted: undefined };
  // Whatever just settled, the turn on screen has not run yet.
  if (type === "agent_settled") applied = { ...applied, streaming: true };
  const prompt = `${QUEUED_TURN}${sentNow.id}`;
  // The engine's acknowledgement renames the prompt row; without it the turn is the
  // engine's and no longer ours to take back.
  const pending = applied.messages.some((message) => message.id === prompt);
  return pending ? { ...applied, sentNow } : { ...applied, sentNow: null, adopted: sentNow.id };
}

export function settledBoundary(messages: ChatMessage[]): number {
  const last = messages.at(-1);
  return last?.role === "assistant" ? (last.parts?.length ?? 0) : 0;
}

/**
 * A transcript read says nothing about a turn the user just sent.
 *
 * The turn is drawn the instant 立即 is pressed, while the run it interrupts is still
 * being stopped. A reload that lands in that window — the interrupted run's own
 * `agent_settled` triggers one — replays a transcript that does not hold the turn yet,
 * and applying it as given erased the row until the next prompt was finally accepted.
 *
 * Only for the conversation the turn was sent in (`keep`): the read that opens
 * another chat replaces a transcript that still holds it, and carried it across.
 *
 * The read can also land *after* the engine took the prompt: the stop and the next
 * prompt are a few milliseconds apart, so the transcript already holds the turn while
 * the echo that adopts the drawn one is still on its way. Appending the drawn turn
 * then showed the message twice, and the echo's rename gave both rows one id. Nothing
 * of that turn has reached this client yet — its events all follow the echo — so the
 * transcript's copy and what came after it are cut, and the drawn turn stands in for
 * them until the stream (or the next read) fills it in.
 */
export function preserveOptimisticTail(previous: ChatMessage[], next: ChatMessage[], keep: boolean): ChatMessage[] {
  if (!keep) return next;
  const { base, tail } = splitOptimisticTail(previous);
  if (tail.length === 0) return next;
  const known = new Set(base.map((message) => message.id));
  const text = tail[0].text.trim();
  for (let index = next.length - 1; index >= 0; index -= 1) {
    const row = next[index];
    if (row.role === "user" && !known.has(row.id) && row.text.trim() === text) {
      return [...next.slice(0, index), ...tail];
    }
  }
  return [...next, ...tail];
}

/**
 * Mirror the active conversation's busy state into the per-conversation map so the
 * sidebar lights up the moment a prompt is sent, without waiting for the engine's
 * `agent_start` IPC round-trip.
 */
export function activeRunning(
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

export function parsePermission(event: EngineEvent): PermissionRequest | null {
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
    prefill: typeof event.prefill === "string" ? event.prefill : undefined,
    options: parseStringList(event.options),
    optionDetails: parseOptionDetails(event.optionDetails),
    questions: parseQuestions(event.questions),
    timeout: typeof event.timeout === "number" ? event.timeout : undefined,
  };
}

/** Remove one prompt by id, optionally restricted to its owner conversation. */
export function dropPending(
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
/** `map` without `key`, keeping its identity when there is nothing to remove. */
export function withoutKey<T>(map: Record<string, T>, key: string | null): Record<string, T> {
  if (!key || !(key in map)) return map;
  const next = { ...map };
  delete next[key];
  return next;
}

export function waitingForUserAfter(
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
export function reconcileMessages(previous: ChatMessage[], next: ChatMessage[]): ChatMessage[] {
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
export function waitingFrom(
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
export const COALESCED_EVENTS = new Set([
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
export function extensionScope(ownerId: string | null | undefined, activeId: string | null): string {
  return ownerId ?? activeId ?? "__active__";
}

/** Fire-and-forget extension UI (`notify` / `setStatus` / `setWidget` / `set_editor_text`). */
export function applyExtensionUi(
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
    const next = [...state.notices, { id: String(event.id ?? randomUUID()), message: event.message, level, createdAt: Date.now() }];
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

