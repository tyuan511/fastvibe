import { randomUUID } from "node:crypto";
import { chmodSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { PromptImage, QueuePauseReason, QueuedPrompt } from "@shared/types";

/**
 * `claimed` means the SDK agent loop has taken the object from its private queue.
 * `queuedAt` bounds transcript reconciliation: the engine message is always created
 * after its row, so an equal-text user turn older than the row cannot be it.
 */
export type StoredQueuedPrompt = QueuedPrompt & { images?: PromptImage[]; claimed?: boolean; queuedAt?: number };
export type ConversationQueueState = {
  conversationId: string;
  revision: number;
  items: QueuedPrompt[];
  pause: QueuePauseReason | null;
};

type QueueFile = {
  version: 2;
  items: StoredQueuedPrompt[];
  pauses: Record<string, QueuePauseReason>;
  revisions: Record<string, number>;
};

type QueueWriter = (file: string, state: QueueFile) => void;

const EMPTY: QueueFile = { version: 2, items: [], pauses: {}, revisions: {} };

function validItem(value: unknown): value is StoredQueuedPrompt {
  if (!value || typeof value !== "object") return false;
  const item = value as Partial<StoredQueuedPrompt>;
  return typeof item.id === "string" && typeof item.conversationId === "string" &&
    typeof item.text === "string" && (item.behavior === "steer" || item.behavior === "followUp");
}

function cloneState(state: QueueFile): QueueFile {
  return {
    version: 2,
    items: state.items.map((item) => ({ ...item, images: item.images?.map((image) => ({ ...image })) })),
    pauses: { ...state.pauses },
    revisions: { ...state.revisions },
  };
}

export function normalizeQueueFile(value: unknown): QueueFile {
  if (!value || typeof value !== "object") return cloneState(EMPTY);
  const source = value as { items?: unknown; pauses?: unknown; revisions?: unknown };
  const loaded = Array.isArray(source.items) ? source.items.filter(validItem) : [];
  // The process died before it could acknowledge these rows. A row the run never took
  // (`sending` alone) was never delivered and becomes pending. A claimed row may be in
  // the transcript, so it stays claimed until the session loads and is reconciled
  // against it (`findDeliveredClaims`) — turning it pending here replayed turns that
  // had already been sent. Either way the conversation is paused for the user.
  const uncertainConversations = new Set(
    loaded.filter((item) => item.claimed === true || item.sending === true).map((item) => item.conversationId),
  );
  const items = loaded.map((item) =>
    item.claimed === true ? { ...item, claimed: true, sending: true } : { ...item, claimed: undefined, sending: undefined },
  );
  const pauses: Record<string, QueuePauseReason> = {};
  if (source.pauses && typeof source.pauses === "object") {
    for (const [id, reason] of Object.entries(source.pauses)) {
      if (reason === "stopped" || reason === "error") pauses[id] = reason;
    }
  }
  for (const id of uncertainConversations) pauses[id] = "error";
  const revisions: Record<string, number> = {};
  if (source.revisions && typeof source.revisions === "object") {
    for (const [id, revision] of Object.entries(source.revisions)) {
      if (typeof revision === "number" && Number.isSafeInteger(revision) && revision >= 0) revisions[id] = revision;
    }
  }
  return { version: 2, items, pauses, revisions };
}

export function reorderConversationItems(
  items: StoredQueuedPrompt[],
  conversationId: string,
  ids: string[],
): StoredQueuedPrompt[] {
  const movable = items.filter((item) => item.conversationId === conversationId && !item.claimed);
  const byId = new Map(movable.map((item) => [item.id, item]));
  const ordered: StoredQueuedPrompt[] = [];
  for (const id of ids) {
    const item = byId.get(id);
    if (!item) continue;
    ordered.push(item);
    byId.delete(id);
  }
  for (const item of movable) if (byId.delete(item.id)) ordered.push(item);
  let index = 0;
  return items.map((item) => item.conversationId === conversationId && !item.claimed ? ordered[index++] : item);
}

/**
 * Which claimed rows the transcript shows were delivered.
 *
 * Identity is gone once the acknowledgement was missed (a failed flush, a restart),
 * so this falls back to the payload text, bounded below by the row's `queuedAt` and
 * matching each transcript turn at most once, oldest first. A claimed row with no
 * match never reached the transcript and is safe to send again.
 */
export function findDeliveredClaims(
  items: StoredQueuedPrompt[],
  userTurns: Array<{ text: string; timestamp?: number }>,
): Set<string> {
  const delivered = new Set<string>();
  const used = new Set<number>();
  for (const item of items) {
    if (!item.claimed) continue;
    const text = item.sentText ?? item.text;
    const index = userTurns.findIndex((turn, at) =>
      !used.has(at) && turn.text === text && (item.queuedAt === undefined || (turn.timestamp ?? 0) >= item.queuedAt));
    if (index < 0) continue;
    used.add(index);
    delivered.add(item.id);
  }
  return delivered;
}

function writeQueueFile(file: string, state: QueueFile): void {
  const temporary = `${file}.tmp`;
  writeFileSync(temporary, JSON.stringify(state, null, 2), { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}

/** Exact-object acknowledgement; equal text or FIFO position is intentionally irrelevant. */
export class SdkQueueClaims {
  readonly #ids = new WeakMap<object, string>();

  claim(message: object, id: string): void {
    this.#ids.set(message, id);
  }

  take(message: object): string | undefined {
    const id = this.#ids.get(message);
    if (id) this.#ids.delete(message);
    return id;
  }
}

/** Durable queue state. Every mutation commits to disk before becoming visible. */
export class MessageQueueStore {
  #state: QueueFile;
  readonly #file: string;
  readonly #writer: QueueWriter;

  constructor(file: string, writer: QueueWriter = writeQueueFile) {
    this.#file = file;
    this.#writer = writer;
    try {
      this.#state = normalizeQueueFile(JSON.parse(readFileSync(file, "utf8")));
    } catch (error) {
      // A first run has no queue file; every other failure must remain visible. Treating
      // a corrupt or temporarily unreadable file as empty would overwrite durable prompts
      // on the next mutation and silently lose work.
      if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") {
        this.#state = cloneState(EMPTY);
      } else {
        throw new Error(`Unable to read durable message queue: ${file}`, { cause: error });
      }
    }
  }

  state(conversationId: string): ConversationQueueState {
    return {
      conversationId,
      revision: this.#state.revisions[conversationId] ?? 0,
      items: this.#state.items.filter((item) => item.conversationId === conversationId).map(({ images: _images, ...item }) => ({ ...item })),
      pause: this.#state.pauses[conversationId] ?? null,
    };
  }

  conversationIds(): string[] {
    return [...new Set(this.#state.items.map((item) => item.conversationId))];
  }

  all(conversationId: string): StoredQueuedPrompt[] {
    return this.#state.items.filter((item) => item.conversationId === conversationId).map((item) => ({ ...item }));
  }

  get(id: string): StoredQueuedPrompt | undefined {
    const item = this.#state.items.find((entry) => entry.id === id);
    return item ? { ...item } : undefined;
  }

  add(input: Omit<StoredQueuedPrompt, "id">): StoredQueuedPrompt {
    const item = { ...input, id: randomUUID(), queuedAt: Date.now() };
    this.#mutate((next) => { next.items.push(item); this.#touch(next, item.conversationId); });
    return { ...item };
  }

  remove(id: string): StoredQueuedPrompt | undefined {
    let removed: StoredQueuedPrompt | undefined;
    this.#mutate((next) => {
      const index = next.items.findIndex((item) => item.id === id);
      if (index < 0) return false;
      [removed] = next.items.splice(index, 1);
      this.#touch(next, removed.conversationId);
    });
    return removed ? { ...removed } : undefined;
  }

  /** Reinsert an exact id when an SDK-side cancellation loses its race. */
  restore(item: StoredQueuedPrompt): void {
    this.#mutate((next) => {
      if (next.items.some((entry) => entry.id === item.id)) return false;
      next.items.push({ ...item, images: item.images?.map((image) => ({ ...image })) });
      this.#touch(next, item.conversationId);
    });
  }

  update(id: string, patch: Partial<StoredQueuedPrompt>): StoredQueuedPrompt | undefined {
    let updated: StoredQueuedPrompt | undefined;
    this.#mutate((next) => {
      const item = next.items.find((entry) => entry.id === id);
      if (!item) return false;
      Object.assign(item, patch);
      this.#touch(next, item.conversationId);
      updated = item;
    });
    return updated ? { ...updated } : undefined;
  }

  /** Return a rejected handoff to pending and pause it in one durable commit. */
  fail(id: string, reason: QueuePauseReason): StoredQueuedPrompt | undefined {
    let updated: StoredQueuedPrompt | undefined;
    this.#mutate((next) => {
      const item = next.items.find((entry) => entry.id === id);
      if (!item) return false;
      item.claimed = false;
      item.sending = false;
      next.pauses[item.conversationId] = reason;
      this.#touch(next, item.conversationId);
      updated = item;
    });
    return updated ? { ...updated } : undefined;
  }

  reorder(conversationId: string, ids: string[]): void {
    this.#mutate((next) => {
      next.items = reorderConversationItems(next.items, conversationId, ids);
      this.#touch(next, conversationId);
    });
  }

  pause(conversationId: string, reason: QueuePauseReason | null): void {
    this.#mutate((next) => {
      if (reason) next.pauses[conversationId] = reason;
      else delete next.pauses[conversationId];
      this.#touch(next, conversationId);
    });
  }

  /** Return SDK-queued (not yet claimed) objects to pending and set the stop latch atomically. */
  restorePending(conversationId: string, ids: ReadonlySet<string>, reason: QueuePauseReason): boolean {
    let changed = false;
    this.#mutate((next) => {
      for (const item of next.items) {
        if (item.conversationId !== conversationId || !ids.has(item.id) || item.claimed) continue;
        if (item.sending) changed = true;
        item.sending = false;
      }
      if (next.pauses[conversationId] !== reason) changed = true;
      next.pauses[conversationId] = reason;
      if (!changed) return false;
      this.#touch(next, conversationId);
    });
    return changed;
  }

  /** Reset every unclaimed row when its SDK owner no longer exists. */
  resetUnclaimed(conversationId: string, reason: QueuePauseReason): boolean {
    let changed = false;
    this.#mutate((next) => {
      for (const item of next.items) {
        if (item.conversationId !== conversationId || item.claimed) continue;
        if (item.sending) {
          item.sending = false;
          changed = true;
        }
      }
      if (next.pauses[conversationId] !== reason) {
        next.pauses[conversationId] = reason;
        changed = true;
      }
      if (!changed) return false;
      this.#touch(next, conversationId);
    });
    return changed;
  }

  /**
   * Settle every claimed row in one commit: delivered rows leave, the rest become
   * pending. The pause is released only when nothing is left to hold.
   */
  resolveClaims(conversationId: string, delivered: ReadonlySet<string>): boolean {
    let changed = false;
    this.#mutate((next) => {
      next.items = next.items.filter((item) => {
        if (item.conversationId !== conversationId || !item.claimed) return true;
        changed = true;
        if (delivered.has(item.id)) return false;
        item.claimed = false;
        item.sending = false;
        return true;
      });
      if (!changed) return false;
      if (!next.items.some((item) => item.conversationId === conversationId)) delete next.pauses[conversationId];
      this.#touch(next, conversationId);
    });
    return changed;
  }

  clear(conversationId: string): void {
    this.#mutate((next) => {
      next.items = next.items.filter((item) => item.conversationId !== conversationId);
      delete next.pauses[conversationId];
      this.#touch(next, conversationId);
    });
  }

  #touch(state: QueueFile, conversationId: string): void {
    state.revisions[conversationId] = (state.revisions[conversationId] ?? 0) + 1;
  }

  #mutate(change: (next: QueueFile) => false | void): void {
    const next = cloneState(this.#state);
    if (change(next) === false) return;
    this.#writer(this.#file, next);
    this.#state = next;
  }
}
