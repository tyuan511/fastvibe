import type { EventCursor, EventMeta, SubscriptionResult } from "../protocol/client.ts";
import { t } from "../i18n/core.ts";

type Event = Record<string, unknown>;
export type Snapshot = { seq: number; messages?: unknown; queue?: unknown; messageMode?: "tail" | "full" | "window"; messageAnchorId?: string;
  running?: boolean; pendingUi?: unknown[]; history?: { beforeEntryId: string | null } };
export type SyncCheckpoint = { cursor: EventCursor; floor: number };
type Held = { event: Event; meta?: EventMeta };
type Options = {
  isCurrent?: () => boolean;
  subscribe: (cursor?: EventCursor) => Promise<SubscriptionResult>;
  load: () => Promise<Snapshot>;
  snapshot: (snapshot: Snapshot) => void;
  event: (event: Event) => void;
  error: (error: unknown) => void;
  restored?: (replayed: boolean) => void;
};

/** Engine seq filters snapshot overlap; protocol cursors resume the named journal.
 * They are deliberately separate: neither sequence can stand in for the other. */
export class SnapshotSync {
  #options: Options;
  #floor = 0;
  #cursor?: EventCursor;
  #valid = false;
  #restoring = true;
  #closed = false;
  #held: Held[] = [];
  #overflow = false;
  #loading: Promise<void> | null = null;
  #timer: ReturnType<typeof setTimeout> | null = null;
  #dirty = false;
  #waiters: Array<{ resolve: () => void; reject: (error: unknown) => void; afterSeq?: number }> = [];

  constructor(options: Options) { this.#options = options; }
  #active(): boolean { return !this.#closed && (this.#options.isCurrent?.() ?? true); }

  async restore(seed?: SyncCheckpoint): Promise<void> {
    try {
      if (!seed) {
        // A cold open doesn't need the journal. Pipeline subscribe and snapshot
        // on the same ordered socket instead of adding another round trip.
        const subscription = this.#options.subscribe();
        const [result] = await Promise.all([subscription, this.#read()]);
        if (!this.#active()) return;
        if (result.cursor && (!this.#cursor || this.#cursor.seq < result.cursor.seq)) this.#cursor = result.cursor;
        this.#options.restored?.(false);
        return;
      }
      const subscription = await this.#options.subscribe(seed?.cursor);
      if (!this.#active()) return;
      this.#cursor = subscription.cursor;
      if (seed && subscription.resumed && !this.#overflow) {
        this.#floor = seed.floor;
        this.#valid = true;
        this.#restoring = false;
        this.#drain();
        this.#options.restored?.(true);
      } else {
        // A host restart can reset engine seq as well as the protocol epoch.
        this.#floor = 0;
        await this.#read();
        if (this.#active()) this.#options.restored?.(false);
      }
    } finally {
      if (this.#active()) {
        this.#restoring = false;
        if (this.#dirty) this.#schedule();
      }
    }
  }

  receive(event: Event, meta?: EventMeta): void {
    if (!this.#active()) return;
    if (this.#restoring || this.#loading) {
      if (this.#held.length < 2048) this.#held.push({ event, meta });
      else this.#overflow = true; // Fall back to another authoritative snapshot, never certify a gap.
      if (!this.#valid || this.#restoring) return;
    }
    this.#apply(event, meta);
  }

  /** Coalesce boundaries; an in-flight read can have at most one follow-up read. */
  refresh(afterSeq?: number): Promise<void> {
    if (!this.#active()) return Promise.resolve();
    this.#dirty = true;
    const promise = new Promise<void>((resolve, reject) => this.#waiters.push({ resolve, reject, afterSeq }));
    this.#schedule();
    return promise;
  }

  checkpoint(): SyncCheckpoint | undefined {
    return this.#valid && !this.#restoring && !this.#loading && !this.#dirty && !this.#overflow && this.#cursor
      ? { cursor: { ...this.#cursor }, floor: this.#floor } : undefined;
  }

  dispose(): void {
    this.#closed = true;
    if (this.#timer) clearTimeout(this.#timer);
    this.#timer = null;
    this.#held = [];
    for (const waiter of this.#waiters.splice(0)) waiter.resolve();
  }

  #schedule(): void {
    if (!this.#active() || this.#restoring || this.#loading || this.#timer) return;
    this.#timer = setTimeout(() => {
      this.#timer = null;
      void this.#read().catch((error) => { if (this.#active()) this.#options.error(error); });
    }, 50);
  }

  #read(): Promise<void> {
    if (!this.#active()) {
      for (const waiter of this.#waiters.splice(0)) waiter.resolve();
      return Promise.resolve();
    }
    if (this.#loading) return this.#loading;
    this.#dirty = false;
    const waiters = this.#waiters.splice(0);
    // A new read supersedes events already known at its dispatch; later events
    // are still held and reconciled against the snapshot's atomic engine seq.
    this.#held = [];
    this.#overflow = false;
    this.#loading = Promise.resolve().then(() => this.#options.load()).then((snapshot) => {
      if (!this.#active()) return;
      if (!Number.isSafeInteger(snapshot.seq) || snapshot.seq < 0) throw new Error(t("chat.loadFailed"));
      this.#options.snapshot(snapshot);
      this.#floor = snapshot.seq;
      this.#valid = true;
      this.#restoring = false;
      this.#drain();
      // A boundary may reach the phone after dispatch but before the host reads
      // its snapshot. Its engine seq proves when that read already includes it.
      // Manual refreshes have no watermark and still require their own read.
      const pending = this.#waiters;
      this.#waiters = [];
      for (const waiter of pending) {
        if (typeof waiter.afterSeq === "number" && Number.isSafeInteger(waiter.afterSeq) &&
            waiter.afterSeq >= 0 && waiter.afterSeq <= snapshot.seq) waiter.resolve();
        else this.#waiters.push(waiter);
      }
      this.#dirty = this.#overflow || this.#waiters.length > 0;
      if (this.#overflow) this.#valid = false;
      for (const waiter of waiters) waiter.resolve();
    }).catch((error) => {
      for (const waiter of waiters) waiter.reject(error);
      // Keep already displayed live events, but don't use an uncertain cursor to resume.
      this.#valid = false;
      throw error;
    }).finally(() => {
      if (!this.#active()) for (const waiter of waiters) waiter.resolve();
      this.#loading = null;
      if (this.#dirty) this.#schedule();
    });
    return this.#loading;
  }

  #drain(): void {
    const held = this.#held;
    this.#held = [];
    // The wildcard may deliver live frames before a named replay is requested.
    // Merge these two sources by their server sequence, never by arrival time.
    held.sort((a, b) => Number(a.meta?.seq ?? a.event.seq ?? 0) - Number(b.meta?.seq ?? b.event.seq ?? 0));
    for (const { event, meta } of held) this.#apply(event, meta, true);
  }

  #apply(event: Event, meta?: EventMeta, reconcile = false): void {
    // A gateway's upstream engine can restart without resetting this socket's
    // protocol sequence. Use the wire cursor for ordinary live deduplication;
    // the engine floor only reconciles a snapshot/replay window.
    if (!reconcile && meta && this.#cursor?.epoch === meta.epoch && meta.seq <= this.#cursor.seq) return;
    if (meta && (!this.#cursor || this.#cursor.epoch !== meta.epoch || meta.seq > this.#cursor.seq)) {
      this.#cursor = { epoch: meta.epoch, seq: meta.seq };
    }
    if ((reconcile || !meta) && typeof event.seq === "number" && event.seq <= this.#floor) return;
    this.#options.event(event);
    if (typeof event.seq === "number") this.#floor = event.seq;
  }
}
