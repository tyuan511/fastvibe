import type { ServerAddress } from "./address";
import { t } from "../i18n/core.ts";

const CONNECT_TIMEOUT_MS = 20_000;

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

export type PushHandler = (channel: string, payload: unknown) => void;
export type DisconnectHandler = (reason: string) => void;

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
        reject(new Error(unreachable(address.origin)));
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
        try {
          ws.close();
        } catch {
          // already gone
        }
        reject(error);
      };
      const timer = setTimeout(() => fail(new Error(t("conn.timeout"))), CONNECT_TIMEOUT_MS);

      ws.onopen = () => {
        if (stale()) return;
        ws.send(JSON.stringify({ type: "auth", token }));
      };
      ws.onerror = () => fail(new Error(unreachable(address.origin)));
      ws.onclose = (event) => {
        if (stale()) return;
        if (!settled) fail(new Error(t("conn.closedEarly")));
        else {
          this.#failPending("dropped");
          const detail = event.code > 0
            ? `（code ${event.code}${event.reason ? `：${event.reason}` : ""}）`
            : "";
          this.#disconnect?.(`${t("conn.dropped")}${detail}`);
        }
      };
      ws.onmessage = (event) => {
        if (stale()) return;
        const message = parseFrame(event.data);
        if (!message) return;
        if (!authed) {
          if (message.type !== "auth") return;
          if (message.ok !== true) {
            fail(new Error("UNAUTHORIZED"));
            return;
          }
          authed = true;
          ws.send(
            JSON.stringify({
              kind: "hello",
              hello: {
                protocol: "fastvibe.app",
                protocolVersion: 1,
                client: { kind: "mobile", version: "0.1.0" },
                // The native client has no image attachment sender yet, but it can
                // consume the ordered event batches used for low-bandwidth streams.
                features: { eventBatch: true },
              },
            }),
          );
          return;
        }
        if (!settled) {
          if (message.kind === "welcome") {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
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
      // A subscription is best effort; the reconnect path will subscribe again.
    }
  }

  #drop(notify: boolean): void {
    this.#generation += 1;
    this.#failPending("closed");
    const ws = this.#ws;
    this.#ws = null;
    if (ws) {
      ws.onopen = null;
      ws.onmessage = null;
      ws.onerror = null;
      ws.onclose = null;
      if (ws.readyState < WebSocket.CLOSING) ws.close();
    }
    if (notify) this.#disconnect?.(t("conn.closed"));
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
