import { randomUUID } from "node:crypto";
import {
  ALL_SCOPES,
  intersectCapabilities,
  type AppCapability,
  type AppEventCursor,
  type AppEventMessage,
  type AppScope,
  type AppServerMessage,
} from "../../shared/app-protocol.ts";
import type { EventBus } from "./event-bus.ts";

export type ClientIdentity = {
  subject: string;
  kind: "window" | "remote" | "loopback";
  clientKind: string;
  clientVersion: string;
  label?: string;
};

export type ClientSessionOptions = {
  identity: ClientIdentity;
  serverCapabilities: readonly AppCapability[];
  bus: EventBus;
  send: (message: AppServerMessage) => boolean;
  window?: unknown | null;
  origin?: string;
  log?: { info(message: string): void; warn(message: string): void };
  canReceive?: (channel: string, capabilities: readonly AppCapability[]) => boolean;
};

type Subscription = { epoch: string; seq: number };

const EVENT_BATCH_DELAY_MS = 25;
const EVENT_BATCH_MAX_EVENTS = 32;
const EVENT_BATCH_MAX_BYTES = 16 * 1024;
const BATCHABLE_CHANNELS = new Set(["engine:event", "workspace:terminal-data"]);
/** How long consecutive thinking deltas for one conversation wait to be folded into one. */
const THINKING_COALESCE_MS = 250;
const THINKING_COALESCE_MAX_CHARS = 8 * 1024;

export class ClientSession {
  readonly id: string;
  readonly identity: ClientIdentity;
  readonly window: unknown | null;
  readonly origin: string | undefined;
  #serverCapabilities: readonly AppCapability[];
  #capabilities: AppCapability[];
  #bus: EventBus;
  #send: (message: AppServerMessage) => boolean;
  #log: ClientSessionOptions["log"];
  #canReceive: ((channel: string, capabilities: readonly AppCapability[]) => boolean) | undefined;
  #subscriptions = new Map<AppScope, Subscription>();
  #eventBatch = false;
  #binaryAttachments = false;
  #conversationResume = false;
  #thinkingSummary = false;
  #pendingEvents: AppEventMessage[] = [];
  #thinking = new Map<string, { event: AppEventMessage; chars: number }>();
  #thinkingTimer: ReturnType<typeof setTimeout> | null = null;
  #pendingEventBytes = 0;
  #eventBatchTimer: ReturnType<typeof setTimeout> | null = null;
  #flushingEventBatch = false;
  #closed = false;
  #handshaken = false;

  constructor(options: ClientSessionOptions) {
    this.id = `sess_${randomUUID().replace(/-/g, "").slice(0, 16)}`;
    this.identity = options.identity;
    this.window = options.window ?? null;
    this.origin = options.origin;
    this.#serverCapabilities = options.serverCapabilities;
    this.#capabilities = [...options.serverCapabilities];
    this.#bus = options.bus;
    this.#send = options.send;
    this.#log = options.log;
    this.#canReceive = options.canReceive;
  }

  get callerKind(): "window" | "remote" {
    return this.identity.kind === "window" ? "window" : "remote";
  }

  get capabilities(): AppCapability[] {
    return [...this.#capabilities];
  }

  get closed(): boolean {
    return this.#closed;
  }

  get handshaken(): boolean {
    return this.#handshaken;
  }

  /**
   * Narrow to the hello declaration. Only intersects; cannot grant server-missing caps.
   */
  markHandshaken(
    capabilities?: readonly AppCapability[] | null,
    features?: { eventBatch?: boolean; binaryAttachments?: boolean; conversationResume?: boolean; thinkingSummary?: boolean } | null,
  ): void {
    if (this.#handshaken) return;
    this.#capabilities = intersectCapabilities(this.#serverCapabilities, capabilities);
    this.#eventBatch = features?.eventBatch === true;
    this.#binaryAttachments = features?.binaryAttachments === true;
    this.#conversationResume = features?.conversationResume === true;
    this.#thinkingSummary = features?.thinkingSummary === true;
    this.#handshaken = true;
  }

  get supportsEventBatch(): boolean {
    return this.#eventBatch;
  }

  get supportsBinaryAttachments(): boolean {
    return this.#binaryAttachments;
  }

  get supportsConversationResume(): boolean { return this.#conversationResume; }

  get supportsThinkingSummary(): boolean { return this.#thinkingSummary; }

  write(message: AppServerMessage): boolean {
    if (this.#closed) return false;
    try {
      // A control/result frame must never overtake queued stream data. The batch
      // flush is synchronous from the transport's point of view, so the existing
      // ordering contract remains true for both old and new clients.
      if (!this.#flushingEventBatch && message.kind !== "events" && !this.#flushEventBatch()) return false;
      return this.#send(message);
    } catch (error) {
      this.#log?.warn(`client send failed session=${this.id}: ${String(error)}`);
      return false;
    }
  }

  subscribe(scopes: readonly AppScope[], since?: Record<AppScope, AppEventCursor>): void {
    for (const scope of scopes) {
      if (scope === ALL_SCOPES) {
        if (since?.[ALL_SCOPES] !== undefined) {
          this.write({
            kind: "resync",
            scope,
            reason: "通配订阅不能回放，请按具名范围续订或重新读取快照",
            epoch: this.#bus.epoch,
            seq: 0,
          });
        }
        this.#subscriptions.set(ALL_SCOPES, { epoch: this.#bus.epoch, seq: 0 });
        continue;
      }

      const cursor = since?.[scope];
      if (cursor === undefined) {
        this.#subscriptions.set(scope, { epoch: this.#bus.epoch, seq: this.#bus.sequence(scope) });
        continue;
      }

      const outcome = this.#bus.resume(scope, cursor, this.origin);
      if (outcome.kind === "resync") {
        this.#subscriptions.set(scope, { epoch: this.#bus.epoch, seq: this.#bus.sequence(scope) });
        this.write({
          kind: "resync",
          scope,
          reason: outcome.reason,
          epoch: this.#bus.epoch,
          seq: this.#bus.sequence(scope),
        });
        continue;
      }
      if (outcome.kind === "current") {
        this.#subscriptions.set(scope, { epoch: cursor.epoch, seq: cursor.seq });
        continue;
      }
      let last = cursor.seq;
      for (const record of outcome.events) {
        last = record.seq;
        if (this.#canReceive && !this.#canReceive(record.channel, this.#capabilities)) continue;
        if (!this.write({
          kind: "event",
          scope: record.scope,
          seq: record.seq,
          epoch: record.epoch,
          eventId: record.eventId,
          channel: record.channel,
          payload: record.payload,
        })) {
          this.#subscriptions.set(scope, { epoch: this.#bus.epoch, seq: last });
          return;
        }
      }
      this.#subscriptions.set(scope, { epoch: this.#bus.epoch, seq: last });
    }
  }

  unsubscribe(scopes: readonly AppScope[]): void {
    for (const scope of scopes) this.#subscriptions.delete(scope);
  }

  isSubscribed(scope: AppScope): boolean {
    return this.#subscriptions.has(scope) || this.#subscriptions.has(ALL_SCOPES);
  }

  cursors(): Record<AppScope, AppEventCursor> {
    return Object.fromEntries(
      [...this.#subscriptions.entries()].map(([scope, cursor]) => [scope, { ...cursor }]),
    );
  }

  /** Subscribed to this scope by name — not merely covered by the `*` catch-all. */
  isSubscribedByName(scope: AppScope): boolean {
    return scope !== ALL_SCOPES && this.#subscriptions.has(scope);
  }

  /**
   * Hand one event to this client if it asked for it.
   *
   * `namedOnly` events reach only a client that subscribed to their scope by name: a
   * background conversation's token stream, published because *someone* is watching
   * that chat, is not something every `*` subscriber (each desktop window) should be
   * made to receive and discard per token.
   */
  deliver(event: AppEventMessage, options?: { namedOnly?: boolean }): boolean {
    if (options?.namedOnly && !this.#subscriptions.has(event.scope)) return true;
    if (!this.#subscriptions.has(event.scope) && !this.#subscriptions.has(ALL_SCOPES)) return true;
    if (this.#canReceive && !this.#canReceive(event.channel, this.#capabilities)) return true;
    if (this.#thinkingSummary && this.#holdThinking(event)) {
      // Held, but not lost: the folded event carries the latest seq, and a resume must
      // not replay deltas the client already received inside it.
      this.#advance(event);
      return true;
    }
    if (this.#eventBatch && BATCHABLE_CHANNELS.has(event.channel)) return this.#queueEvent(event);
    const sent = this.write(event);
    if (sent && this.#subscriptions.has(event.scope)) {
      this.#subscriptions.set(event.scope, { epoch: event.epoch, seq: event.seq });
    }
    return sent;
  }

  close(): void {
    this.#closed = true;
    if (this.#eventBatchTimer !== null) clearTimeout(this.#eventBatchTimer);
    this.#eventBatchTimer = null;
    if (this.#thinkingTimer !== null) clearTimeout(this.#thinkingTimer);
    this.#thinkingTimer = null;
    this.#thinking.clear();
    this.#pendingEvents = [];
    this.#pendingEventBytes = 0;
    this.#subscriptions.clear();
  }

  /**
   * Fold consecutive thinking deltas for one conversation into a single event.
   *
   * Only a client that asked for it. The phone draws a thinking block as one collapsed
   * row and reads its text back from the transcript, so the per-token events are a cost
   * with nothing to show for them. Anything that is not a thinking delta flushes what is
   * held first, which keeps the folded text ahead of the tool call or prose that follows.
   * Returns whether `event` itself was held.
   */
  #holdThinking(event: AppEventMessage): boolean {
    const delta = thinkingDelta(event);
    if (!delta) {
      this.#flushThinking();
      return false;
    }
    const key = event.scope;
    const held = this.#thinking.get(key);
    if (held && held.chars + delta.text.length > THINKING_COALESCE_MAX_CHARS) this.#flushThinking(key);
    const current = this.#thinking.get(key);
    if (current) {
      const inner = (current.event.payload as { assistantMessageEvent: { delta: string } }).assistantMessageEvent;
      inner.delta += delta.text;
      current.event.seq = event.seq;
      current.chars += delta.text.length;
    } else {
      // The bus hands every subscriber the same payload object. Copy before writing
      // into it, or folding this client's deltas would rewrite the desktop's too.
      const payload = structuredClone(event.payload) as { assistantMessageEvent: { delta: string } };
      payload.assistantMessageEvent.delta = delta.text;
      this.#thinking.set(key, { event: { ...event, payload }, chars: delta.text.length });
    }
    this.#advance(event);
    if (this.#thinkingTimer === null) {
      this.#thinkingTimer = setTimeout(() => {
        this.#thinkingTimer = null;
        this.#flushThinking();
      }, THINKING_COALESCE_MS);
      this.#thinkingTimer.unref?.();
    }
    return true;
  }

  /** Remember how far this scope was delivered, so a resume starts after it. */
  #advance(event: AppEventMessage): void {
    if (this.#subscriptions.has(event.scope)) {
      this.#subscriptions.set(event.scope, { epoch: event.epoch, seq: event.seq });
    }
  }

  /** Hand held thinking deltas to the ordinary path. One scope, or every scope. */
  #flushThinking(scope?: string): void {
    if (this.#thinking.size === 0) return;
    const held = scope ? [this.#thinking.get(scope)].filter((item) => item !== undefined) : [...this.#thinking.values()];
    if (scope) this.#thinking.delete(scope);
    else this.#thinking.clear();
    if (this.#thinking.size === 0 && this.#thinkingTimer !== null) {
      clearTimeout(this.#thinkingTimer);
      this.#thinkingTimer = null;
    }
    for (const item of held) {
      if (this.#eventBatch && BATCHABLE_CHANNELS.has(item.event.channel)) this.#queueEvent(item.event);
      else this.write(item.event);
    }
  }

  #queueEvent(event: AppEventMessage): boolean {
    if (this.#closed) return false;
    this.#pendingEvents.push(event);
    this.#pendingEventBytes += this.#eventSize(event);
    if (this.#pendingEvents.length >= EVENT_BATCH_MAX_EVENTS || this.#pendingEventBytes >= EVENT_BATCH_MAX_BYTES) {
      return this.#flushEventBatch();
    }
    if (this.#eventBatchTimer === null) {
      this.#eventBatchTimer = setTimeout(() => {
        this.#eventBatchTimer = null;
        if (!this.#flushEventBatch()) this.#closed = true;
      }, EVENT_BATCH_DELAY_MS);
      this.#eventBatchTimer.unref?.();
    }
    return true;
  }

  #flushEventBatch(): boolean {
    if (this.#pendingEvents.length === 0 || this.#closed) return !this.#closed;
    if (this.#eventBatchTimer !== null) clearTimeout(this.#eventBatchTimer);
    this.#eventBatchTimer = null;
    const events = this.#pendingEvents;
    this.#pendingEvents = [];
    this.#pendingEventBytes = 0;
    this.#flushingEventBatch = true;
    let sent = false;
    try {
      sent = this.#send({ kind: "events", events });
    } catch (error) {
      this.#log?.warn(`client batch send failed session=${this.id}: ${String(error)}`);
      sent = false;
    } finally {
      this.#flushingEventBatch = false;
    }
    if (!sent) return false;
    for (const event of events) {
      if (this.#subscriptions.has(event.scope)) {
        this.#subscriptions.set(event.scope, { epoch: event.epoch, seq: event.seq });
      }
    }
    return true;
  }

  #eventSize(event: AppEventMessage): number {
    try {
      return JSON.stringify(event).length;
    } catch {
      return 0;
    }
  }
}

/**
 * The text of one `thinking_delta`, or null when the event is anything else.
 *
 * Only the bare delta shape is folded. A delta that still carries the accumulated
 * message, or that is not a string, passes through untouched.
 */
export function thinkingDelta(event: AppEventMessage): { text: string } | null {
  if (event.channel !== "engine:event") return null;
  const payload = event.payload;
  if (typeof payload !== "object" || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.type !== "message_update") return null;
  const inner = record.assistantMessageEvent;
  if (typeof inner !== "object" || inner === null) return null;
  const delta = inner as Record<string, unknown>;
  if (delta.type !== "thinking_delta" || typeof delta.delta !== "string" || delta.delta.length === 0) return null;
  if ("partial" in delta) return null;
  return { text: delta.delta };
}
