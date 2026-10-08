import type { ServerAddress } from "./address";
import { t } from "../i18n/core.ts";
import { recordConnectionDiagnostic } from "./diagnostics.ts";

const CONNECT_TIMEOUT_MS = 20_000;
export const HEALTH_INTERVAL_MS = 15_000;
export const HEALTH_TIMEOUT_MS = 15_000;

/**
 * A request whose outcome is unknown: it may or may not have reached Main.
 *
 * Callers branch on `code`, never on the message — the message is translated, and
 * `chat/queue.ts` must treat a lost acknowledgement as "maybe sent" in every language.
 */
export class TransportError extends Error {
  readonly code: "timeout" | "dropped" | "closed";
  constructor(code: "timeout" | "dropped" | "closed", message: string) {
    super(message);
    this.name = "TransportError";
    this.code = code;
  }
}

export class ConnectionError extends Error {
  readonly code: "timeout" | "unreachable" | "unauthorized" | "closed-early";
  readonly detail?: DisconnectDetail;
  constructor(code: ConnectionError["code"], message: string, detail?: DisconnectDetail) {
    super(message);
    this.name = "ConnectionError";
    this.code = code;
    this.detail = detail;
  }
}

export type EventCursor = { epoch: string; seq: number };
export type EventMeta = EventCursor & { scope: string };
export type SubscriptionResult = { resumed: boolean; cursor?: EventCursor };
export type PushHandler = (channel: string, payload: unknown, meta?: EventMeta) => void;
export type DisconnectDetail = {
  kind: "socket-close" | "socket-error" | "heartbeat-timeout" | "send-failed" | "client-close" | "resync";
  code?: number;
  reason?: string;
};
export type DisconnectHandler = (detail: DisconnectDetail) => void;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  started: number;
  metric: "snapshot" | "history" | "submission" | "rpc";
};

/**
 * One remote FastVibe: password once, then a device token on the socket.
 *
 * The first frame is the legacy `{ type: "auth" }` the server still requires.
 * Everything after that is App Protocol v1, the same envelope the web client uses.
 */
export class RemoteClient {
  #ws: WebSocket | null = null;
  #generation = 0;
  #nextId = 1;
  #pending = new Map<number, Pending>();
  #push: PushHandler | null = null;
  #disconnect: DisconnectHandler | null = null;
  #version: string;
  #ready = false;
  #active = false;
  #lastReceived = 0;
  #healthTimer: ReturnType<typeof setTimeout> | null = null;
  #probeTimer: ReturnType<typeof setTimeout> | null = null;
  #cancelConnect: (() => void) | null = null;
  #features: { conversationResume?: boolean; promptSubmit?: boolean; historyPaging?: boolean } = {};
  #epoch = "";
  #rtt: number | null = null;
  #probeStarted = 0;
  #subscriptions = new Map<string, { requestId: number; resolve: (result: SubscriptionResult) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout>; resumed: boolean }>();
  #probeExpire: (() => void) | null = null;
  #probeFast = false;

  get supportsPromptSubmit(): boolean { return this.#features.promptSubmit === true; }
  get supportsConversationResume(): boolean { return this.#features.conversationResume === true; }
  get supportsHistoryPaging(): boolean { return this.#features.historyPaging === true; }
  get epoch(): string { return this.#epoch; }

  constructor(version = "0.0.0") {
    this.#version = version;
  }

  /** Only a foreground client probes. Timers frozen in the background cannot condemn it on return. */
  setActive(active: boolean): void {
    this.#active = active;
    this.#clearHealthTimers();
    if (active && this.#ready) this.checkHealth(true);
  }

  /** Single-flight, read-only protocol ping. Also used after a request timeout or network change. */
  checkHealth(fast = false): void {
    if (!this.#active || !this.#ready) return;
    const deadline = fast ? Math.min(HEALTH_TIMEOUT_MS, Math.max(4_000, (this.#rtt ?? 500) * 6 + 1_000)) : HEALTH_TIMEOUT_MS;
    if (this.#probeTimer) {
      if (fast && !this.#probeFast && this.#probeExpire) {
        clearTimeout(this.#probeTimer);
        this.#probeFast = true;
        this.#probeTimer = setTimeout(this.#probeExpire, Math.max(1, deadline - (Date.now() - this.#probeStarted)));
      }
      return;
    }
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = null;
    const generation = this.#generation;
    const started = Date.now();
    this.#probeStarted = started;
    this.#probeFast = fast;
    let received = this.#lastReceived;
    const expire = (): void => {
      this.#probeTimer = null;
      if (generation !== this.#generation || !this.#active) return;
      // Large replies can queue a pong. If useful frames are still arriving, let
      // them finish, but bound this allowance: inbound data alone cannot prove
      // the uplink still works after a timed-out command.
      if (this.#lastReceived > received && Date.now() - started < HEALTH_TIMEOUT_MS * 3) {
        received = this.#lastReceived;
        this.#probeTimer = setTimeout(expire, HEALTH_TIMEOUT_MS);
      } else {
        this.#drop(true, { kind: "heartbeat-timeout" });
      }
    };
    this.#probeExpire = expire;
    this.#probeTimer = setTimeout(expire, deadline);
    this.#send({ kind: "ping" });
  }

  #scheduleHealth(): void {
    if (!this.#active || !this.#ready || this.#healthTimer || this.#probeTimer) return;
    this.#healthTimer = setTimeout(() => {
      this.#healthTimer = null;
      if (Date.now() - this.#lastReceived < HEALTH_INTERVAL_MS) this.#scheduleHealth();
      else this.checkHealth();
    }, HEALTH_INTERVAL_MS);
  }

  #clearHealthTimers(): void {
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    if (this.#probeTimer) clearTimeout(this.#probeTimer);
    this.#healthTimer = this.#probeTimer = null;
    this.#probeExpire = null;
  }

  onPush(handler: PushHandler | null): void {
    this.#push = handler;
  }

  onDisconnect(handler: DisconnectHandler | null): void {
    this.#disconnect = handler;
  }

  async login(origin: string, password: string, label: string): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), CONNECT_TIMEOUT_MS);
    let response: Response | undefined;
    try {
      response = await fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, label }),
        signal: controller.signal,
      });
      const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
      if (!response.ok || typeof body.token !== "string" || body.token.length === 0) {
        throw new Error(body.error || (response.status === 401 ? t("conn.wrongPassword") : t("conn.loginFailed")));
      }
      return body.token;
    } catch (error) {
      if (controller.signal.aborted) throw new ConnectionError("timeout", t("conn.timeout"));
      if (!response) throw new Error(unreachable(origin));
      throw error instanceof Error ? error : new Error(unreachable(origin));
    } finally {
      clearTimeout(timer);
    }
  }

  connect(address: ServerAddress, token: string): Promise<void> {
    this.#drop(false);
    this.#features = {};
    this.#epoch = "";
    const started = Date.now();
    let phaseStarted = started;
    const generation = this.#generation;
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(address.wsUrl);
      } catch {
        reject(new ConnectionError("unreachable", unreachable(address.origin)));
        return;
      }
      this.#ws = ws;
      let authed = false;
      let settled = false;
      const stale = (): boolean => generation !== this.#generation;
      const fail = (error: Error): void => {
        if (settled || stale()) return;
        settled = true;
        clearTimeout(timer);
        this.#cancelConnect = null;
        this.#drop(false);
        reject(error);
      };
      const timer = setTimeout(() => fail(new ConnectionError("timeout", t("conn.timeout"))), CONNECT_TIMEOUT_MS);
      this.#cancelConnect = () => {
        settled = true;
        clearTimeout(timer);
        reject(new TransportError("closed", t("conn.closed")));
      };

      ws.onopen = () => {
        if (stale()) return;
        try {
          recordConnectionDiagnostic({ event: "metric", metric: "socket", elapsedMs: Date.now() - started });
          phaseStarted = Date.now();
          ws.send(JSON.stringify({ type: "auth", token }));
          // Frames on this socket are ordered. The host authenticates before it
          // handles hello; pipeline both without an extra WAN round trip.
          ws.send(JSON.stringify({
            kind: "hello",
            hello: {
              protocol: "fastvibe.app", protocolVersion: 1,
              client: { kind: "mobile", version: this.#version },
              features: { eventBatch: true, conversationResume: true },
            },
          }));
        } catch {
          fail(new ConnectionError("unreachable", unreachable(address.origin)));
        }
      };
      ws.onerror = () => {
        if (stale()) return;
        if (!settled) fail(new ConnectionError("unreachable", unreachable(address.origin)));
        else this.#drop(true, { kind: "socket-error" });
      };
      ws.onclose = (event) => {
        if (stale()) return;
        if (!settled) fail(new ConnectionError("closed-early", t("conn.closedEarly"), { kind: "socket-close", code: event.code, reason: event.reason }));
        else {
          this.#drop(true, { kind: "socket-close", code: event.code, reason: event.reason });
        }
      };
      ws.onmessage = (event) => {
        if (stale()) return;
        const message = parseFrame(event.data);
        if (!message) return;
        this.#lastReceived = Date.now();
        if (!authed) {
          if (message.type !== "auth") return;
          if (message.ok !== true) {
            fail(new ConnectionError("unauthorized", t("conn.expired")));
            return;
          }
          authed = true;
          recordConnectionDiagnostic({ event: "metric", metric: "auth", elapsedMs: Date.now() - phaseStarted });
          return;
        }
        if (!settled) {
          if (message.kind === "welcome") {
            this.#features = isRecord(message.features) ? message.features : {};
            this.#epoch = typeof message.epoch === "string" ? message.epoch : "";
            recordConnectionDiagnostic({ event: "metric", metric: "welcome", elapsedMs: Date.now() - phaseStarted });
            settled = true;
            clearTimeout(timer);
            this.#cancelConnect = null;
            this.#ready = true;
            this.#scheduleHealth();
            resolve();
          }
          return;
        }
        if (message.kind === "pong") {
          if (this.#probeTimer) {
            const elapsedMs = Date.now() - this.#probeStarted;
            this.#rtt = this.#rtt === null ? elapsedMs : this.#rtt * 0.75 + elapsedMs * 0.25;
            recordConnectionDiagnostic({ event: "metric", metric: "rtt", elapsedMs });
          }
          if (this.#probeTimer) clearTimeout(this.#probeTimer);
          this.#probeTimer = null;
          this.#scheduleHealth();
          return;
        }
        if (message.kind === "resync") {
          const pending = typeof message.scope === "string" ? this.#subscriptions.get(message.scope) : undefined;
          if (pending) { pending.resumed = false; return; }
          this.#drop(true, { kind: "resync" });
          return;
        }
        if (message.kind === "subscribed" && isRecord(message.cursors)) {
          for (const [scope, cursor] of Object.entries(message.cursors)) {
            const pending = this.#subscriptions.get(scope);
            if (!pending || pending.requestId !== message.requestId || !isCursor(cursor)) continue;
            clearTimeout(pending.timer);
            this.#subscriptions.delete(scope);
            pending.resolve({ resumed: pending.resumed, cursor });
          }
          return;
        }
        if (message.kind === "result" && typeof message.requestId === "number") {
          const pending = this.#pending.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(message.requestId);
          recordConnectionDiagnostic({ event: "metric", metric: pending.metric, elapsedMs: Date.now() - pending.started,
            frameChars: typeof event.data === "string" ? event.data.length : undefined, outcome: message.ok === true ? "ok" : "error" });
          if (message.ok === true) pending.resolve(message.result);
          else {
            const error = message.error as { message?: string } | undefined;
            pending.reject(new Error(error?.message || t("conn.requestFailed")));
          }
          return;
        }
        if (message.kind === "event" && typeof message.channel === "string") {
          this.#push?.(message.channel, message.payload, eventMeta(message));
          return;
        }
        if (message.kind === "events" && Array.isArray(message.events)) {
          for (const event of message.events) {
            if (isRecord(event) && typeof event.channel === "string") {
              this.#push?.(event.channel, event.payload, eventMeta(event));
            }
          }
        }
      };
    });
  }

  call(method: string, payload?: unknown, timeoutMs = 30_000): Promise<unknown> {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error(t("conn.notConnected")));
    const requestId = this.#nextId++;
    const started = Date.now();
    const metric = method === "engine:get-snapshot" ? "snapshot" : method === "engine:get-messages-page" ? "history" : ["engine:submit-prompt", "engine:prompt", "engine:queue-add"].includes(method) ? "submission" : "rpc";
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        recordConnectionDiagnostic({ event: "metric", metric, elapsedMs: Date.now() - started, outcome: "timeout" });
        this.#send({ kind: "cancel", targetRequestId: requestId });
        reject(new TransportError("timeout", t("conn.requestTimeout")));
        // Do not replay a call Main may have accepted. Probe the connection instead.
        this.checkHealth();
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer, started, metric });
      try {
        ws.send(JSON.stringify({ kind: "call", requestId, method, payload }));
      } catch {
        clearTimeout(timer);
        this.#pending.delete(requestId);
        // The socket can close between the readyState check and send(). The
        // request may already have crossed the wire, so callers must treat this
        // as an unknown outcome rather than a safe refusal.
        reject(new TransportError("dropped", t("conn.dropped")));
        this.#drop(true, { kind: "send-failed" });
      }
    });
  }

  subscribe(scopes: string[]): void {
    this.#send({ kind: "subscribe", scopes });
  }

  /** A subscription acknowledgement is an ordering fence after all replay frames. */
  subscribeConversation(scope: string, cursor?: EventCursor): Promise<SubscriptionResult> {
    if (!this.#ready || this.#ws?.readyState !== WebSocket.OPEN) return Promise.reject(new TransportError("closed", t("conn.closed")));
    if (!this.supportsConversationResume) {
      this.subscribe([scope]);
      return Promise.resolve({ resumed: false });
    }
    if (this.#subscriptions.has(scope)) return Promise.reject(new Error(t("conn.requestFailed")));
    const requestId = this.#nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#subscriptions.delete(scope);
        reject(new TransportError("timeout", t("conn.requestTimeout")));
        this.checkHealth(true);
      }, 30_000);
      this.#subscriptions.set(scope, { requestId, resolve, reject, timer, resumed: !!cursor && cursor.epoch === this.#epoch });
      this.#send({ kind: "subscribe", requestId, scopes: [scope], ...(cursor ? { since: { [scope]: cursor } } : {}) });
    });
  }

  unsubscribe(scopes: string[]): void {
    for (const scope of scopes) {
      const pending = this.#subscriptions.get(scope);
      if (!pending) continue;
      this.#subscriptions.delete(scope);
      clearTimeout(pending.timer);
      pending.reject(new TransportError("closed", t("conn.closed")));
    }
    this.#send({ kind: "unsubscribe", scopes });
  }

  close(): void {
    this.#drop(true);
  }

  #send(frame: unknown): void {
    const ws = this.#ws;
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    try {
      ws.send(JSON.stringify(frame));
    } catch {
      this.#drop(true, { kind: "send-failed" });
    }
  }

  #drop(notify: boolean, detail: DisconnectDetail = { kind: "client-close" }): void {
    this.#generation += 1;
    this.#ready = false;
    this.#clearHealthTimers();
    this.#cancelConnect?.();
    this.#cancelConnect = null;
    this.#failPending(detail.kind === "client-close" ? "closed" : "dropped");
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      try {
        if (ws.readyState < WebSocket.CLOSING) ws.close();
      } catch { /* A failed native socket may already have been disposed. */ }
    }
    if (notify && ws) this.#disconnect?.(detail);
  }

  #failPending(code: "dropped" | "closed"): void {
    const message = t(code === "dropped" ? "conn.dropped" : "conn.closed");
    for (const pending of this.#pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TransportError(code, message));
    }
    this.#pending.clear();
    for (const pending of this.#subscriptions.values()) {
      clearTimeout(pending.timer);
      pending.reject(new TransportError(code, message));
    }
    this.#subscriptions.clear();
  }
}

function isCursor(value: unknown): value is EventCursor {
  return isRecord(value) && typeof value.epoch === "string" && value.epoch.length > 0 &&
    typeof value.seq === "number" && Number.isSafeInteger(value.seq) && value.seq >= 0;
}

function eventMeta(value: Record<string, unknown>): EventMeta | undefined {
  const scope = value.scope;
  return typeof scope === "string" && isCursor(value) ? { scope, epoch: value.epoch, seq: value.seq } : undefined;
}

function parseFrame(data: unknown): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(typeof data === "string" ? data : String(data)) as unknown;
    if (typeof parsed !== "object" || parsed === null) return null;
    return parsed as Record<string, unknown>;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function unreachable(origin: string): string {
  return origin.startsWith("http://")
    ? t("conn.unreachableLan")
    : t("conn.unreachable");
}
