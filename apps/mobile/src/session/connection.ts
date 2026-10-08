import { useSyncExternalStore } from "react";
import { AppState, type AppStateStatus } from "react-native";
import Constants from "expo-constants";
import * as Network from "expo-network";
import { ConnectionError, RemoteClient } from "../protocol/client";
import { recordConnectionDiagnostic } from "../protocol/diagnostics";
import { t } from "../i18n";
import { parseServerAddress } from "../protocol/address";
import { patchServer, readToken, writeToken, type SavedServer } from "../storage/servers";
import { isMobileConversation, isMobileProject } from "./catalog-filter";

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

export type BlockingPrompt = {
  id: string;
  conversationId?: string;
  method: string;
  title?: string;
  message?: string;
  placeholder?: string;
  options?: string[];
  questions?: Array<{ question: string; header?: string; options?: string[] }>;
};

type Status = "idle" | "connecting" | "ready" | "error";

type State = {
  status: Status;
  error: string | null;
  needsPassword: boolean;
  server: SavedServer | null;
  projects: CatalogProject[];
  conversations: CatalogConversation[];
  archivedIds: string[];
  /** The socket dropped and a replacement is being negotiated; the last snapshot stays on screen. */
  reconnecting: boolean;
  running: Record<string, boolean>;
  /** Wall-clock start of each current run; shared across chat screen mounts. */
  runningSince: Record<string, number>;
  waiting: Record<string, boolean>;
  pending: BlockingPrompt[];
};

const empty: State = {
  status: "idle",
  error: null,
  needsPassword: false,
  server: null,
  projects: [],
  conversations: [],
  archivedIds: [],
  reconnecting: false,
  running: {},
  runningSince: {},
  waiting: {},
  pending: [],
};

let state: State = empty;
let client: RemoteClient | null = null;
let reconnecting = false;

type ConnectionTarget = { server: SavedServer; token: string };

/** The saved target survives a dropped socket so the native app can reconnect by itself. */
let target: ConnectionTarget | null = null;
let connectionGeneration = 0;
let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
let reconnectAttempt = 0;
/** Includes catalog restore, so foreground/network events cannot open overlapping sockets. */
let opening: RemoteClient | null = null;
let network: Network.NetworkState | null = null;
const RECONNECT_BASE_MS = 300;
const RECONNECT_MAX_MS = 10_000;

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
  return state.status === "ready" && !reconnecting ? client : null;
}

/** Keep the phone list in step with a settings write made by this very socket. */
export function setArchivedIds(ids: string[]): void {
  setState({ archivedIds: ids });
}

/** Re-read the catalog, run and prompt state — the list's pull-to-refresh. */
export async function refreshConnection(): Promise<void> {
  const remote = getClient();
  if (!remote) {
    if (target) scheduleReconnect(target, connectionGeneration, true);
    return;
  }
  await refreshCatalog(remote);
}

export function onEngineEvent(listener: (event: Record<string, unknown>) => void): () => void {
  engineListeners.add(listener);
  return () => engineListeners.delete(listener);
}

export async function connectSaved(server: SavedServer): Promise<void> {
  let token: string | null;
  try {
    token = await readToken(server.id);
  } catch (error) {
    abandonConnection();
    setState({
      ...empty,
      server,
      status: "error",
      error: error instanceof Error ? error.message : t("conn.failed"),
    });
    return;
  }
  if (!token) {
    abandonConnection();
    setState({ ...empty, server, status: "error", needsPassword: true, error: t("conn.needPassword") });
    return;
  }
  const next = beginTarget(server, token);
  await connectWithToken(next, ++connectionGeneration, false);
}

export async function loginSaved(server: SavedServer, password: string): Promise<void> {
  abandonConnection();
  setState({ ...empty, server, status: "connecting", error: null, needsPassword: false });
  const remote = new RemoteClient();
  try {
    const token = await remote.login(server.origin, password, `FastVibe ${server.alias}`);
    await writeToken(server.id, token);
    const next = beginTarget(server, token);
    await connectWithToken(next, ++connectionGeneration, false);
  } catch (error) {
    setState({
      ...empty,
      server,
      status: "error",
      needsPassword: true,
      error: error instanceof Error ? error.message : t("conn.loginFailed"),
    });
  }
}

export function disconnect(): void {
  abandonConnection();
  setState(empty);
}

/** Ask the current saved target to reconnect immediately instead of waiting for backoff. */
export function reconnectNow(): void {
  if (!target || !reconnecting) return;
  clearReconnectTimer();
  scheduleReconnect(target, connectionGeneration, true);
}

export function watchConversation(id: string): () => void {
  const scope = `conversation:${id}`;
  client?.subscribe([scope]);
  return () => client?.unsubscribe([scope]);
}

export function resolvePendingPrompt(id: string): void {
  const pending = state.pending.filter((item) => item.id !== id);
  const waiting: Record<string, boolean> = {};
  for (const item of pending) if (item.conversationId) waiting[item.conversationId] = true;
  setState({ ...state, pending, waiting });
}

async function connectWithToken(next: ConnectionTarget, generation: number, silent: boolean): Promise<void> {
  const { server, token } = next;
  if (!isCurrentTarget(next, generation) || opening) return;
  clearReconnectTimer();
  reconnecting = silent;
  const address = parseServerAddress(server.origin);
  if (!address) {
    abandonConnection();
    setState({ ...empty, server, status: "error", error: t("conn.badAddress") });
    return;
  }
  retireClient();
  const remote = new RemoteClient(Constants.expoConfig?.version ?? "0.0.0");
  opening = remote;
  client = remote;
  remote.setActive(appIsActive());
  const started = Date.now();
  recordConnectionDiagnostic({ event: "connecting", serverId: server.id, attempt: reconnectAttempt });
  if (!silent) setState({ ...empty, server, status: "connecting", error: null });
  remote.onPush(handlePush);
  remote.onDisconnect((detail) => {
    if (client !== remote || !isCurrentTarget(next, generation)) return;
    recordConnectionDiagnostic({ event: "disconnected", serverId: server.id, detail, elapsedMs: Date.now() - started });
    const restoring = opening === remote;
    client = null;
    if (opening === remote) opening = null;
    remote.onPush(null);
    remote.onDisconnect(null);
    if (detail.code === 4001) {
      abandonConnection();
      setState({ ...empty, server, status: "error", error: t("conn.expired"), needsPassword: true });
      return;
    }
    reconnecting = true;
    // Keep the current catalog and conversation on screen while the replacement
    // socket is negotiated. A dropped mobile socket is expected during backgrounding
    // and a visible error page makes a short Wi-Fi blip feel like a logout.
    setState({ ...state, status: "ready", reconnecting: true, error: null, needsPassword: false });
    scheduleReconnect(next, generation, !restoring);
  });
  try {
    await remote.connect(address, token);
    if (!isCurrentTarget(next, generation) || client !== remote) return;
    remote.subscribe(["*"]);
    await refreshCatalog(remote);
    if (!isCurrentTarget(next, generation) || client !== remote) return;
    const servers = await patchServer(server.id, { lastConnectedAt: Date.now() });
    const updated = servers.find((item) => item.id === server.id) ?? server;
    if (!isCurrentTarget(next, generation) || client !== remote) return;
    reconnectAttempt = 0;
    reconnecting = false;
    recordConnectionDiagnostic({ event: "connected", serverId: server.id, elapsedMs: Date.now() - started });
    setState({ ...state, status: "ready", reconnecting: false, server: updated, error: null, needsPassword: false });
  } catch (error) {
    if (!isCurrentTarget(next, generation) || client !== remote) return;
    recordConnectionDiagnostic({ event: "connect-failed", serverId: server.id, elapsedMs: Date.now() - started,
      failure: error instanceof ConnectionError ? error.code : "restore-failed",
      detail: error instanceof ConnectionError ? error.detail : undefined });
    const unauthorized = error instanceof ConnectionError && (error.code === "unauthorized" || error.detail?.code === 4001);
    if (client === remote) {
      client = null;
      retireClient(remote);
    }
    if (unauthorized || !silent) reconnecting = false;
    if (unauthorized) {
      target = null;
      connectionGeneration += 1;
      clearReconnectTimer();
    }
    if (unauthorized || !silent) {
      setState({
        ...empty,
        server,
        status: "error",
        needsPassword: unauthorized,
        error: unauthorized ? t("conn.expired") : error instanceof Error ? error.message : t("conn.failed"),
      });
    } else {
      // Auto-reconnect failures stay invisible; retain the last usable snapshot and
      // keep trying with backoff instead of flashing the connection error screen.
      setState({ ...state, status: "ready", reconnecting: true, server, error: null, needsPassword: false });
    }
    if (!unauthorized) scheduleReconnect(next, generation);
  } finally {
    if (opening === remote) opening = null;
  }
}

function beginTarget(server: SavedServer, token: string): ConnectionTarget {
  retireClient();
  clearReconnectTimer();
  reconnectAttempt = 0;
  const next = { server, token };
  target = next;
  return next;
}

function isCurrentTarget(next: ConnectionTarget, generation: number): boolean {
  return target === next && connectionGeneration === generation;
}

function abandonConnection(): void {
  reconnecting = false;
  target = null;
  connectionGeneration += 1;
  reconnectAttempt = 0;
  clearReconnectTimer();
  retireClient();
}

function retireClient(value = client): void {
  if (!value) return;
  value.onDisconnect(null);
  value.onPush(null);
  value.close();
  if (opening === value) opening = null;
  if (client === value) client = null;
}

function clearReconnectTimer(): void {
  if (reconnectTimer) clearTimeout(reconnectTimer);
  reconnectTimer = null;
}

function appIsActive(): boolean {
  return AppState.currentState === "active" || AppState.currentState == null;
}

function scheduleReconnect(next: ConnectionTarget, generation: number, immediate = false): void {
  if (!isCurrentTarget(next, generation) || !appIsActive()) return;
  // Only a definite absence of a network pauses retries. Internet reachability says
  // nothing about a saved LAN server, and UNKNOWN must never lock that server out.
  if (network?.type === Network.NetworkStateType.NONE && network.isConnected === false) return;
  if (immediate) clearReconnectTimer();
  if (reconnectTimer) return;
  const delay = immediate ? 0 : Math.min(RECONNECT_BASE_MS * 2 ** reconnectAttempt, RECONNECT_MAX_MS);
  reconnectAttempt += 1;
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (!appIsActive() || !isCurrentTarget(next, generation)) return;
    void connectWithToken(next, generation, true);
  }, delay);
}

function handleAppStateChange(nextState: AppStateStatus): void {
  recordConnectionDiagnostic({ event: "app-state", appState: nextState });
  client?.setActive(nextState === "active");
  if (nextState !== "active") {
    clearReconnectTimer();
    return;
  }
  wakeConnection();
  refreshNetworkState();
}

function wakeConnection(): void {
  if (!target || !appIsActive()) return;
  if (getClient()) client?.checkHealth();
  else if (!opening) scheduleReconnect(target, connectionGeneration, true);
}

function handleNetworkChange(next: Network.NetworkState): void {
  const previous = network;
  network = next;
  if (previous?.type === next.type && previous?.isConnected === next.isConnected &&
      previous?.isInternetReachable === next.isInternetReachable) return;
  recordConnectionDiagnostic({ event: "network", networkType: next.type, connected: next.isConnected });
  if (next.type === Network.NetworkStateType.NONE && next.isConnected === false) {
    clearReconnectTimer();
    return;
  }
  reconnectAttempt = 0;
  wakeConnection();
}

function refreshNetworkState(): void {
  const previous = network;
  void Network.getNetworkStateAsync().then((next) => {
    // An event arriving during this read is newer than its result.
    if (network === previous) handleNetworkChange(next);
  }).catch(() => { /* Probing the actual server remains available if OS state is unknown. */ });
}

AppState.addEventListener("change", handleAppStateChange);
Network.addNetworkStateListener(handleNetworkChange);
refreshNetworkState();

async function refreshCatalog(remote: RemoteClient): Promise<void> {
  const [catalog, runningIds, pendingEvents, settings] = await Promise.all([
    remote.call("conversations:list"),
    remote.call("engine:get-running"),
    remote.call("engine:get-pending-ui"),
    remote.call("settings:get"),
  ]);
  if (client !== remote) return;
  applyCatalog(catalog);
  const running: Record<string, boolean> = {};
  const runningSince: Record<string, number> = {};
  if (Array.isArray(runningIds)) {
    for (const id of runningIds) {
      if (typeof id !== "string") continue;
      running[id] = true;
      runningSince[id] = state.runningSince[id] ?? Date.now();
    }
  }
  const pending = Array.isArray(pendingEvents) ? pendingEvents.flatMap((event) => parseBlockingPrompt(event) ?? []) : [];
  const waiting: Record<string, boolean> = {};
  for (const item of pending) if (item.conversationId) waiting[item.conversationId] = true;
  setState({ ...state, projects: state.projects, conversations: state.conversations, archivedIds: archivedIdsFrom(settings), running, runningSince, waiting, pending });
}

function handlePush(channel: string, payload: unknown): void {
  if (channel === "settings:changed") {
    setState({ archivedIds: archivedIdsFrom(payload) });
    return;
  }
  if (channel === "workspace:changed") {
    applyCatalog(payload);
    return;
  }
  if (channel !== "engine:event" || !isRecord(payload)) return;
  const event = payload;
  if (
    event.type === "conversation_running" &&
    typeof event.conversationId === "string"
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
    const prompt = parseBlockingPrompt(event);
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
  for (const listener of engineListeners) {
    try {
      listener(event);
    } catch {
      // One screen's reducer must not prevent other subscribers from receiving a push.
    }
  }
}

function archivedIdsFrom(value: unknown): string[] {
  if (!isRecord(value) || !Array.isArray(value.archivedConversations)) return [];
  return value.archivedConversations.filter((id): id is string => typeof id === "string");
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
      title: typeof value.title === "string" && value.title ? value.title : t("conn.untitled"),
      preview: typeof value.preview === "string" ? value.preview : undefined,
      project: typeof value.project === "string" ? value.project : undefined,
      createdAt: typeof value.createdAt === "number" ? value.createdAt : 0,
      updatedAt: typeof value.updatedAt === "number" ? value.updatedAt : 0,
      kind: typeof value.kind === "string" ? value.kind : undefined,
    },
  ];
}

function parseBlockingPrompt(value: unknown): BlockingPrompt | null {
  if (
    !isRecord(value) ||
    value.type !== "extension_ui_request" ||
    typeof value.id !== "string"
  ) return null;
  const method = value.method;
  if (method !== "confirm" && method !== "select" && method !== "input" && method !== "editor" && method !== "questions") {
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
