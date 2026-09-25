/**
 * App Protocol v1 — the envelope every FastVibe UI client speaks.
 *
 * Method names stay in `ipc.ts`. This file is the wire contract: handshake, frames,
 * scopes, and cursors. Additive fields may appear; the version number does not move
 * unless an existing field changes meaning.
 */

import { randomUUID } from "./random.ts";

export const APP_PROTOCOL = "fastvibe.app";

/** Exact protocol version. Peers that do not speak 1 are incompatible. */
export const APP_PROTOCOL_VERSION = 1;

export const APP_CAPABILITIES = [
  "conversations",
  "engine",
  "workspace",
  "git",
  "terminal",
  "providers",
  "settings",
  "stats",
  "imports",
  "extensions",
  "browser",
  "native",
] as const;

export type AppCapability = (typeof APP_CAPABILITIES)[number];

const CAPABILITY_SET: ReadonlySet<string> = new Set(APP_CAPABILITIES);

export function isAppCapability(value: unknown): value is AppCapability {
  return typeof value === "string" && CAPABILITY_SET.has(value);
}

/**
 * Stable name of one App Server installation.
 *
 * Embedded in composite keys split on `:`, so the id itself cannot contain `:`.
 */
export const SERVER_INSTANCE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

export function isValidServerInstanceId(value: unknown): value is string {
  return typeof value === "string" && SERVER_INSTANCE_ID_PATTERN.test(value);
}

export function newServerInstanceId(random: () => string = randomUUID): string {
  return `srv_${random().replace(/[^A-Za-z0-9]/g, "").slice(0, 20)}`;
}

export type AppServerIdentity = {
  serverInstanceId: string;
  /** FastVibe build on that machine. Diagnostics only. */
  version: string;
  platform: string;
};

export type AppHandshake = {
  protocol: string;
  protocolVersion: number;
  server: AppServerIdentity;
  capabilities: AppCapability[];
};

export type AppClientHello = {
  protocol: string;
  protocolVersion: number;
  client: { kind: string; version: string };
  /** Absent or empty: the client accepts the server's set. */
  capabilities?: AppCapability[];
  /** Optional transport features. Omitted by older clients for compatibility. */
  features?: {
    eventBatch?: boolean;
    binaryAttachments?: boolean;
  };
};

/**
 * Intersection of what the server offers and what the client declared.
 * A declaration can only narrow; it cannot grant a capability the server lacks.
 */
export function intersectCapabilities(
  server: readonly AppCapability[],
  client?: readonly AppCapability[] | null,
): AppCapability[] {
  if (!client || client.length === 0) return [...server];
  const clientSet = new Set<string>(client);
  return server.filter((capability) => clientSet.has(capability));
}

export function isProtocolCompatible(handshake: Pick<AppHandshake, "protocol" | "protocolVersion">): boolean {
  return handshake.protocol === APP_PROTOCOL && handshake.protocolVersion === APP_PROTOCOL_VERSION;
}

export function readHandshake(value: unknown): AppHandshake | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (record.protocol !== APP_PROTOCOL) return null;
  if (!Number.isInteger(record.protocolVersion) || (record.protocolVersion as number) < 0) return null;
  const server = record.server;
  if (typeof server !== "object" || server === null) return null;
  const identity = server as Record<string, unknown>;
  if (!isValidServerInstanceId(identity.serverInstanceId)) return null;
  const capabilities = Array.isArray(record.capabilities)
    ? record.capabilities.filter(isAppCapability)
    : [];
  return {
    protocol: APP_PROTOCOL,
    protocolVersion: record.protocolVersion as number,
    server: {
      serverInstanceId: identity.serverInstanceId,
      version: typeof identity.version === "string" ? identity.version : "unknown",
      platform: typeof identity.platform === "string" ? identity.platform : "unknown",
    },
    capabilities,
  };
}

export type AppScope = string;

export const installationScope: AppScope = "installation";

/**
 * Live catch-all for a gateway that must see every scope.
 *
 * Subscribe without `since` to receive new events. Resume is not defined: a `since`
 * cursor on `*` always yields `resync`. Replay every retained scope instead, or
 * re-read snapshots.
 */
export const ALL_SCOPES: AppScope = "*";

export function conversationScope(conversationId: string): AppScope {
  return `conversation:${conversationId}`;
}

export function workspaceScope(projectKey: string): AppScope {
  return `workspace:${projectKey}`;
}

export function resourceScope(resourceId: string): AppScope {
  return `resource:${resourceId}`;
}

export function isValidAppScope(value: unknown): value is AppScope {
  if (typeof value !== "string" || value.length === 0 || value.length > 256) return false;
  if (value === ALL_SCOPES || value === installationScope) return true;
  if (value.startsWith("conversation:") && value.length > "conversation:".length) return true;
  if (value.startsWith("workspace:") && value.length > "workspace:".length) return true;
  if (value.startsWith("resource:") && value.length > "resource:".length) return true;
  return false;
}

/** Resume watermark for one named scope. Meaningless on `*` (see ALL_SCOPES). */
export type AppEventCursor = {
  epoch: string;
  seq: number;
};

export function isValidEventCursor(value: unknown): value is AppEventCursor {
  if (typeof value !== "object" || value === null) return false;
  const record = value as Record<string, unknown>;
  if (typeof record.epoch !== "string" || record.epoch.length === 0 || record.epoch.length > 128) return false;
  return Number.isSafeInteger(record.seq) && (record.seq as number) >= 0;
}

export function isValidRequestId(value: unknown): value is number {
  return Number.isSafeInteger(value) && (value as number) >= 0;
}

export type AppCallMessage = {
  kind: "call";
  requestId: number;
  method: string;
  payload?: unknown;
  /** Bounded subject+key dedupe on the server. Omitted: no dedupe. */
  idempotencyKey?: string;
};

export type AppQueryMessage = {
  kind: "query";
  requestId: number;
  method: string;
  payload?: unknown;
};

export type AppSubscribeMessage = {
  kind: "subscribe";
  scopes: AppScope[];
  since?: Record<AppScope, AppEventCursor>;
};

export type AppUnsubscribeMessage = { kind: "unsubscribe"; scopes: AppScope[] };

/** Abandon the matching in-flight result. Does not cancel work behind the call. */
export type AppCancelMessage = { kind: "cancel"; targetRequestId: number; reason?: string };

export type AppPingMessage = { kind: "ping" };
export type AppPongMessage = { kind: "pong" };

export type AppClientMessage =
  | { kind: "hello"; hello: AppClientHello }
  | AppCallMessage
  | AppQueryMessage
  | AppSubscribeMessage
  | AppUnsubscribeMessage
  | AppCancelMessage
  | AppPingMessage;

export type AppWelcomeMessage = {
  kind: "welcome";
  handshake: AppHandshake;
  sessionId: string;
  capabilities: AppCapability[];
  epoch: string;
  /** Features the server accepted for this session. Absent on older v1 servers. */
  features?: {
    eventBatch?: boolean;
    binaryAttachments?: boolean;
  };
};

export type AppResultMessage = {
  kind: "result";
  requestId: number;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
};

export type AppEventMessage = {
  kind: "event";
  scope: AppScope;
  seq: number;
  epoch: string;
  eventId: string;
  channel: string;
  payload?: unknown;
};

/** A transport-level batch of ordered events. Older clients never opt into this. */
export type AppEventBatchMessage = {
  kind: "events";
  events: AppEventMessage[];
};

export type AppResyncMessage = {
  kind: "resync";
  scope: AppScope;
  reason: string;
  epoch: string;
  seq: number;
};

export type AppServerMessage =
  | AppWelcomeMessage
  | AppResultMessage
  | AppEventMessage
  | AppEventBatchMessage
  | AppResyncMessage
  | AppPongMessage;

function readHello(value: unknown): AppClientHello | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  if (typeof record.protocol !== "string") return null;
  if (!Number.isInteger(record.protocolVersion) || (record.protocolVersion as number) < 0) return null;
  const client = record.client;
  if (typeof client !== "object" || client === null) return null;
  const identity = client as Record<string, unknown>;
  if (typeof identity.kind !== "string" || identity.kind.length === 0) return null;
  if (typeof identity.version !== "string" || identity.version.length === 0) return null;
  let capabilities: AppCapability[] | undefined;
  if (record.capabilities !== undefined) {
    if (!Array.isArray(record.capabilities)) return null;
    const declared = record.capabilities.filter(isAppCapability);
    // An unknown-only declaration must not become indistinguishable from an omitted
    // declaration (which means "all"). Mixed lists remain forward compatible.
    if (record.capabilities.length > 0 && declared.length === 0) return null;
    capabilities = declared;
  }
  let features: AppClientHello["features"] | undefined;
  if (record.features !== undefined) {
    if (typeof record.features !== "object" || record.features === null || Array.isArray(record.features)) return null;
    const declared = record.features as Record<string, unknown>;
    if (declared.eventBatch !== undefined && typeof declared.eventBatch !== "boolean") return null;
    if (declared.binaryAttachments !== undefined && typeof declared.binaryAttachments !== "boolean") return null;
    features = {
      ...(declared.eventBatch !== undefined ? { eventBatch: declared.eventBatch } : {}),
      ...(declared.binaryAttachments !== undefined ? { binaryAttachments: declared.binaryAttachments } : {}),
    };
  }
  return {
    protocol: record.protocol,
    protocolVersion: record.protocolVersion as number,
    client: { kind: identity.kind, version: identity.version },
    ...(capabilities ? { capabilities } : {}),
    ...(features ? { features } : {}),
  };
}

function readMethod(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 && value.length <= 256 ? value : null;
}

function readIdempotencyKey(value: unknown): string | null {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || value.length > 128) return null;
  return value;
}

function readScopes(value: unknown): AppScope[] | null {
  if (!Array.isArray(value) || value.length > 256) return null;
  const scopes: AppScope[] = [];
  for (const item of value) {
    if (!isValidAppScope(item)) return null;
    scopes.push(item);
  }
  return scopes;
}

function readSince(value: unknown): Record<AppScope, AppEventCursor> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  const since: Record<AppScope, AppEventCursor> = {};
  for (const [scope, cursor] of Object.entries(value as Record<string, unknown>)) {
    if (!isValidAppScope(scope) || !isValidEventCursor(cursor)) return null;
    since[scope] = { epoch: cursor.epoch, seq: cursor.seq };
  }
  return since;
}

/**
 * Parse a canonical client envelope. Unknown kinds, legacy `{ id, method }` frames,
 * and malformed fields are rejected (`null`).
 */
export function readClientMessage(raw: unknown): AppClientMessage | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  if (typeof record.kind !== "string") return null;

  switch (record.kind) {
    case "hello": {
      const hello = readHello(record.hello);
      if (!hello) return null;
      return { kind: "hello", hello };
    }
    case "call":
    case "query": {
      if (!isValidRequestId(record.requestId)) return null;
      const method = readMethod(record.method);
      if (!method) return null;
      if (record.kind === "call") {
        if (record.idempotencyKey !== undefined) {
          const key = readIdempotencyKey(record.idempotencyKey);
          if (!key) return null;
          return { kind: "call", requestId: record.requestId, method, payload: record.payload, idempotencyKey: key };
        }
        return { kind: "call", requestId: record.requestId, method, payload: record.payload };
      }
      if (record.idempotencyKey !== undefined) return null;
      return { kind: "query", requestId: record.requestId, method, payload: record.payload };
    }
    case "subscribe": {
      const scopes = readScopes(record.scopes);
      if (!scopes) return null;
      if (record.since === undefined) return { kind: "subscribe", scopes };
      const since = readSince(record.since);
      if (!since) return null;
      const requested = new Set(scopes);
      if (Object.keys(since).some((scope) => !requested.has(scope))) return null;
      return { kind: "subscribe", scopes, since };
    }
    case "unsubscribe": {
      const scopes = readScopes(record.scopes);
      if (!scopes) return null;
      return { kind: "unsubscribe", scopes };
    }
    case "cancel": {
      if (!isValidRequestId(record.targetRequestId)) return null;
      return {
        kind: "cancel",
        targetRequestId: record.targetRequestId,
        ...(typeof record.reason === "string" ? { reason: record.reason } : {}),
      };
    }
    case "ping":
      return { kind: "ping" };
    default:
      return null;
  }
}
