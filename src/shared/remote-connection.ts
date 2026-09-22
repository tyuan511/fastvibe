import type { AppCapability, AppEventCursor, AppHandshake } from "./app-protocol.ts";

/**
 * One App Server this machine is talking to.
 *
 * Distinct from `RemoteHostConnectionState`, which is the old single-host SSH pane
 * (`hostId: null` while nothing is selected). A connection here is keyed by the local
 * profile that reaches a server, and several may be up at once — there is no global
 * active host.
 */
export type RemoteConnectionState = "connecting" | "ready" | "closed" | "incompatible" | "error";

export type RemoteConnectionStatus = {
  connectionId: string;
  serverInstanceId: string | null;
  state: RemoteConnectionState;
  capabilities: AppCapability[];
  error?: string;
};

/**
 * Framing one App Server connection speaks.
 *
 * Structural copy of the AppClient transport so the connection manager can be tested
 * without loading that module, while the real client remains the production impl.
 */
export type RemoteMessageTransport = {
  send(message: unknown): void;
  onMessage(listener: (message: unknown) => void): () => void;
  onClose(listener: (reason: string) => void): () => void;
  close(): void;
};

/**
 * Why a client is not usable. Kept in lock-step with AppClient's status object: that
 * class owns the wire, this type is what the manager observes after handshake.
 */
export type RemoteClientStatus =
  | { state: "connecting" }
  | { state: "ready" }
  | { state: "closed" }
  | { state: "incompatible"; message: string }
  | { state: "error"; message: string };

export type RemoteCallOptions = {
  timeoutMs?: number;
  idempotencyKey?: string;
};

/**
 * Subscribe watermark. Canonical wire form is `{ epoch, seq }` per scope; a bare
 * number is accepted at this API and converted using the welcome (or supplied) epoch.
 */
export type RemoteSubscribeSince = Record<string, number | AppEventCursor>;

/**
 * The subset of AppClient the manager relies on.
 *
 * `call(method, payload)`, `connect()` (handshake), `onStatus` and `onPush` are the
 * stable surface — the envelope those methods speak may move, the names do not.
 * `subscribe` is required: a gateway has to take the live event stream, and an
 * optional method is how a fake silently drops it.
 */
export type RemoteAppClient = {
  connect(): Promise<AppHandshake>;
  call(method: string, payload?: unknown, options?: RemoteCallOptions): Promise<unknown>;
  close(): void;
  onPush(listener: (channel: string, payload: unknown) => void): void;
  onStatus(listener: (status: RemoteClientStatus) => void): void;
  subscribe(scopes: readonly string[], since?: RemoteSubscribeSince, epoch?: string): void;
  readonly handshake: AppHandshake | null;
};

/** First connected profile keeps the identity; a second profile that handshakes the same server is refused. */
export class DuplicateServerIdentityError extends Error {
  readonly serverInstanceId: string;
  readonly existingConnectionId: string;
  readonly attemptedConnectionId: string;

  constructor(serverInstanceId: string, existingConnectionId: string, attemptedConnectionId: string) {
    super(`远程服务器身份冲突：${serverInstanceId} 已通过连接 ${existingConnectionId} 接入`);
    this.name = "DuplicateServerIdentityError";
    this.serverInstanceId = serverInstanceId;
    this.existingConnectionId = existingConnectionId;
    this.attemptedConnectionId = attemptedConnectionId;
  }
}

export class MixedServerScopeError extends Error {
  readonly serverInstanceIds: string[];

  constructor(serverInstanceIds: string[]) {
    const unique = [...new Set(serverInstanceIds)];
    super(`请求混用了多个远程服务器（${unique.join("、")}）`);
    this.name = "MixedServerScopeError";
    this.serverInstanceIds = unique;
  }
}
