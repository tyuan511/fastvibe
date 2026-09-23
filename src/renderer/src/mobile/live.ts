import { conversationScope } from "@shared/app-protocol";
import type { ConversationSnapshot, EngineEvent, WorkspaceSnapshot } from "@shared/types";
import { createConversationRefresh } from "@/lib/conversation-refresh";
import { engine } from "@/lib/engine-client";
import { onLiveReconnected, watchScope } from "@/lib/live-scopes";
import { useSessionStore } from "@/stores/session";

/**
 * How the phone page follows conversations.
 *
 * The desktop opens a chat with `conversations.open`, which makes it the engine's
 * active conversation — the one value every window follows. The phone must not do
 * that: opening a chat in your pocket would yank the desktop onto it. So it never
 * calls `open`. It reads a chat with `engine:get-snapshot` (transcript, the reply in
 * flight, parked prompts and the queue, all at one instant) and asks for that chat's
 * live stream by subscribing to its scope by name, which Main answers even while the
 * chat is in the background (`PiProcessManager.setStreamWatch`).
 *
 * Ordering: the scope is subscribed *before* the snapshot is requested, events for the
 * chat that arrive meanwhile are held, and once the snapshot lands only those numbered
 * above its `seq` are applied. Nothing is lost in between and nothing is drawn twice.
 */

const { reloadActiveState, reloadActiveMessages, refreshStats } = createConversationRefresh(
  engine,
  useSessionStore.getState,
);

let releaseScope: (() => void) | null = null;
/** Bumped per `showConversation`, so a slow snapshot cannot land on a newer choice. */
let ticket = 0;
/** Set while the chat on screen is waiting for its snapshot; its events are held. */
let loadingId: string | null = null;
let held: EngineEvent[] = [];
/** Events for the chat on screen at or below this were already in its snapshot. */
let floor = 0;

const listeners = new Set<(state: LoadState) => void>();
export type LoadState = { id: string | null; loading: boolean; error: string | null };
let loadState: LoadState = { id: null, loading: false, error: null };

function setLoadState(next: LoadState): void {
  loadState = next;
  for (const listener of [...listeners]) listener(next);
}

export function getLoadState(): LoadState {
  return loadState;
}

export function onLoadState(listener: (state: LoadState) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Put one conversation on screen (or none, for the list and the new-chat page).
 *
 * `quiet` re-reads the chat already shown — a reconnect — without blanking it first:
 * the transcript on screen was right up to the moment the socket went.
 */
export async function showConversation(id: string | null, options?: { quiet?: boolean }): Promise<void> {
  const mine = ++ticket;
  const store = useSessionStore.getState();
  if (!options?.quiet || store.activeId !== id) {
    releaseScope?.();
    releaseScope = null;
    if (store.activeId !== id) {
      store.resetConversation();
      store.setActiveId(id);
    }
    if (id) releaseScope = watchScope(conversationScope(id));
  }
  held = [];
  floor = 0;
  if (!id) {
    loadingId = null;
    setLoadState({ id: null, loading: false, error: null });
    return;
  }
  loadingId = id;
  setLoadState({ id, loading: !options?.quiet, error: null });
  try {
    const snapshot = await window.fastvibe.engine.getSnapshot(id);
    if (mine !== ticket) return;
    applyConversationSnapshot(id, snapshot);
    const events = held;
    held = [];
    loadingId = null;
    for (const event of events) routeEvent(event);
    setLoadState({ id, loading: false, error: null });
    // Model, context usage and 继续 come from the state, which the snapshot does not carry.
    void engine
      .getState(id)
      .then((state) => {
        if (mine === ticket) useSessionStore.getState().setSession(state);
      })
      .catch(() => undefined);
  } catch (error) {
    if (mine !== ticket) return;
    loadingId = null;
    held = [];
    setLoadState({ id, loading: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function applyConversationSnapshot(id: string, snapshot: ConversationSnapshot): void {
  const store = useSessionStore.getState();
  store.setMessages(snapshot.messages, id);
  store.setConversationRunning(id, snapshot.running);
  store.setStreaming(snapshot.running);
  if (snapshot.queue.conversationId === id) store.setQueueState(snapshot.queue);
  // The snapshot's parked prompts are the whole truth for this chat: one answered on the
  // desktop while this page was away has to come down, not linger as a panel whose
  // answer would go nowhere.
  const parked = new Set(snapshot.pendingUi.map((request) => request.id));
  for (const request of store.pendingPermissions[id] ?? []) {
    if (!parked.has(request.id)) store.applyEvent({ type: "extension_ui_dismiss", id: request.id, conversationId: id });
  }
  for (const request of snapshot.pendingUi) store.applyEvent(request as EngineEvent);
  // Panel state the transcript has no place for (a retry banner, a todo list). A turn
  // that overflowed its buffer is not replayed with a hole in it; the end-of-turn read
  // brings the transcript up to date instead.
  if (!snapshot.overflowed) {
    for (const event of snapshot.turnEvents) store.applyEvent(event as EngineEvent);
  }
  floor = snapshot.seq;
}

/** Read the conversation list and the busy / waiting marks from scratch. */
export async function refreshCatalog(): Promise<void> {
  const [snapshot, running, pending] = await Promise.all([
    window.fastvibe.conversations.list(),
    window.fastvibe.engine.getRunning().catch((): string[] => []),
    window.fastvibe.engine.getPendingUi().catch((): Array<Record<string, unknown>> => []),
  ]);
  const store = useSessionStore.getState();
  store.applySnapshot(snapshot);
  const busy = new Set(running);
  for (const conversation of snapshot.conversations) {
    store.setConversationRunning(conversation.id, busy.has(conversation.id));
  }
  for (const request of pending) store.applyEvent(request as EngineEvent);
}

const RUN_BOUNDARIES = new Set(["agent_end", "agent_settled", "compaction_end", "auto_compaction_end"]);

function isFailedEnd(event: EngineEvent): boolean {
  if (event.type === "compaction_end" || event.type === "auto_compaction_end") {
    return event.aborted === true || Boolean(event.errorMessage);
  }
  return (
    event.type === "agent_end" &&
    Array.isArray(event.messages) &&
    event.messages.some(
      (item) =>
        Boolean(item) &&
        typeof item === "object" &&
        (item as { stopReason?: unknown }).stopReason === "error",
    )
  );
}

/**
 * One engine event, routed the way the desktop shell routes it, minus the parts that
 * have no screen here (side pane, file previews, subagent tabs).
 */
function routeEvent(event: EngineEvent): void {
  const store = useSessionStore.getState();
  const conversationId = typeof event.conversationId === "string" ? event.conversationId : null;
  // Marks and parked prompts are kept for every conversation: the list draws them.
  if (event.type === "conversation_running" && conversationId) {
    store.setConversationRunning(conversationId, event.running === true);
  }
  if (event.type === "queue_changed" && event.queue && typeof event.queue === "object") {
    store.setQueueState(event.queue as import("@shared/types").ConversationQueueState);
    return;
  }
  if (event.type === "extension_ui_request" || event.type === "extension_ui_dismiss") {
    store.applyEvent(event);
    return;
  }
  if (event.type === "conversation_renamed" && event.snapshot && typeof event.snapshot === "object") {
    store.applySnapshot(event.snapshot as WorkspaceSnapshot);
  }
  if (event.type.startsWith("subagent_")) {
    store.applyEvent(event);
    return;
  }
  if (!conversationId || conversationId !== store.activeId) return;
  if (loadingId === conversationId) {
    held.push(event);
    return;
  }
  if (typeof event.seq === "number" && event.seq <= floor) return;
  store.applyEvent(event);
  if (RUN_BOUNDARIES.has(event.type)) {
    void reloadActiveState();
    // A failed turn is already on the transcript; a re-read would race the retry that
    // drops it (the same rule the desktop shell follows).
    if (!isFailedEnd(event)) void reloadActiveMessages();
    void refreshStats();
  } else if (event.type === "turn_end" || event.type === "model_changed" || event.type === "thinking_level_changed") {
    void reloadActiveState();
  }
}

/** Wire the push channels once, for the life of the page. */
export function startLive(): () => void {
  const offEvent = window.fastvibe.engine.onEvent(routeEvent);
  const offCatalog = window.fastvibe.conversations.onChanged((snapshot) => {
    // Only the catalog. The desktop's active conversation is its own business here —
    // following it is exactly what this page exists not to do.
    useSessionStore.getState().applySnapshot(snapshot);
  });
  const offReconnect = onLiveReconnected(() => {
    void refreshCatalog().catch(() => undefined);
    const id = useSessionStore.getState().activeId;
    if (id) void showConversation(id, { quiet: true });
  });
  return () => {
    offEvent();
    offCatalog();
    offReconnect();
  };
}
