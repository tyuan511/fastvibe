import { chmodSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { isValidServerInstanceId } from "../../shared/app-protocol.ts";
import { bindingProjectKey, type ProjectBinding } from "../../shared/project-binding.ts";
import { decodeScopedId } from "../../shared/server-scope.ts";

/**
 * The bound remote projects, on this machine.
 *
 * A file rather than part of the conversation catalog, because the two have different
 * owners and different lifetimes. A binding is a *reference* to something another
 * server owns; it survives restarts, a server being unreachable, and that server being
 * gone entirely — the entry stays so the user can see why and unbind deliberately. The
 * branch this replaces had no home for that idea, so a remote project existed only as
 * an entry inside the *remote* catalog, and vanished from this machine the moment the
 * tunnel did.
 */

type StoredBindings = { version: 1; bindings: ProjectBinding[]; projectOrder?: string[] };

type BindingStore = { bindings: ProjectBinding[]; projectOrder: string[] };

function readStore(file: string): BindingStore {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as Partial<StoredBindings>;
    if (parsed.version !== 1 || !Array.isArray(parsed.bindings)) return { bindings: [], projectOrder: [] };
    return {
      bindings: parsed.bindings.map(normalize).filter((item): item is ProjectBinding => item !== null),
      projectOrder: Array.isArray(parsed.projectOrder)
        ? parsed.projectOrder.filter((item): item is string => typeof item === "string" && item.trim().length > 0)
        : [],
    };
  } catch {
    return { bindings: [], projectOrder: [] };
  }
}

export function readBindings(file: string): ProjectBinding[] {
  return readStore(file).bindings;
}

/** The local sidebar order shared by local and remote project rows. */
export function readProjectOrder(file: string): string[] {
  return readStore(file).projectOrder;
}

/**
 * Add or replace one binding.
 *
 * Keyed by `(serverInstanceId, remoteWorkspaceId)` rather than by the local `id`, so
 * binding the same workspace twice — from the same connection or from a second
 * connection profile that reaches the same server — updates the existing row instead of
 * listing the project twice. The server is part of the key because two servers may
 * genuinely have a workspace with the same id.
 */
export function saveBinding(file: string, binding: ProjectBinding): ProjectBinding[] {
  const next = requireValid(binding);
  const store = readStore(file);
  const existing = store.bindings.filter(
    (item) => !(item.serverInstanceId === next.serverInstanceId && item.remoteWorkspaceId === next.remoteWorkspaceId),
  );
  existing.push(next);
  const key = projectKey(next);
  const order = store.projectOrder.length && !store.projectOrder.includes(key)
    ? [...store.projectOrder, key]
    : store.projectOrder;
  writeBindings(file, existing, order);
  return existing;
}

export function removeBinding(file: string, id: string): ProjectBinding[] {
  const store = readStore(file);
  const removed = store.bindings.find((item) => item.id === id);
  const next = store.bindings.filter((item) => item.id !== id);
  writeBindings(file, next, removed ? store.projectOrder.filter((key) => key !== projectKey(removed)) : store.projectOrder);
  return next;
}

/** Drop every binding that pointed at one connection profile. */
export function removeBindingsForConnection(file: string, connectionId: string): ProjectBinding[] {
  const store = readStore(file);
  const removed = new Set(store.bindings.filter((item) => item.connectionId === connectionId).map(projectKey));
  const next = store.bindings.filter((item) => item.connectionId !== connectionId);
  writeBindings(file, next, store.projectOrder.filter((key) => !removed.has(key)));
  return next;
}

export function renameBinding(file: string, id: string, name: string): ProjectBinding[] {
  const trimmed = name.trim();
  const store = readStore(file);
  const next = store.bindings.map((item) => (item.id === id && trimmed ? { ...item, name: trimmed } : item));
  writeBindings(file, next, store.projectOrder);
  return next;
}

/** Persist the mixed local/remote project order from the sidebar drag operation. */
export function reorderProjectOrder(file: string, keys: string[]): string[] {
  const order = [...new Set(keys.map((key) => key.trim()).filter(Boolean))];
  const store = readStore(file);
  writeBindings(file, store.bindings, order);
  return order;
}

function projectKey(binding: ProjectBinding): string {
  return bindingProjectKey(binding);
}

function requireValid(binding: ProjectBinding): ProjectBinding {
  const normalized = normalize(binding);
  if (!normalized) throw new Error("远程项目绑定无效");
  return normalized;
}

/** A workspace id stored as `remote:<server>:<path>` is the path, not a second namespace. */
function workspaceIdOnServer(value: string, serverInstanceId: string): string {
  let current = value;
  while (current) {
    const decoded = decodeScopedId(current);
    if (!decoded || decoded.serverInstanceId !== serverInstanceId) return current;
    current = decoded.localId;
  }
  return value;
}

function normalize(value: unknown): ProjectBinding | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const text = (key: string): string => (typeof record[key] === "string" ? (record[key] as string).trim() : "");
  const id = text("id");
  const connectionId = text("connectionId");
  const serverInstanceId = text("serverInstanceId");
  const remoteWorkspaceId = workspaceIdOnServer(text("remoteWorkspaceId"), serverInstanceId);
  if (!id || !connectionId || !remoteWorkspaceId) return null;
  // An instance id that could not appear inside a `remote:<server>:<local>` key would
  // produce bindings whose projects are unreachable, so it is refused at the boundary
  // rather than trusted from disk.
  if (!isValidServerInstanceId(serverInstanceId)) return null;
  return {
    id,
    kind: "remote",
    name: text("name") || remoteWorkspaceId,
    connectionId,
    serverInstanceId,
    remoteWorkspaceId,
    remotePath: workspaceIdOnServer(text("remotePath"), serverInstanceId) || remoteWorkspaceId,
    createdAt: typeof record.createdAt === "number" ? record.createdAt : Date.now(),
    ...(typeof record.lastOpenedAt === "number" ? { lastOpenedAt: record.lastOpenedAt } : {}),
  };
}

function writeBindings(file: string, bindings: ProjectBinding[], projectOrder: string[] = []): void {
  mkdirSync(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.${file.split(/[\\/]/).pop()}.tmp`);
  const payload: StoredBindings = {
    version: 1,
    bindings,
    ...(projectOrder.length ? { projectOrder } : {}),
  };
  writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, { mode: 0o600 });
  chmodSync(temporary, 0o600);
  renameSync(temporary, file);
}
