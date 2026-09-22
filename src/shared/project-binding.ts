import { isValidServerInstanceId, type AppCapability } from "./app-protocol.ts";

/**
 * A project that lives on another App Server.
 *
 * The branch this replaces treated "remote" as "the same machine, reached over a
 * tunnel": connecting an SSH host replaced the whole call table, so the sidebar listed
 * the *remote* server's projects and conversations, and adding a remote folder wrote it
 * into that server's catalog. The user's own projects then depended on which host they
 * happened to be connected to, one connection at a time, and disconnecting made them
 * disappear.
 *
 * The split here is the one the rest of the design is built on:
 *
 *   - the remote App Server owns its workspaces, conversations and transcripts;
 *   - this machine records only a *reference* to one of them, which it can list, name
 *     and open without owning anything;
 *   - a reference outlives the connection, so a project stays in the list while the
 *     server is unreachable, and comes back when it is.
 *
 * Nothing about a binding is a local path. `remotePath` is a string to show and to send
 * back over the wire — never something this process opens.
 */

/**
 * The one prefix that marks an identifier as belonging to another server.
 *
 * Two things wear it: a remote conversation id, and the synthetic project key a remote
 * binding is grouped under. Both are `remote:<serverInstanceId>:<local id>`, so one
 * codec serves both and the runtime shape of an id tells you where to send it.
 */
const REF_PREFIX = "remote";

function encodeRef(serverInstanceId: string, localId: string): string {
  const server = serverInstanceId.trim();
  const local = localId.trim();
  if (!server || !local) throw new Error("远程标识不完整");
  // The server half is the only part that cannot contain the separator, because it is
  // where the split happens. A local id that contains one survives: everything after
  // the second colon is taken verbatim.
  if (server.includes(":")) throw new Error("远程服务器标识无效");
  return `${REF_PREFIX}:${server}:${local}`;
}

function decodeRef(value: string): { serverInstanceId: string; localId: string } | null {
  if (typeof value !== "string") return null;
  const id = value.trim();
  if (!id.startsWith(`${REF_PREFIX}:`)) return null;
  const rest = id.slice(REF_PREFIX.length + 1);
  const separator = rest.indexOf(":");
  // `remote::x` and `remote:srv:` are both malformed: a ref names a server and a thing
  // on it, and a half of either is a key that would route nowhere.
  if (separator <= 0 || separator === rest.length - 1) return null;
  // The server half is held to the same rule that produced it, so a ref this codec can
  // read is a ref it could have written. Checking only for non-emptiness let `remote: :x`
  // through — a whitespace id names no server, and would route a request at nothing.
  const serverInstanceId = rest.slice(0, separator);
  if (!isValidServerInstanceId(serverInstanceId)) return null;
  return { serverInstanceId, localId: rest.slice(separator + 1) };
}

/**
 * A conversation id, qualified by the server that owns it.
 *
 * This is what makes per-request routing possible without threading a scope object
 * through every call, every payload and every store map. The renderer keeps using an
 * opaque string as it always has — as a route segment, a key in `running`,
 * `pendingPermissions`, `extensionStatus` — and the one place that turns that string
 * into a destination is Main's dispatcher.
 *
 * It also removes an ambiguity the old design could not express at all: two servers are
 * free to mint the same UUID, and the namespaced ids stay distinct.
 */
export function encodeRemoteConversationId(serverInstanceId: string, remoteConversationId: string): string {
  return encodeRef(serverInstanceId, remoteConversationId);
}

export function decodeRemoteConversationId(
  id: string,
): { serverInstanceId: string; remoteConversationId: string } | null {
  const decoded = decodeRef(id);
  if (!decoded) return null;
  return { serverInstanceId: decoded.serverInstanceId, remoteConversationId: decoded.localId };
}

export function isRemoteConversationId(id: string): boolean {
  return decodeRemoteConversationId(id) !== null;
}

/** The project key a remote workspace is grouped under. Same codec, different noun. */
export function remoteProjectKey(serverInstanceId: string, remoteWorkspaceId: string): string {
  return encodeRef(serverInstanceId, remoteWorkspaceId);
}

export function decodeRemoteProjectKey(
  key: string,
): { serverInstanceId: string; remoteWorkspaceId: string } | null {
  const decoded = decodeRef(key);
  if (!decoded) return null;
  return { serverInstanceId: decoded.serverInstanceId, remoteWorkspaceId: decoded.localId };
}

/**
 * How a bound project currently stands.
 *
 * Kept distinct on purpose, because these are four different situations with four
 * different remedies and the old design collapsed all of them into "the connection is
 * not up":
 *
 *   - `offline`      the server could not be reached — retrying may work;
 *   - `auth-required` it was reached and refused us — a credential has to change;
 *   - `incompatible` it answered, but speaks a protocol we cannot — nothing the user
 *                    can do but update;
 *   - `missing`      the server is fine and says it has no such workspace — the project
 *                    moved or was deleted over there, and the binding is now stale.
 *
 * `available` and `connecting` are the two states where the project is usable or about
 * to be. Nothing here removes a binding: a project that cannot be reached stays on
 * screen, marked, so the user can retry or unbind deliberately.
 */
export type ProjectBindingState =
  | "available"
  | "connecting"
  | "offline"
  | "auth-required"
  | "incompatible"
  | "missing";

export type ProjectBinding = {
  id: string;
  kind: "remote";
  /** What the sidebar shows. Renamed locally without touching the remote workspace. */
  name: string;
  /** The local connection profile that reaches this server. */
  connectionId: string;
  /** Stable identity of the App Server that owns the workspace. */
  serverInstanceId: string;
  /** The workspace's own identity on that server. */
  remoteWorkspaceId: string;
  /** Where it lives over there. Display and diagnostics only. */
  remotePath: string;
  createdAt: number;
  lastOpenedAt?: number;
};

/** The project key this binding is grouped under. */
export function bindingProjectKey(binding: ProjectBinding): string {
  return remoteProjectKey(binding.serverInstanceId, binding.remoteWorkspaceId);
}

/**
 * What a bound project can actually do.
 *
 * Both ends are intersected, because either can be the limit: a server with no browser
 * cannot open one, and a client without a `<webview>` cannot draw it. The UI reads this
 * to *explain* a control rather than to discover the truth by pressing it and failing.
 */
export function bindingCapabilities(
  server: readonly AppCapability[],
  client?: readonly AppCapability[] | null,
): AppCapability[] {
  const clientSet = client && client.length > 0 ? new Set<string>(client) : null;
  return server.filter((capability) => !clientSet || clientSet.has(capability));
}

export function canUseBinding(capabilities: readonly AppCapability[], capability: AppCapability): boolean {
  return capabilities.includes(capability);
}
