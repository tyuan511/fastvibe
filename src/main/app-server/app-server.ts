import {
  APP_PROTOCOL,
  APP_PROTOCOL_VERSION,
  isProtocolCompatible,
  readClientMessage,
  type AppCapability,
  type AppEventMessage,
  type AppResultMessage,
  type AppScope,
  type AppServerIdentity,
  type AppServerMessage,
} from "../../shared/app-protocol.ts";
import { authorize, authorizePush } from "./capabilities.ts";
import { ClientSession, type ClientIdentity } from "./client-session.ts";
import { EventBus, scopeForChannel } from "./event-bus.ts";

export type AppServerDeps = {
  identity: AppServerIdentity;
  dispatch: (method: string, payload: unknown, context: AppCallContext) => Promise<unknown>;
  channels: () => readonly string[];
  capabilities: readonly AppCapability[];
  onSessionsChanged?: (count: number) => void;
  log?: { info(message: string): void; warn(message: string): void };
  bus?: EventBus;
};

/**
 * What a handler is told about its caller.
 *
 * `window` / `origin` come from trusted attach (Electron window, broadcast subscriber
 * id). They are not taken from the client envelope.
 */
export type AppCallContext = {
  kind: "window" | "remote";
  window: unknown | null;
  origin?: string;
  sessionId: string;
  subject: string;
  capabilities: AppCapability[];
  transport?: unknown;
};

export type AttachOptions = {
  /** Already-authenticated identity. AppServer does not authenticate. */
  identity: ClientIdentity;
  send: (message: AppServerMessage) => boolean;
  /** Trusted. Native dialogs parent to this; omitted for remote callers. */
  window?: unknown | null;
  /** Trusted broadcast id, used as `except` on events. */
  origin?: string;
};

const MAX_IDEMPOTENCY = 256;
const MAX_IN_FLIGHT = 1024;
const MAX_PENDING_IDEMPOTENCY = 256;

type CachedResult = { ok: true; result: unknown } | { ok: false; error: NonNullable<AppResultMessage["error"]> };
type IdempotencyEntry = { method: string; fingerprint: string; result: CachedResult };

type InFlight = { cancelled: boolean };

export class AppServer {
  readonly bus: EventBus;
  #deps: AppServerDeps;
  #sessions = new Map<string, ClientSession>();
  #inFlight = new Map<string, InFlight>();
  #idempotency = new Map<string, IdempotencyEntry>();
  #idempotencyOrder: string[] = [];
  #pendingIdempotency = new Map<string, { method: string; fingerprint: string; promise: Promise<CachedResult> }>();

  constructor(deps: AppServerDeps) {
    this.#deps = deps;
    this.bus = deps.bus ?? new EventBus();
  }

  get identity(): AppServerIdentity {
    return this.#deps.identity;
  }

  get capabilities(): readonly AppCapability[] {
    return this.#deps.capabilities;
  }

  get sessionCount(): number {
    return this.#sessions.size;
  }

  get channels(): () => readonly string[] {
    return this.#deps.channels;
  }

  attach(options: AttachOptions): ClientSession {
    const session = new ClientSession({
      identity: options.identity,
      serverCapabilities: this.#deps.capabilities,
      bus: this.bus,
      send: (message) => options.send(message),
      window: options.window,
      origin: options.origin,
      log: this.#deps.log,
      canReceive: (channel, capabilities) =>
        authorizePush(channel, {
          caller: options.identity.kind === "window" ? "window" : "remote",
          serverCapabilities: this.#deps.capabilities,
          clientCapabilities: capabilities,
        }),
    });
    this.#sessions.set(session.id, session);
    this.#deps.log?.info(
      `app session attached id=${session.id} subject=${session.identity.subject} kind=${session.identity.kind}`,
    );
    this.#deps.onSessionsChanged?.(this.#sessions.size);
    return session;
  }

  detach(session: ClientSession): void {
    if (!this.#sessions.has(session.id)) return;
    session.close();
    this.#sessions.delete(session.id);
    this.#deps.onSessionsChanged?.(this.#sessions.size);
  }

  /**
   * Handle one canonical envelope. Returns false when the session should be dropped.
   */
  async receive(session: ClientSession, raw: unknown, transport?: unknown): Promise<boolean> {
    if (session.closed || !this.#sessions.has(session.id)) return false;
    const message = readClientMessage(raw);
    if (!message) return true;

    switch (message.kind) {
      case "hello": {
        if (!isProtocolCompatible(message.hello)) return this.#drop(session);
        if (session.handshaken) return true;
        session.markHandshaken(message.hello.capabilities, message.hello.features);
        session.write({
          kind: "welcome",
          handshake: {
            protocol: APP_PROTOCOL,
            protocolVersion: APP_PROTOCOL_VERSION,
            server: this.#deps.identity,
            capabilities: session.capabilities,
          },
          sessionId: session.id,
          capabilities: session.capabilities,
          epoch: this.bus.epoch,
          features: {
            ...(session.supportsEventBatch ? { eventBatch: true } : {}),
            ...(session.supportsBinaryAttachments ? { binaryAttachments: true } : {}),
          },
        });
        return true;
      }

      case "ping":
        session.write({ kind: "pong" });
        return true;

      case "subscribe":
        if (!session.handshaken) return this.#notReady(session, null);
        session.subscribe(message.scopes, message.since);
        return true;

      case "unsubscribe":
        if (!session.handshaken) return this.#notReady(session, null);
        session.unsubscribe(message.scopes);
        return true;

      case "cancel": {
        if (!session.handshaken) return true;
        const inflight = this.#inFlight.get(this.#flightKey(session.id, message.targetRequestId));
        if (inflight) inflight.cancelled = true;
        return true;
      }

      case "call":
      case "query": {
        if (!session.handshaken) {
          session.write({
            kind: "result",
            requestId: message.requestId,
            ok: false,
            error: { code: "protocol.not_ready", message: "握手尚未完成" },
          });
          return true;
        }
        const key = message.kind === "call" ? message.idempotencyKey : undefined;
        await this.#handleRequest(session, message.requestId, message.method, message.payload, transport, key);
        return true;
      }
    }
  }

  async #handleRequest(
    session: ClientSession,
    requestId: number,
    method: string,
    payload: unknown,
    transport: unknown,
    idempotencyKey: string | undefined,
  ): Promise<void> {
    const flightKey = this.#flightKey(session.id, requestId);
    if (this.#inFlight.has(flightKey)) {
      session.write({ kind: "result", requestId, ok: false, error: { code: "protocol.duplicate_request", message: "请求编号重复" } });
      return;
    }
    if (this.#inFlight.size >= MAX_IN_FLIGHT) {
      session.write({ kind: "result", requestId, ok: false, error: { code: "server.busy", message: "请求过多，请稍后重试", retryable: true } });
      return;
    }
    const inflight: InFlight = { cancelled: false };
    this.#inFlight.set(flightKey, inflight);
    try {
      // Authorize before consulting shared results. A narrower client must never
      // inherit a result produced by a broader client/session.
      const verdict = authorize(method, { caller: session.callerKind, serverCapabilities: this.#deps.capabilities, clientCapabilities: session.capabilities });
      if (!verdict.allowed) { this.#writeResult(session, inflight, requestId, { ok: false, error: { code: verdict.code, message: verdict.reason } }); return; }
      const cachedKey = idempotencyKey ? this.#idempotencyKey(session.identity.subject, idempotencyKey) : null;
      const fingerprint = cachedKey ? `${method}\0${stableFingerprint(payload)}` : "";
      if (cachedKey) {
        const cached = this.#idempotency.get(cachedKey);
        if (cached) {
          if (cached.method !== method || cached.fingerprint !== fingerprint) { this.#writeResult(session, inflight, requestId, { ok: false, error: { code: "idempotency.conflict", message: "幂等键已用于其他请求" } }); return; }
          this.#writeResult(session, inflight, requestId, cached.result); return;
        }
        const pending = this.#pendingIdempotency.get(cachedKey);
        if (pending) {
          if (pending.method !== method || pending.fingerprint !== fingerprint) { this.#writeResult(session, inflight, requestId, { ok: false, error: { code: "idempotency.conflict", message: "幂等键已用于其他请求" } }); return; }
          const shared = await pending.promise; this.#writeResult(session, inflight, requestId, shared); return;
        }
        if (this.#pendingIdempotency.size >= MAX_PENDING_IDEMPOTENCY) { this.#writeResult(session, inflight, requestId, { ok: false, error: { code: "server.busy", message: "幂等请求过多，请稍后重试", retryable: true } }); return; }
      }

      const run = this.#dispatchAuthorized(session, method, payload, transport);
      if (cachedKey) this.#pendingIdempotency.set(cachedKey, { method, fingerprint, promise: run });
      try {
        const result = await run;
        if (cachedKey) this.#remember(cachedKey, { method, fingerprint, result });
        this.#writeResult(session, inflight, requestId, result);
      } finally {
        if (cachedKey) this.#pendingIdempotency.delete(cachedKey);
      }
    } finally {
      this.#inFlight.delete(flightKey);
    }
  }

  async #dispatchAuthorized(
    session: ClientSession,
    method: string,
    payload: unknown,
    transport: unknown,
  ): Promise<CachedResult> {
    const context: AppCallContext = {
      kind: session.callerKind,
      window: session.window,
      origin: session.origin,
      sessionId: session.id,
      subject: session.identity.subject,
      capabilities: session.capabilities,
      transport,
    };
    try {
      const result = await this.#deps.dispatch(method, payload, context);
      return { ok: true, result };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ok: false, error: { code: "call.failed", message } };
    }
  }

  #writeResult(session: ClientSession, inflight: InFlight, requestId: number, result: CachedResult): void {
    if (inflight.cancelled) return;
    const sent = result.ok
      ? session.write({ kind: "result", requestId, ok: true, result: result.result })
      : session.write({ kind: "result", requestId, ok: false, error: result.error });
    if (!sent) this.detach(session);
  }

  /**
   * Publish once, then fan out to subscribed sessions. `except` matches attach `origin`
   * (then session id), same idea as `broadcast({ except })`.
   */
  publish(
    channel: string,
    payload: unknown,
    options?: { conversationId?: string | null; except?: string; namedOnly?: boolean },
  ): AppEventMessage {
    const scope: AppScope = scopeForChannel(channel, payload, options?.conversationId);
    const event = this.bus.publish(scope, channel, payload, options);
    const except = options?.except;
    const namedOnly = options?.namedOnly === true;
    for (const session of this.#sessions.values()) {
      if (except && (session.origin === except || session.id === except)) continue;
      if (!session.deliver(event, { namedOnly })) this.detach(session);
    }
    return event;
  }

  /** Whether any client subscribed to `scope` by name (the `*` catch-all does not count). */
  hasNamedSubscriber(scope: AppScope): boolean {
    for (const session of this.#sessions.values()) {
      if (session.isSubscribedByName(scope)) return true;
    }
    return false;
  }

  sessionsForSubject(subject: string): ClientSession[] {
    return [...this.#sessions.values()].filter((session) => session.identity.subject === subject);
  }

  closeAll(): void {
    for (const session of [...this.#sessions.values()]) this.detach(session);
  }

  #notReady(session: ClientSession, requestId: number | null): true {
    if (requestId !== null) {
      session.write({
        kind: "result",
        requestId,
        ok: false,
        error: { code: "protocol.not_ready", message: "握手尚未完成" },
      });
    }
    return true;
  }

  #drop(session: ClientSession): false {
    this.detach(session);
    return false;
  }

  #flightKey(sessionId: string, requestId: number): string {
    return `${sessionId}:${requestId}`;
  }

  #idempotencyKey(subject: string, key: string): string {
    return `${subject}\0${key}`;
  }

  #remember(key: string, result: IdempotencyEntry): void {
    if (this.#idempotency.has(key)) {
      this.#idempotency.set(key, result);
      return;
    }
    this.#idempotency.set(key, result);
    this.#idempotencyOrder.push(key);
    while (this.#idempotencyOrder.length > MAX_IDEMPOTENCY) {
      const oldest = this.#idempotencyOrder.shift();
      if (oldest) this.#idempotency.delete(oldest);
    }
  }
}

export { intersectCapabilities } from "../../shared/app-protocol.ts";
export { MAX_IDEMPOTENCY };

function stableFingerprint(value: unknown): string {
  try { return JSON.stringify(value, (_key, v) => v && typeof v === "object" && !Array.isArray(v) ? Object.keys(v).sort().reduce((o, k) => { o[k] = v[k]; return o; }, {} as Record<string, unknown>) : v) ?? "undefined"; } catch { return String(value); }
}
