import type { ServerAddress } from "./address";
import { t } from "../i18n/core.ts";

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

export type PushHandler = (channel: string, payload: unknown) => void;
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

  constructor(version = "0.0.0") {
    this.#version = version;
  }

  /** Only a foreground client probes. Timers frozen in the background cannot condemn it on return. */
  setActive(active: boolean): void {
    this.#active = active;
    this.#clearHealthTimers();
    if (active && this.#ready) this.checkHealth();
  }

  /** Single-flight, read-only protocol ping. Also used after a request timeout or network change. */
  checkHealth(): void {
    if (!this.#active || !this.#ready || this.#probeTimer) return;
    if (this.#healthTimer) clearTimeout(this.#healthTimer);
    this.#healthTimer = null;
    const generation = this.#generation;
    const started = Date.now();
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
    this.#probeTimer = setTimeout(expire, HEALTH_TIMEOUT_MS);
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
  }

  onPush(handler: PushHandler | null): void {
    this.#push = handler;
  }

  onDisconnect(handler: DisconnectHandler | null): void {
    this.#disconnect = handler;
  }

  async login(origin: string, password: string, label: string): Promise<string> {
    let response: Response;
    try {
      response = await fetch(`${origin}/api/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password, label }),
      });
    } catch {
      throw new Error(unreachable(origin));
    }
    const body = (await response.json().catch(() => ({}))) as { token?: string; error?: string };
    if (!response.ok || typeof body.token !== "string" || body.token.length === 0) {
      throw new Error(body.error || (response.status === 401 ? t("conn.wrongPassword") : t("conn.loginFailed")));
    }
    return body.token;
  }

  connect(address: ServerAddress, token: string): Promise<void> {
    this.#drop(false);
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
          ws.send(JSON.stringify({ type: "auth", token }));
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
          try {
            ws.send(JSON.stringify({
              kind: "hello",
              hello: {
                protocol: "fastvibe.app",
                protocolVersion: 1,
                client: { kind: "mobile", version: this.#version },
                // Images are sent inline in prompt payloads; event batching remains
                // enabled for the ordered low-bandwidth stream.
                features: { eventBatch: true },
              },
            }));
          } catch {
            fail(new ConnectionError("unreachable", unreachable(address.origin)));
          }
          return;
        }
        if (!settled) {
          if (message.kind === "welcome") {
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
          if (this.#probeTimer) clearTimeout(this.#probeTimer);
          this.#probeTimer = null;
          this.#scheduleHealth();
          return;
        }
        if (message.kind === "resync") {
          this.#drop(true, { kind: "resync" });
          return;
        }
        if (message.kind === "result" && typeof message.requestId === "number") {
          const pending = this.#pending.get(message.requestId);
          if (!pending) return;
          clearTimeout(pending.timer);
          this.#pending.delete(message.requestId);
          if (message.ok === true) pending.resolve(message.result);
          else {
            const error = message.error as { message?: string } | undefined;
            pending.reject(new Error(error?.message || t("conn.requestFailed")));
          }
          return;
        }
        if (message.kind === "event" && typeof message.channel === "string") {
          this.#push?.(message.channel, message.payload);
          return;
        }
        if (message.kind === "events" && Array.isArray(message.events)) {
          for (const event of message.events) {
            if (isRecord(event) && typeof event.channel === "string") {
              this.#push?.(event.channel, event.payload);
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
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(requestId);
        reject(new TransportError("timeout", t("conn.requestTimeout")));
        // Do not replay a call Main may have accepted. Probe the connection instead.
        this.checkHealth();
      }, timeoutMs);
      this.#pending.set(requestId, { resolve, reject, timer });
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

  unsubscribe(scopes: string[]): void {
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
  }
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
