import { randomUUID } from "node:crypto";
import {
  ALL_SCOPES,
  installationScope,
  type AppEventMessage,
  type AppEventCursor,
  type AppScope,
} from "../../shared/app-protocol.ts";

export type EventRecord = {
  seq: number;
  scope: AppScope;
  epoch: string;
  channel: string;
  payload: unknown;
  eventId: string;
  at: number;
  /** Origin deliberately excluded from this event, if any. */
  except?: string;
};

export type EventBusOptions = {
  maxPerScope?: number;
  maxAgeMs?: number;
  maxScopes?: number;
  maxBytes?: number;
  now?: () => number;
  epoch?: string;
};

export const DEFAULT_MAX_PER_SCOPE = 512;
export const DEFAULT_MAX_AGE_MS = 5 * 60_000;
export const DEFAULT_MAX_SCOPES = 1024;
export const DEFAULT_MAX_BYTES = 8 * 1024 * 1024;

export type ResumeOutcome =
  | { kind: "events"; events: EventRecord[] }
  | { kind: "current" }
  | { kind: "resync"; reason: string };

type ScopeState = {
  seq: number;
  records: EventRecord[];
};

export function stableEventId(epoch: string, scope: AppScope, seq: number): string {
  return `${epoch}:${scope}:${seq}`;
}

export class EventBus {
  epoch: string;
  #scopes = new Map<AppScope, ScopeState>();
  #tombstones = new Map<AppScope, number>();
  #maxPerScope: number;
  #maxAgeMs: number;
  #maxScopes: number;
  #maxBytes: number;
  #now: () => number;

  constructor(options: EventBusOptions = {}) {
    this.epoch = options.epoch ?? randomUUID();
    this.#maxPerScope = options.maxPerScope ?? DEFAULT_MAX_PER_SCOPE;
    this.#maxAgeMs = options.maxAgeMs ?? DEFAULT_MAX_AGE_MS;
    this.#maxScopes = options.maxScopes ?? DEFAULT_MAX_SCOPES;
    this.#maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
    this.#now = options.now ?? (() => Date.now());
  }

  sequence(scope: AppScope): number {
    this.#enforceBounds();
    return this.#scopes.get(scope)?.seq ?? 0;
  }

  /**
   * Assign seq/eventId once. Independent of whether any client is attached.
   */
  publish(scope: AppScope, channel: string, payload: unknown, options?: { except?: string }): AppEventMessage {
    const state = this.#state(scope);
    state.seq += 1;
    const eventId = stableEventId(this.epoch, scope, state.seq);
    const record: EventRecord = {
      seq: state.seq,
      scope,
      epoch: this.epoch,
      channel,
      payload: clonePayload(payload),
      eventId,
      at: this.#now(),
      ...(options?.except ? { except: options.except } : {}),
    };
    state.records.push(record);
    this.#trim(state);
    this.#enforceBounds();
    return {
      kind: "event",
      scope,
      seq: record.seq,
      epoch: this.epoch,
      eventId,
      channel,
      payload: clonePayload(payload),
    };
  }

  /**
   * Catch up from `cursor`. Trims before reading.
   *
   * - empty + seq 0 + matching epoch → current
   * - empty + seq > 0 → resync
   * - pruned (since+1 older than retained) → resync
   * - future (since > seq) → resync
   * - epoch mismatch → resync
   * - `*` → resync (wildcard cannot resume)
   */
  resume(scope: AppScope, cursor: AppEventCursor, origin?: string): ResumeOutcome {
    if (scope === ALL_SCOPES) {
      return { kind: "resync", reason: "通配订阅不能回放，请按具名范围续订或重新读取快照" };
    }
    if (cursor.epoch !== this.epoch) {
      return { kind: "resync", reason: "事件纪元不匹配" };
    }
    const state = this.#scopes.get(scope);
    if (state) this.#trim(state);
    const seq = state?.seq ?? 0;
    if (!state || seq === 0) {
      return cursor.seq === 0 ? { kind: "current" } : { kind: "resync", reason: "该范围没有可回放的事件" };
    }
    if (cursor.seq === seq) return { kind: "current" };
    if (cursor.seq > seq) return { kind: "resync", reason: "游标超前于服务端序号" };
    const oldest = state.records[0]?.seq;
    if (oldest === undefined) {
      return { kind: "resync", reason: "事件历史已超出保留范围" };
    }
    if (cursor.seq + 1 < oldest) {
      return { kind: "resync", reason: "事件历史已超出保留范围" };
    }
    const events = state.records.filter((record) => record.seq > cursor.seq);
    // A replay cannot advance past an event excluded for this origin: doing so
    // creates a cursor hole and makes the client believe it saw the event.
    if (origin && events.some((record) => record.except === origin)) {
      return { kind: "resync", reason: "事件历史包含该客户端被排除的事件" };
    }
    return { kind: "events", events };
  }

  forget(scope: AppScope): void {
    const old = this.#scopes.get(scope);
    // Retain the watermark so a recreated scope cannot reuse sequence numbers.
    if (old) this.#tombstones.set(scope, old.seq);
    this.#scopes.delete(scope);
    while (this.#tombstones.size > this.#maxScopes) {
      const oldest = this.#tombstones.keys().next().value as AppScope | undefined;
      if (!oldest) break;
      this.#tombstones.delete(oldest);
      // Once a tombstone is evicted, rotate the epoch before a possible reuse.
      this.epoch = randomUUID();
    }
    this.#enforceBounds();
  }

  forgetMany(predicate: (scope: AppScope) => boolean): void {
    for (const scope of [...this.#scopes.keys()]) {
      if (predicate(scope)) this.forget(scope);
    }
  }

  #enforceBounds(): void {
    for (const state of this.#scopes.values()) this.#trim(state);
    let bytes = 0;
    for (const state of this.#scopes.values()) for (const record of state.records) bytes += this.#size(record);
    // Drop oldest records globally until the byte budget is real, not merely
    // checked when a scope happens to receive another event.
    while (bytes > this.#maxBytes) {
      let oldest: { state: ScopeState; record: EventRecord } | undefined;
      for (const state of this.#scopes.values()) {
        const record = state.records[0];
        if (record && (!oldest || record.at < oldest.record.at)) oldest = { state, record };
      }
      if (!oldest) break;
      oldest.state.records.shift();
      bytes -= this.#size(oldest.record);
    }
    while (this.#scopes.size > this.#maxScopes) {
      const first = this.#scopes.keys().next().value as AppScope | undefined;
      if (!first) break;
      // Scope eviction is allowed to discard history, but preserve its watermark
      // while the tombstone remains within the bounded scope table.
      const state = this.#scopes.get(first)!;
      this.#tombstones.set(first, state.seq);
      this.#scopes.delete(first);
    }
  }

  #size(record: EventRecord): number {
    try { return JSON.stringify(record.payload)?.length ?? 0; } catch { return 0; }
  }

  #state(scope: AppScope): ScopeState {
    let state = this.#scopes.get(scope);
    if (!state) {
      state = { seq: this.#tombstones.get(scope) ?? 0, records: [] };
      this.#tombstones.delete(scope);
      this.#scopes.set(scope, state);
    }
    return state;
  }

  #trim(state: ScopeState): void {
    const cutoff = this.#now() - this.#maxAgeMs;
    while (state.records.length > 0 && (state.records[0]?.at ?? 0) < cutoff) state.records.shift();
    while (state.records.length > this.#maxPerScope) state.records.shift();
  }
}

export function scopeForChannel(channel: string, payload: unknown, conversationId?: string | null): AppScope {
  if (conversationId) return `conversation:${conversationId}`;
  const record = typeof payload === "object" && payload !== null ? (payload as Record<string, unknown>) : null;
  const id = record && typeof record.conversationId === "string" && record.conversationId.length > 0
    ? record.conversationId
    : null;
  if (id) return `conversation:${id}`;
  const project = record && typeof record.project === "string" && record.project.length > 0 ? record.project : null;
  if (project) return `workspace:${project}`;
  return installationScope;
}

function clonePayload<T>(value: T): T {
  try { return typeof structuredClone === "function" ? structuredClone(value) : value; } catch { return value; }
}
