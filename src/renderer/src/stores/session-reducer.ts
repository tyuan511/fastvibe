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

export function settledBoundary(messages: ChatMessage[]): number {
  const last = messages.at(-1);
  return last?.role === "assistant" ? (last.parts?.length ?? 0) : 0;
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
  if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor" && method !== "questions" && method !== "plan_review") {
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
    plan:
      event.plan && typeof event.plan === "object"
        ? (() => {
            const plan = event.plan as Record<string, unknown>;
            return typeof plan.path === "string" && typeof plan.title === "string" && typeof plan.summary === "string"
              ? { path: plan.path, title: plan.title, summary: plan.summary }
              : undefined;
          })()
        : undefined,
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

