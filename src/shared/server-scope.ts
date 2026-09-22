import { decodeRemoteConversationId, decodeRemoteProjectKey, encodeRemoteConversationId, remoteProjectKey } from "./project-binding.ts";
import { MixedServerScopeError } from "./remote-connection.ts";

export { MixedServerScopeError };

/**
 * Where a call is going.
 *
 * Derived from the identifiers the renderer already holds rather than added as a
 * parallel argument to several dozen methods. A non-null scope is always the result of
 * finding a namespaced identifier, never of a global "am I connected" flag — that is
 * what makes two servers usable at once.
 */
export type ServerScope = {
  serverInstanceId: string;
};

/**
 * Top-level keys a payload may carry a destination in.
 *
 * Only these are read, and only at the top level. A prompt's `message`, a tool result,
 * or any nested object is out of scope on purpose: those graphs are large and routinely
 * quote ids that must not become a route.
 */
export const ROUTING_STRING_KEYS = ["conversationId", "project", "id", "cwd", "path", "parentId"] as const;

/** Top-level arrays of workspace ids (e.g. `projects:reorder`). */
export const ROUTING_STRING_ARRAY_KEYS = ["cwds"] as const;

export type RoutingStringKey = (typeof ROUTING_STRING_KEYS)[number];

/**
 * The server a method's payload is addressed to, or null when it is local.
 *
 * Throws `MixedServerScopeError` when two routing fields name different servers —
 * silently picking one would send a conversation to the wrong machine.
 */
export function resolveServerScope(payload: unknown): ServerScope | null {
  const ids = collectServerInstanceIds(payload);
  if (ids.length === 0) return null;
  const unique = [...new Set(ids)];
  if (unique.length > 1) throw new MixedServerScopeError(unique);
  return { serverInstanceId: unique[0]! };
}

/**
 * Server halves of the namespaced identifiers on this payload's routing fields.
 *
 * Empty means local. Order follows `ROUTING_STRING_KEYS` then `cwds`. Duplicates of the
 * same server are kept so a caller can tell "two fields, one server" from "one field".
 */
export function collectServerInstanceIds(payload: unknown): string[] {
  const found: string[] = [];
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return found;
  const record = payload as Record<string, unknown>;
  for (const key of ROUTING_STRING_KEYS) {
    const id = serverIdFromValue(record[key]);
    if (id) found.push(id);
  }
  const cwds = record.cwds;
  if (Array.isArray(cwds)) {
    for (const item of cwds) {
      const id = serverIdFromValue(item);
      if (id) found.push(id);
    }
  }
  return found;
}

/**
 * The server half of whichever namespaced identifier this payload carries.
 *
 * Null when every routing field is local (or absent). Mixed servers still return the
 * first — `resolveServerScope` is the function that refuses that case.
 */
export function findServerInstanceId(payload: unknown): string | null {
  return collectServerInstanceIds(payload)[0] ?? null;
}

/**
 * Strip `remote:<server>:` from the defined top-level routing fields so a call can be
 * sent to that server in its own vocabulary.
 *
 * Other fields — the prompt, images, tool arguments — are copied by reference. A field
 * namespaced for a *different* server is mixed and refused.
 */
export function unscopePayload<T>(payload: T, serverInstanceId: string): T {
  return rewritePayload(payload, serverInstanceId, "unscope");
}

/**
 * Qualify the defined top-level routing fields with `remote:<server>:`.
 *
 * Used on a reply that came back in the server's own ids, so the renderer keeps
 * addressing that conversation through the same opaque string it always has.
 */
export function scopePayload<T>(payload: T, serverInstanceId: string): T {
  return rewritePayload(payload, serverInstanceId, "scope");
}

export function unscopeId(value: string, serverInstanceId: string): string {
  return rewriteId(value, serverInstanceId, "unscope");
}

export function scopeId(value: string, serverInstanceId: string): string {
  return rewriteId(value, serverInstanceId, "scope");
}

function rewritePayload<T>(payload: T, serverInstanceId: string, direction: "scope" | "unscope"): T {
  if (typeof payload !== "object" || payload === null || Array.isArray(payload)) return payload;
  const record = payload as Record<string, unknown>;
  let changed = false;
  const next: Record<string, unknown> = { ...record };
  for (const key of ROUTING_STRING_KEYS) {
    const value = record[key];
    if (typeof value !== "string" || !value) continue;
    const rewritten = rewriteId(value, serverInstanceId, direction);
    if (rewritten !== value) {
      next[key] = rewritten;
      changed = true;
    }
  }
  if (Array.isArray(record.cwds)) {
    const original = record.cwds as unknown[];
    const cwds = original.map((item) =>
      typeof item === "string" && item ? rewriteId(item, serverInstanceId, direction) : item,
    );
    if (cwds.some((item, index) => item !== original[index])) {
      next.cwds = cwds;
      changed = true;
    }
  }
  return (changed ? next : payload) as T;
}

function rewriteId(value: string, serverInstanceId: string, direction: "scope" | "unscope"): string {
  if (direction === "unscope") return peelScopedId(value, serverInstanceId);
  const decoded = decodeScopedId(value);
  if (decoded) {
    if (decoded.serverInstanceId !== serverInstanceId) {
      throw new MixedServerScopeError([decoded.serverInstanceId, serverInstanceId]);
    }
    return value;
  }
  return encodeRemoteConversationId(serverInstanceId, value);
}

/** Either spelling of `remote:<server>:<local>` — conversation id and project key share one codec. */
/**
 * Strip every `remote:<server>:` layer that belongs to this server.
 *
 * One strip is not enough. A project key that was encoded twice
 * (`remote:srv:remote:srv:/path`) still looks remote after the first cut, and the
 * server then refuses to attach the conversation: the id is local and the project is not.
 */
function peelScopedId(value: string, serverInstanceId: string): string {
  let current = value;
  while (true) {
    const decoded = decodeScopedId(current);
    if (!decoded) return current;
    if (decoded.serverInstanceId !== serverInstanceId) {
      throw new MixedServerScopeError([decoded.serverInstanceId, serverInstanceId]);
    }
    current = decoded.localId;
  }
}

/**
 * Whether a conversation and a project live on the same server.
 *
 * Both local (no namespace) counts as the same server. A local draft cannot be moved
 * onto a remote project, and a remote draft cannot be moved onto another server — the
 * caller has to create a conversation there instead.
 */
export function sameServerScope(conversationId: string | null | undefined, project: string | null | undefined): boolean {
  const left = typeof conversationId === "string" && conversationId ? decodeScopedId(conversationId)?.serverInstanceId ?? null : null;
  const right = typeof project === "string" && project ? decodeScopedId(project)?.serverInstanceId ?? null : null;
  return left === right;
}

export function decodeScopedId(value: unknown): { serverInstanceId: string; localId: string } | null {
  if (typeof value !== "string" || !value) return null;
  const conversation = decodeRemoteConversationId(value);
  if (conversation) {
    return { serverInstanceId: conversation.serverInstanceId, localId: conversation.remoteConversationId };
  }
  const project = decodeRemoteProjectKey(value);
  if (project) {
    return { serverInstanceId: project.serverInstanceId, localId: project.remoteWorkspaceId };
  }
  return null;
}

function serverIdFromValue(value: unknown): string | null {
  return decodeScopedId(value)?.serverInstanceId ?? null;
}

/** Qualify a workspace / project key. Same codec as a conversation id, different noun. */
export function scopeWorkspaceId(serverInstanceId: string, workspaceId: string): string {
  const decoded = decodeRemoteProjectKey(workspaceId) ?? decodeRemoteConversationId(workspaceId);
  if (decoded) return workspaceId;
  return remoteProjectKey(serverInstanceId, workspaceId);
}
