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
  markHandshaken(capabilities?: readonly AppCapability[] | null): void {
    if (this.#handshaken) return;
    this.#capabilities = intersectCapabilities(this.#serverCapabilities, capabilities);
    this.#handshaken = true;
  }

  write(message: AppServerMessage): boolean {
    if (this.#closed) return false;
    try {
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

  deliver(event: AppEventMessage): boolean {
    if (!this.#subscriptions.has(event.scope) && !this.#subscriptions.has(ALL_SCOPES)) return true;
    if (this.#canReceive && !this.#canReceive(event.channel, this.#capabilities)) return true;
    const sent = this.write(event);
    if (sent && this.#subscriptions.has(event.scope)) {
      this.#subscriptions.set(event.scope, { epoch: event.epoch, seq: event.seq });
    }
    return sent;
  }

  close(): void {
    this.#closed = true;
    this.#subscriptions.clear();
  }
}
