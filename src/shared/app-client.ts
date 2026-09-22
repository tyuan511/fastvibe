import {
  APP_PROTOCOL,
  APP_PROTOCOL_VERSION,
  isAppCapability,
  isValidEventCursor,
  isValidServerInstanceId,
  type AppCapability,
  type AppEventCursor,
  type AppHandshake,
} from "./app-protocol.ts";

/**
 * A client of another App Server.
 *
 * Speaks the App Protocol envelope over any framed transport: hello/welcome, call/result,
 * subscribe/event/resync. The transport is the only I/O; this module has no Node imports
 * so the same class can run in a browser. Timeouts call `unref` when the timer provides it.
 *
 * Handshake is exact v1. A welcome that names another protocol, another version, or that
 * omits the fields the wire now requires (`epoch`, `sessionId`) is refused at once — there
 * is no compatibility reading of older frames, and no guessing of a missing epoch.
 */

/** The framing one App Server connection speaks. */
export interface MessageTransport {
  send(message: unknown): void;
  /** Returns an unsubscribe. */
  onMessage(listener: (message: unknown) => void): () => void;
  /** Returns an unsubscribe. Fires once, when the connection is gone for any reason. */
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
}

/**
 * Why a connection is not usable.
 *
 * The four cases are kept apart because each has a different remedy. `incompatible` in
 * particular is not the user's fault and not fixable by retrying, which is why it is not
 * folded into `error`.
 */
export type AppClientStatus =
  | { state: "connecting" }
  | { state: "ready" }
  | { state: "closed" }
  | { state: "incompatible"; message: string }
  | { state: "error"; message: string };

export type AppClientOptions = {
  /** What this client knows how to speak, offered to the server. */
  client: { kind: string; version: string };
  capabilities?: readonly AppCapability[];
  /** How long to wait for the server's welcome before giving up. */
  handshakeTimeoutMs?: number;
  /** Optional deadline for `call`. Abandoned locally; the work is not claimed aborted. */
  callTimeoutMs?: number;
  log?: { info(message: string): void; warn(message: string): void };
};

export type AppCallOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
};

/** Canonical `{ epoch, seq }` per scope; a bare number is converted with the active epoch. */
export type AppSubscribeSince = Record<string, number | AppEventCursor>;

export type AppResync = {
  scope: string;
  reason: string;
  epoch?: string;
};

const DEFAULT_HANDSHAKE_TIMEOUT_MS = 15_000;

type PendingCall = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout> | null;
};

type WelcomeOk = {
  handshake: AppHandshake;
  sessionId: string;
  epoch: string;
  capabilities: AppCapability[];
};

export class AppClient {
  #transport: MessageTransport;
  #options: AppClientOptions;
  #status: AppClientStatus = { state: "connecting" };
  #handshake: AppHandshake | null = null;
  #capabilities: AppCapability[] = [];
  #epoch: string | null = null;
  #sessionId: string | null = null;
  #nextId = 1;
  #pending = new Map<number, PendingCall>();
  #cursors = new Map<string, number>();
  #pushListener: ((channel: string, payload: unknown) => void) | null = null;
  #statusListener: ((status: AppClientStatus) => void) | null = null;
  #resyncListener: ((resync: AppResync) => void) | null = null;
  #connectPromise: Promise<AppHandshake> | null = null;
  #unsubscribe: Array<() => void> = [];
  #closed = false;
  #ready = false;
  #handshakeTimer: ReturnType<typeof setTimeout> | null = null;
  #handshakeWait: {
    resolve: (handshake: AppHandshake) => void;
    reject: (error: Error) => void;
  } | null = null;

  constructor(transport: MessageTransport, options: AppClientOptions) {
    this.#transport = transport;
    this.#options = options;
  }

  get status(): AppClientStatus {
    return this.#status;
  }

  /** The server's identity and capabilities. Null until the handshake lands. */
  get handshake(): AppHandshake | null {
    return this.#handshake;
  }

  get capabilities(): AppCapability[] {
    return [...this.#capabilities];
  }

  /** Current event-stream generation, from welcome (and later resync/event). */
  get epoch(): string | null {
    return this.#epoch;
  }

  /** Last seen sequence per scope in the current epoch. */
  cursors(): Record<string, number> {
    const epoch = this.#epoch;
    if (!epoch) return {};
    const prefix = `${epoch}\0`;
    const out: Record<string, number> = {};
    for (const [key, seq] of this.#cursors) {
      if (!key.startsWith(prefix)) continue;
      out[key.slice(prefix.length)] = seq;
    }
    return out;
  }

  /** Canonical `{ epoch, seq }` per seen scope in the current welcome epoch. */
  eventCursors(): Record<string, AppEventCursor> {
    const epoch = this.#epoch;
    if (!epoch) return {};
    const out: Record<string, AppEventCursor> = {};
    for (const [scope, seq] of Object.entries(this.cursors())) {
      out[scope] = { epoch, seq };
    }
    return out;
  }

  onPush(listener: (channel: string, payload: unknown) => void): void {
    this.#pushListener = listener;
  }

  onStatus(listener: (status: AppClientStatus) => void): void {
    this.#statusListener = listener;
    if (
      this.#status.state === "closed"
      || this.#status.state === "error"
      || this.#status.state === "incompatible"
    ) {
      listener(this.#status);
    }
  }

  onResync(listener: (resync: AppResync) => void): void {
    this.#resyncListener = listener;
  }

  /**
   * Perform the handshake.
   *
   * One promise per instance: concurrent callers share it, and a later `connect`
   * after close or failure is refused rather than starting a second handshake.
   * Resolves with the server's half on success, and rejects — with the connection
   * already torn down — when the server cannot be spoken to.
   */
  connect(): Promise<AppHandshake> {
    if (this.#closed) return Promise.reject(new Error("远程连接已关闭"));
    if (this.#connectPromise) return this.#connectPromise;
    this.#connectPromise = this.#open();
    return this.#connectPromise;
  }

  #open(): Promise<AppHandshake> {
    this.#setStatus({ state: "connecting" });
    return new Promise<AppHandshake>((resolve, reject) => {
      this.#handshakeWait = { resolve, reject };
      this.#unsubscribe.push(
        this.#transport.onMessage((message) => this.#onMessage(message)),
        this.#transport.onClose((reason) => this.#onTransportClose(reason)),
      );

      const timeoutMs = this.#options.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS;
      const timer = setTimeout(() => {
        this.#failHandshake("error", "远程 App Server 未响应握手");
      }, timeoutMs);
      timer.unref?.();
      this.#handshakeTimer = timer;

      const hello = {
        protocol: APP_PROTOCOL,
        protocolVersion: APP_PROTOCOL_VERSION,
        client: this.#options.client,
        capabilities: this.#options.capabilities ? [...this.#options.capabilities] : undefined,
      };
      try {
        this.#transport.send({ kind: "hello", hello });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#failHandshake("error", message);
      }
    });
  }

  /** Whether one call is worth attempting against this server. */
  supports(capability: AppCapability): boolean {
    return this.#capabilities.includes(capability);
  }

  call(method: string, payload?: unknown, options?: AppCallOptions): Promise<unknown> {
    if (this.#closed) return Promise.reject(new Error("远程连接已关闭"));
    if (!this.#ready) return Promise.reject(new Error("远程连接尚未就绪"));
    const id = this.#nextId++;
    const timeoutMs = options?.timeoutMs ?? this.#options.callTimeoutMs;
    return new Promise((resolve, reject) => {
      const pending: PendingCall = { resolve, reject, timer: null };
      if (timeoutMs !== undefined && timeoutMs > 0) {
        const timer = setTimeout(() => {
          if (!this.#pending.delete(id)) return;
          pending.timer = null;
          this.#abandon(id);
          reject(new Error("远程 App Server 响应超时"));
        }, timeoutMs);
        timer.unref?.();
        pending.timer = timer;
      }
      this.#pending.set(id, pending);
      const frame: Record<string, unknown> = { kind: "call", requestId: id, method, payload };
      if (typeof options?.idempotencyKey === "string") frame.idempotencyKey = options.idempotencyKey;
      try {
        this.#transport.send(frame);
      } catch (error) {
        this.#dropPending(id);
        reject(error instanceof Error ? error : new Error(String(error)));
      }
    });
  }

  /**
   * Subscribe to event scopes.
   *
   * The subscribe frame always carries the welcome epoch. `since` is sent as-is when
   * already canonical; a numeric watermark is converted with that same welcome epoch,
   * never with a caller-supplied older one — adopting the cursor epoch would hide a
   * restart. Local `#epoch` does not move here. Local cursors advance only for since
   * entries that already belong to the welcome epoch.
   */
  subscribe(scopes: readonly string[], since?: AppSubscribeSince, epoch?: string): void {
    if (!this.#ready || this.#closed) throw new Error("远程连接尚未就绪");
    const welcomeEpoch = this.#epoch;
    if (typeof welcomeEpoch !== "string" || welcomeEpoch.length === 0) {
      throw new Error("远程连接尚未就绪");
    }
    // A mismatched third argument is not adopted. #epoch is welcome-only; using
    // an older cursor epoch here is how a restart would be skipped.
    if (epoch && epoch !== welcomeEpoch) {
      this.#options.log?.warn("app client subscribe ignored stale epoch argument");
    }
    const cursors = normalizeSince(since, welcomeEpoch);
    if (cursors) {
      for (const [scope, cursor] of Object.entries(cursors)) {
        if (cursor.epoch === welcomeEpoch) this.#advanceCursor(cursor.epoch, scope, cursor.seq);
      }
    }
    const frame: Record<string, unknown> = {
      kind: "subscribe",
      scopes: [...scopes],
      epoch: welcomeEpoch,
    };
    if (cursors) frame.since = cursors;
    this.#transport.send(frame);
  }

  unsubscribe(scopes: readonly string[]): void {
    if (!this.#ready || this.#closed) throw new Error("远程连接尚未就绪");
    this.#transport.send({ kind: "unsubscribe", scopes: [...scopes] });
  }

  close(): void {
    if (this.#closed && this.#status.state === "closed") return;
    this.#failHandshake("closed", "远程连接已关闭");
    this.#teardown();
    this.#setStatus({ state: "closed" });
  }

  #onTransportClose(reason: string): void {
    const message = reason || "远程连接已断开";
    if (!this.#ready) {
      this.#failHandshake("error", message);
      return;
    }
    this.#fail(message);
  }

  #onMessage(message: unknown): void {
    if (typeof message !== "object" || message === null) {
      if (!this.#ready) this.#failHandshake("error", "远程 App Server 握手无效");
      return;
    }
    const record = message as Record<string, unknown>;

    if (!this.#ready) {
      this.#receiveWelcome(record);
      return;
    }

    if (record.kind === "result") {
      this.#receiveResult(record);
      return;
    }
    if (record.kind === "event") {
      this.#receiveEvent(record);
      return;
    }
    if (record.kind === "resync") {
      this.#receiveResync(record);
      return;
    }
  }

  #receiveWelcome(record: Record<string, unknown>): void {
    const parsed = parseWelcome(record);
    if (parsed === "mismatch") {
      const version = handshakeVersion(record.handshake);
      const message = `远程 App Server 协议版本不兼容（对端 ${version}，本机 ${APP_PROTOCOL_VERSION}）`;
      this.#failHandshake("incompatible", message);
      return;
    }
    if (parsed === "invalid") {
      this.#failHandshake("error", "远程 App Server 握手无效");
      return;
    }
    this.#handshake = parsed.handshake;
    this.#capabilities = parsed.capabilities;
    this.#epoch = parsed.epoch;
    this.#sessionId = parsed.sessionId;
    this.#ready = true;
    this.#clearHandshakeTimer();
    this.#setStatus({ state: "ready" });
    this.#options.log?.info(
      `app client ready server=${parsed.handshake.server.serverInstanceId} session=${this.#sessionId} epoch=${this.#epoch} capabilities=${parsed.capabilities.join(",")}`,
    );
    const wait = this.#handshakeWait;
    this.#handshakeWait = null;
    wait?.resolve(parsed.handshake);
  }

  #receiveResult(record: Record<string, unknown>): void {
    if (typeof record.requestId !== "number") return;
    const pending = this.#pending.get(record.requestId);
    if (!pending) return;
    this.#dropPending(record.requestId);
    if (record.ok === true) {
      pending.resolve(record.result);
      return;
    }
    const error = record.error;
    const message =
      typeof error === "object"
      && error !== null
      && typeof (error as Record<string, unknown>).message === "string"
        ? String((error as Record<string, unknown>).message)
        : "远程 App Server 请求失败";
    pending.reject(new Error(message));
  }

  #receiveEvent(record: Record<string, unknown>): void {
    if (typeof record.scope !== "string" || typeof record.channel !== "string") return;
    const cursor = { epoch: record.epoch, seq: record.seq };
    if (!isValidEventCursor(cursor)) return;
    const { epoch, seq } = cursor;
    if (!this.#epoch) return;
    if (epoch !== this.#epoch) {
      this.#resyncListener?.({
        scope: record.scope,
        reason: "事件纪元不匹配",
        epoch,
      });
      return;
    }
    if (this.#isDuplicate(epoch, record.scope, seq)) return;
    if (this.#pushListener) {
      try {
        this.#pushListener(record.channel, record.payload);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.#options.log?.warn(`app client push reducer failed channel=${record.channel} ${message}`);
        return;
      }
    }
    this.#advanceCursor(epoch, record.scope, seq);
  }

  #receiveResync(record: Record<string, unknown>): void {
    if (typeof record.scope !== "string") return;
    const epoch = typeof record.epoch === "string" && record.epoch.length > 0 ? record.epoch : undefined;
    const reason = typeof record.reason === "string" ? record.reason : "";
    if (epoch && this.#epoch && epoch !== this.#epoch) {
      this.#resyncListener?.({ scope: record.scope, reason: reason || "事件纪元不匹配", epoch });
      return;
    }
    const keyEpoch = epoch ?? this.#epoch;
    if (keyEpoch) this.#cursors.delete(cursorKey(keyEpoch, record.scope));
    this.#resyncListener?.({
      scope: record.scope,
      reason,
      ...(epoch ? { epoch } : {}),
    });
  }

  #isDuplicate(epoch: string, scope: string, seq: number): boolean {
    const prev = this.#cursors.get(cursorKey(epoch, scope));
    return prev !== undefined && seq <= prev;
  }

  #advanceCursor(epoch: string, scope: string, seq: number): void {
    const key = cursorKey(epoch, scope);
    const prev = this.#cursors.get(key);
    if (prev === undefined || seq > prev) this.#cursors.set(key, seq);
  }

  #abandon(requestId: number): void {
    try {
      this.#transport.send({ kind: "cancel", targetRequestId: requestId, reason: "timeout" });
    } catch {
      // The local waiter is already finished; a send failure cannot abort work we never claimed to stop.
    }
  }

  #dropPending(id: number): PendingCall | undefined {
    const pending = this.#pending.get(id);
    if (!pending) return undefined;
    this.#pending.delete(id);
    if (pending.timer !== null) {
      clearTimeout(pending.timer);
      pending.timer = null;
    }
    return pending;
  }

  #rejectAllPending(message: string): void {
    const error = new Error(message);
    for (const [id, pending] of this.#pending) {
      if (pending.timer !== null) clearTimeout(pending.timer);
      pending.reject(error);
      this.#pending.delete(id);
    }
  }

  #failHandshake(kind: "error" | "incompatible" | "closed", message: string): void {
    const wait = this.#handshakeWait;
    if (!wait) return;
    this.#handshakeWait = null;
    this.#clearHandshakeTimer();
    this.#teardown();
    if (kind === "incompatible") this.#setStatus({ state: "incompatible", message });
    else if (kind === "closed") this.#setStatus({ state: "closed" });
    else this.#setStatus({ state: "error", message });
    wait.reject(new Error(message));
  }

  #fail(reason: string): void {
    if (this.#closed) {
      this.#rejectAllPending("远程连接已断开");
      return;
    }
    const wasReady = this.#ready;
    this.#teardown();
    if (wasReady) this.#setStatus({ state: "error", message: reason });
  }

  #clearHandshakeTimer(): void {
    if (this.#handshakeTimer === null) return;
    clearTimeout(this.#handshakeTimer);
    this.#handshakeTimer = null;
  }

  #teardown(): void {
    if (this.#closed) {
      this.#rejectAllPending("远程连接已断开");
      return;
    }
    this.#closed = true;
    this.#ready = false;
    this.#clearHandshakeTimer();
    for (const unsubscribe of this.#unsubscribe) {
      try {
        unsubscribe();
      } catch {
        // Listener removal must not block settling in-flight calls.
      }
    }
    this.#unsubscribe = [];
    this.#rejectAllPending("远程连接已断开");
    try {
      this.#transport.close();
    } catch {
      // Already gone.
    }
  }

  #setStatus(status: AppClientStatus): void {
    this.#status = status;
    this.#statusListener?.(status);
  }
}

function cursorKey(epoch: string, scope: string): string {
  return `${epoch}\0${scope}`;
}

function normalizeSince(
  since: AppSubscribeSince | undefined,
  epoch: string,
): Record<string, AppEventCursor> | undefined {
  if (!since) return undefined;
  const out: Record<string, AppEventCursor> = {};
  for (const [scope, value] of Object.entries(since)) {
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      out[scope] = { epoch, seq: value };
    } else if (isValidEventCursor(value)) {
      out[scope] = { epoch: value.epoch, seq: value.seq };
    }
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function handshakeVersion(value: unknown): string {
  if (typeof value !== "object" || value === null) return "unknown";
  const version = (value as Record<string, unknown>).protocolVersion;
  return typeof version === "number" ? String(version) : "unknown";
}

/**
 * Strict welcome: kind, handshake at exact v1, sessionId, epoch. Anything else is
 * invalid or a protocol mismatch — never coerced into a usable handshake.
 */
function parseWelcome(record: Record<string, unknown>): WelcomeOk | "invalid" | "mismatch" {
  if (record.kind !== "welcome") return "invalid";
  if (typeof record.epoch !== "string" || record.epoch.length === 0) return "invalid";
  if (typeof record.sessionId !== "string" || record.sessionId.length === 0) return "invalid";
  const handshake = parseExactHandshake(record.handshake);
  if (handshake === "mismatch") return "mismatch";
  if (!handshake) return "invalid";
  // An empty list stays empty: it is not "absent", and must not fall back to the
  // handshake's set (that would turn a narrowed welcome into a full grant).
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter(isAppCapability)
    : handshake.capabilities;
  return {
    handshake: { ...handshake, capabilities },
    sessionId: record.sessionId,
    epoch: record.epoch,
    capabilities,
  };
}

function parseExactHandshake(value: unknown): AppHandshake | "mismatch" | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.protocol !== "string" || typeof record.protocolVersion !== "number") return null;
  if (record.protocol !== APP_PROTOCOL || record.protocolVersion !== APP_PROTOCOL_VERSION) {
    return "mismatch";
  }
  const server = record.server;
  if (typeof server !== "object" || server === null) return null;
  const identity = server as Record<string, unknown>;
  if (!isValidServerInstanceId(identity.serverInstanceId)) return null;
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter(isAppCapability)
    : [];
  return {
    protocol: APP_PROTOCOL,
    protocolVersion: APP_PROTOCOL_VERSION,
    server: {
      serverInstanceId: identity.serverInstanceId,
      version: typeof identity.version === "string" ? identity.version : "unknown",
      platform: typeof identity.platform === "string" ? identity.platform : "unknown",
    },
    capabilities,
  };
}
