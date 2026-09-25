import { useSyncExternalStore } from "react";
import { RemoteClient } from "../protocol/client";
import { parseServerAddress } from "../protocol/address";
import { patchServer, readToken, writeToken, type SavedServer } from "../storage/servers";
import { isMobileConversation, isMobileProject, isRemoteCatalogReference } from "./catalog-filter";

export type CatalogProject = { cwd: string; name: string };
export type CatalogConversation = {
  id: string;
  title: string;
  preview?: string;
  project?: string;
  createdAt: number;
  updatedAt: number;
  kind?: string;
};

export type PermissionPrompt = {
  id: string;
  conversationId?: string;
  method: string;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  questions?: Array<{ question: string; header?: string; options?: string[] }>;
  plan?: { title: string; summary: string };
};

type Status = "idle" | "connecting" | "ready" | "error";

type State = {
  status: Status;
  error: string | null;
  needsPassword: boolean;
  server: SavedServer | null;
  projects: CatalogProject[];
  conversations: CatalogConversation[];
  running: Record<string, boolean>;
  /** Wall-clock start of each current run; shared across chat screen mounts. */
  runningSince: Record<string, number>;
  waiting: Record<string, boolean>;
  pending: PermissionPrompt[];
};

const empty: State = {
  status: "idle",
  error: null,
  needsPassword: false,
  server: null,
  projects: [],
  conversations: [],
  running: {},
  runningSince: {},
  waiting: {},
  pending: [],
};

let state: State = empty;
let client: RemoteClient | null = null;
const listeners = new Set<() => void>();
const engineListeners = new Set<(event: Record<string, unknown>) => void>();

function emit(): void {
  for (const listener of listeners) listener();
}

function setState(patch: Partial<State>): void {
  state = { ...state, ...patch };
  emit();
}

export function useConnection(): State {
  return useSyncExternalStore(subscribe, getState, getState);
}

export function currentConnection(): State {
  return state;
}

export function getClient(): RemoteClient | null {
  return state.status === "ready" ? client : null;
}

export function onEngineEvent(listener: (event: Record<string, unknown>) => void): () => void {
  engineListeners.add(listener);
  return () => engineListeners.delete(listener);
}

export async function connectSaved(server: SavedServer): Promise<void> {
  const token = await readToken(server.id);
  if (!token) {
    setState({ ...empty, server, status: "error", needsPassword: true, error: "需要输入密码" });
    return;
  }
  await connectWithToken(server, token);
}

export async function loginSaved(server: SavedServer, password: string): Promise<void> {
  setState({ ...empty, server, status: "connecting", error: null, needsPassword: false });
  const remote = new RemoteClient();
  try {
    const token = await remote.login(server.origin, password, `FastVibe ${server.alias}`);
    await writeToken(server.id, token);
    await connectWithToken(server, token);
  } catch (error) {
    setState({
      ...empty,
      server,
      status: "error",
      needsPassword: true,
      error: error instanceof Error ? error.message : "登录失败",
    });
  }
}

export function disconnect(): void {
  client?.close();
  client = null;
  setState(empty);
}

export function watchConversation(id: string): () => void {
  const scope = `conversation:${id}`;
  client?.subscribe([scope]);
  return () => client?.unsubscribe([scope]);
}

export function resolvePendingPermission(id: string): void {
  const pending = state.pending.filter((item) => item.id !== id);
  const waiting: Record<string, boolean> = {};
  for (const item of pending) if (item.conversationId) waiting[item.conversationId] = true;
  setState({ ...state, pending, waiting });
}

async function connectWithToken(server: SavedServer, token: string): Promise<void> {
  const address = parseServerAddress(server.origin);
  if (!address) {
    setState({ ...empty, server, status: "error", error: "保存的地址无效" });
    return;
  }
  client?.close();
  const remote = new RemoteClient();
  client = remote;
  setState({ ...empty, server, status: "connecting", error: null });
  remote.onPush(handlePush);
  remote.onDisconnect((reason) => {
    if (client !== remote) return;
    setState({ ...state, status: "error", error: reason });
  });
  try {
    await remote.connect(address, token);
    if (client !== remote) return;
    remote.subscribe(["*"]);
    await refreshCatalog(remote);
    const servers = await patchServer(server.id, { lastConnectedAt: Date.now() });
    const updated = servers.find((item) => item.id === server.id) ?? server;
    if (client !== remote) return;
    setState({ ...state, status: "ready", server: updated, error: null, needsPassword: false });
  } catch (error) {
    if (client !== remote) return;
    const unauthorized = error instanceof Error && error.message === "UNAUTHORIZED";
    setState({
      ...empty,
      server,
      status: "error",
      needsPassword: unauthorized,
      error: unauthorized ? "登录已失效，请重新输入密码" : error instanceof Error ? error.message : "连接失败",
    });
  }
}

async function refreshCatalog(remote: RemoteClient): Promise<void> {
  const [catalog, runningIds, pendingEvents] = await Promise.all([
    remote.call("conversations:list"),
    remote.call("engine:get-running"),
    remote.call("engine:get-pending-ui"),
  ]);
  if (client !== remote) return;
  applyCatalog(catalog);
  const running: Record<string, boolean> = {};
  const runningSince: Record<string, number> = {};
  if (Array.isArray(runningIds)) {
    for (const id of runningIds) {
      if (typeof id !== "string" || isRemoteCatalogReference(id)) continue;
      running[id] = true;
      runningSince[id] = state.runningSince[id] ?? Date.now();
    }
  }
  const pending = Array.isArray(pendingEvents) ? pendingEvents.flatMap((event) => parsePermission(event) ?? []) : [];
  const waiting: Record<string, boolean> = {};
  for (const item of pending) if (item.conversationId) waiting[item.conversationId] = true;
  setState({ ...state, projects: state.projects, conversations: state.conversations, running, runningSince, waiting, pending });
}

function handlePush(channel: string, payload: unknown): void {
  if (channel === "workspace:changed") {
    applyCatalog(payload);
    return;
  }
  if (channel !== "engine:event" || !isRecord(payload)) return;
  const event = payload;
  if (
    event.type === "conversation_running" &&
    typeof event.conversationId === "string" &&
    !isRemoteCatalogReference(event.conversationId)
  ) {
    const running = { ...state.running, [event.conversationId]: event.running === true };
    const runningSince = { ...state.runningSince };
    if (event.running === true) {
      runningSince[event.conversationId] ??= Date.now();
    } else {
      delete runningSince[event.conversationId];
    }
    setState({ ...state, running, runningSince });
  }
  if (event.type === "extension_ui_request") {
    const prompt = parsePermission(event);
    if (prompt) {
      const pending = state.pending.filter((item) => item.id !== prompt.id).concat(prompt);
      const waiting = { ...state.waiting };
      if (prompt.conversationId) waiting[prompt.conversationId] = true;
      setState({ ...state, pending, waiting });
    }
  }
  if (event.type === "extension_ui_dismiss" && typeof event.id === "string") {
    const pending = state.pending.filter((item) => item.id !== event.id);
    const waiting: Record<string, boolean> = {};
    for (const item of pending) if (item.conversationId) waiting[item.conversationId] = true;
    setState({ ...state, pending, waiting });
  }
  for (const listener of engineListeners) listener(event);
}

function applyCatalog(payload: unknown): void {
  if (!isRecord(payload)) return;
  const projects = Array.isArray(payload.projects) ? payload.projects.flatMap(parseProject) : state.projects;
  const conversations = Array.isArray(payload.conversations)
    ? payload.conversations.flatMap(parseConversation)
    : state.conversations;
  setState({ ...state, projects, conversations });
}

function parseProject(value: unknown): CatalogProject[] {
  if (!isRecord(value) || typeof value.cwd !== "string" || typeof value.name !== "string" || !isMobileProject(value)) return [];
  return [{ cwd: value.cwd, name: value.name }];
}

function parseConversation(value: unknown): CatalogConversation[] {
  if (!isRecord(value) || typeof value.id !== "string" || !isMobileConversation(value)) return [];
  return [
    {
      id: value.id,
      title: typeof value.title === "string" && value.title ? value.title : "新对话",
      preview: typeof value.preview === "string" ? value.preview : undefined,
      project: typeof value.project === "string" ? value.project : undefined,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
      kind: typeof value.kind === "string" ? value.kind : undefined,
    },
  ];
}

function parsePermission(value: unknown): PermissionPrompt | null {
  if (
    !isRecord(value) ||
    value.type !== "extension_ui_request" ||
    typeof value.id !== "string" ||
    (typeof value.conversationId === "string" && isRemoteCatalogReference(value.conversationId))
  ) return null;
  const method = value.method;
  if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor" && method !== "questions" && method !== "plan_review") {
    return null;
  }
  return {
    id: value.id,
    conversationId: typeof value.conversationId === "string" ? value.conversationId : undefined,
    method,
    title: typeof value.title === "string" ? value.title : undefined,
    message: typeof value.message === "string" ? value.message : undefined,
    placeholder: typeof value.placeholder === "string" ? value.placeholder : undefined,
    options: stringList(value.options),
    questions: Array.isArray(value.questions) ? value.questions.flatMap(parseQuestion) : undefined,
    plan: isRecord(value.plan) && typeof value.plan.title === "string" && typeof value.plan.summary === "string"
      ? { title: value.plan.title, summary: value.plan.summary }
      : undefined,
  };
}

function parseQuestion(value: unknown): Array<{ question: string; header?: string; options?: string[] }> {
  if (!isRecord(value) || typeof value.question !== "string") return [];
  return [{ question: value.question, header: typeof value.header === "string" ? value.header : undefined, options: stringList(value.options) }];
}

function stringList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const items = value.filter((item): item is string => typeof item === "string");
  return items.length > 0 ? items : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function getState(): State {
  return state;
}
