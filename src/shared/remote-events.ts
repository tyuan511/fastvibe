import { Ipc } from "./ipc.ts";
import {
  decodeRemoteConversationId,
  encodeRemoteConversationId,
} from "./project-binding.ts";
import { scopeWorkspaceId } from "./server-scope.ts";

/**
 * Turning a remote server's pushes into this machine's vocabulary.
 *
 * A connected server broadcasts `engine:event` and `workspace:changed` with *its* ids.
 * Relaying those raw would address the local catalog. Every conversation and workspace
 * id that leaves this module is therefore `remote:<server>:<id>`.
 *
 * Classification is explicit and per-channel. There is no walk of arbitrary nested
 * fields: a prompt, a tool payload, or a thinking block is never rewritten, and a
 * channel this file does not name is dropped (settings, global engine status,
 * window chrome, the remote-access pane, and anything this build has not classified).
 */

export type RemotePushKind = "catalog" | "engine" | "terminal" | "drop" | "unknown";

/**
 * What a push from a bound server *is*, for the relay.
 *
 *   - `catalog`   conversation/project lists. `activeId` is stripped: adopting it is
 *                 navigation, and a remote server's current chat is not this window's.
 *   - `engine`    per-conversation run traffic (`engine:event`).
 *   - `terminal`  `workspace:terminal-data` — the session id is namespaced and relayed.
 *   - `drop`      settings, global engine status, SSH/remote-access pane, updater,
 *                 window chrome, OAuth, browser-use — never applied to the local client.
 *   - `unknown`   a channel this build has not classified; dropped, never applied.
 */
export function classifyRemotePush(channel: string): RemotePushKind {
  if (
    channel === Ipc.settingsChanged ||
    channel === Ipc.status ||
    channel === Ipc.sshState ||
    channel === Ipc.sshStates ||
    channel === Ipc.remoteState ||
    channel === Ipc.updateState ||
    channel === Ipc.windowState ||
    channel === Ipc.providersOAuthEvent ||
    channel === Ipc.browserRequest
  ) {
    return "drop";
  }
  if (channel === Ipc.workspaceTerminalData) return "terminal";
  if (channel === Ipc.workspaceChanged || channel === Ipc.conversationReady) return "catalog";
  if (channel === Ipc.event) return "engine";
  return "unknown";
}

export function shouldRelayRemotePush(channel: string): boolean {
  const kind = classifyRemotePush(channel);
  return kind !== "drop" && kind !== "unknown";
}

/**
 * Rewrite one push from a bound server.
 *
 * `undefined` means drop — the caller must not broadcast. Unknown and drop channels
 * both come back as `undefined`. Catalog, engine and terminal channels rewrite only
 * the ids named below.
 */
export function namespaceRemotePush(channel: string, payload: unknown, serverInstanceId: string): unknown {
  const kind = classifyRemotePush(channel);
  if (kind === "drop" || kind === "unknown") return undefined;
  if (kind === "catalog") return namespaceCatalogPayload(channel, payload, serverInstanceId);
  if (kind === "terminal") return namespaceTerminalData(payload, serverInstanceId);
  return namespaceEngineEvent(payload, serverInstanceId);
}

/**
 * Whether a channel carries conversation-scoped state and so needs rewriting.
 *
 * A push that names no conversation cannot address the wrong one. Settings and the
 * global engine status are not in this set — they are dropped, not rewritten.
 */
export function isConversationPush(channel: string): boolean {
  const kind = classifyRemotePush(channel);
  return kind === "catalog" || kind === "engine";
}

/** A conversation object as the local catalog will hold it. */
export function namespaceConversationRecord(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.id === "string" && record.id) {
    record.id = namespaceConversationId(record.id, serverInstanceId);
  }
  if (typeof record.parentId === "string" && record.parentId) {
    record.parentId = namespaceConversationId(record.parentId, serverInstanceId);
  }
  if (typeof record.project === "string" && record.project) {
    record.project = namespaceWorkspace(record.project, serverInstanceId);
  }
  if (typeof record.cwd === "string" && record.cwd) {
    record.cwd = namespaceWorkspace(record.cwd, serverInstanceId);
  }
  return record;
}

/** `ConversationSnapshot` — the id only; messages and turn events stay verbatim. */
export function namespaceConversationSnapshot(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.conversationId === "string" && record.conversationId) {
    record.conversationId = namespaceConversationId(record.conversationId, serverInstanceId);
  }
  return record;
}

/**
 * A catalog snapshot (`workspace:changed`, `conversations:list`).
 *
 * `activeId` / `nextId` are removed: those are this machine's navigation, and a remote
 * server's idea of "the open chat" must not steal the local window.
 */
export function namespaceCatalogSnapshot(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (Array.isArray(record.conversations)) {
    record.conversations = record.conversations.map((item) => namespaceConversationRecord(item, serverInstanceId));
  }
  if (Array.isArray(record.projects)) {
    record.projects = record.projects.map((item) => namespaceProjectRecord(item, serverInstanceId));
  }
  delete record.activeId;
  delete record.nextId;
  return record;
}

/** Keys of a `{ [conversationId]: value }` map, e.g. a running-flag object. */
export function namespaceIdMap(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return value;
  const rewritten: Record<string, unknown> = {};
  for (const [id, item] of Object.entries(value as Record<string, unknown>)) {
    rewritten[namespaceConversationId(id, serverInstanceId)] = item;
  }
  return rewritten;
}

/**
 * `engine:get-running` returns `string[]` of conversation ids, not a map.
 */
export function namespaceIdList(value: unknown, serverInstanceId: string): unknown {
  if (!Array.isArray(value)) return value;
  return value.map((item) => (typeof item === "string" && item ? namespaceConversationId(item, serverInstanceId) : item));
}

function namespaceCatalogPayload(channel: string, payload: unknown, serverInstanceId: string): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  if (channel === Ipc.workspaceChanged) return namespaceCatalogSnapshot(payload, serverInstanceId);

  // `conversations:ready`: the conversation is `id`, not a nested catalog.
  const record = { ...(payload as Record<string, unknown>) };
  if (typeof record.id === "string" && record.id) {
    record.id = namespaceConversationId(record.id, serverInstanceId);
  }
  if (typeof record.conversation === "object" && record.conversation !== null) {
    record.conversation = namespaceConversationRecord(record.conversation, serverInstanceId);
  }
  if (typeof record.conversationId === "string" && record.conversationId) {
    record.conversationId = namespaceConversationId(record.conversationId, serverInstanceId);
  }
  if (typeof record.state === "object" && record.state !== null) {
    record.state = namespaceSessionState(record.state, serverInstanceId);
  }
  return record;
}

function namespaceEngineEvent(payload: unknown, serverInstanceId: string): unknown {
  if (typeof payload !== "object" || payload === null) return payload;
  const record = payload as Record<string, unknown>;
  // Creating a chat on the remote server is a navigation over there. Relaying
  // `conversation_opened` would run the local client's applyOpen/navigate path.
  if (record.type === "conversation_opened") return undefined;

  const next = { ...record };
  if (typeof next.conversationId === "string" && next.conversationId) {
    next.conversationId = namespaceConversationId(next.conversationId, serverInstanceId);
  }
  if (typeof next.snapshot === "object" && next.snapshot !== null) {
    next.snapshot = namespaceCatalogSnapshot(next.snapshot, serverInstanceId);
  }
  // Permission prompts are answered by `id` alone. Two servers can mint the same
  // UUID, so the request id is namespaced with the same codec as a conversation id
  // and unscoped on the way back. Nested tool payloads (toolCallId, index) are
  // not walked — those stay conversation-routed.
  if (
    (next.type === "extension_ui_request" || next.type === "extension_ui_dismiss")
    && typeof next.id === "string"
    && next.id
  ) {
    next.id = namespaceConversationId(next.id, serverInstanceId);
  }
  return next;
}

function namespaceSessionState(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.conversationId === "string" && record.conversationId) {
    record.conversationId = namespaceConversationId(record.conversationId, serverInstanceId);
  }
  if (typeof record.cwd === "string" && record.cwd) {
    record.cwd = namespaceWorkspace(record.cwd, serverInstanceId);
  }
  return record;
}

function namespaceTerminalData(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.id === "string" && record.id) {
    record.id = namespaceConversationId(record.id, serverInstanceId);
  }
  return record;
}

function namespaceProjectRecord(value: unknown, serverInstanceId: string): unknown {
  if (typeof value !== "object" || value === null) return value;
  const record = { ...(value as Record<string, unknown>) };
  if (typeof record.cwd === "string" && record.cwd) {
    record.cwd = namespaceWorkspace(record.cwd, serverInstanceId);
  }
  return record;
}

function namespaceConversationId(value: string, serverInstanceId: string): string {
  if (decodeRemoteConversationId(value)) return value;
  return encodeRemoteConversationId(serverInstanceId, value);
}

function namespaceWorkspace(value: string, serverInstanceId: string): string {
  return scopeWorkspaceId(serverInstanceId, value);
}
