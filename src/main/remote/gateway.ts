import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { AppCapability } from "../../shared/app-protocol.ts";
import type { AgentConfigSnapshot, AgentConfigSyncPayload } from "../../shared/agent-config.ts";
import { Ipc } from "../../shared/ipc.ts";
import {
  bindingCapabilities,
  bindingProjectKey,
  decodeRemoteProjectKey,
  type ProjectBinding,
  type ProjectBindingState,
} from "../../shared/project-binding.ts";
import type { RemoteConnectionStatus } from "../../shared/remote-connection.ts";
import {
  namespaceCatalogSnapshot,
  namespaceConversationRecord,
  namespaceIdList,
  namespaceRemotePush,
  shouldRelayRemotePush,
} from "../../shared/remote-events.ts";
import type { RemoteHostProfile } from "../../shared/remote-host.ts";
import {
  decodeScopedId,
  resolveServerScope,
  scopeId,
  unscopePayload,
} from "../../shared/server-scope.ts";
import type { Conversation, Project, RemoteWorkspace, WorkspaceSnapshot } from "../../shared/types.ts";
import { readBindings, readProjectOrder, removeBinding, renameBinding, reorderProjectOrder, saveBinding } from "./binding-store.ts";

/**
 * Project-binding gateway: one local catalog plus many remote references.
 *
 * A bound project is a row this machine owns; the workspace, transcripts and tools
 * live on the App Server. Calls are routed from top-level namespaced ids, never from
 * a global "connected host". Remote catalog traffic is merged in, never applied as
 * a replacement snapshot — that would wipe the local list.
 */

export type ConnectedServerRef = {
  connectionId: string;
  serverInstanceId: string;
  capabilities: AppCapability[];
  /** Present for SSH transports; gates desktop → Agent config replication. */
  configSyncToken?: string;
};

/**
 * The connection manager's surface, structural so a test (and a non-SSH transport)
 * can inject a map of servers without loading the live manager.
 */
export type GatewayConnections = {
  connect(profile: RemoteHostProfile): Promise<ConnectedServerRef>;
  statuses(): RemoteConnectionStatus[];
  call(server: ConnectedServerRef, method: string, payload: unknown): Promise<unknown>;
  serverForInstance(serverInstanceId: string): ConnectedServerRef | undefined;
  listWorkspaces(server: ConnectedServerRef): Promise<RemoteWorkspace[]>;
};

export type GatewayDeps = {
  localDispatch: (method: string, payload: unknown, ctx: unknown) => Promise<unknown>;
  localSnapshot: () => WorkspaceSnapshot;
  /** Read the desktop engine configuration; sent over the SSH App Protocol on connect. */
  localAgentConfig: () => AgentConfigSnapshot;
  connections: GatewayConnections;
  bindingsFile: string;
  profiles: () => RemoteHostProfile[];
  broadcast: (channel: string, payload: unknown) => void;
};

/** Optional fields on a bound row. `Project` is not extended yet; intersection keeps the catalog type intact. */
export type AggregatedProject = Project & {
  kind?: "remote";
  bindingId?: string;
  bindingState?: ProjectBindingState;
  capabilities?: AppCapability[];
  connectionId?: string;
  serverInstanceId?: string;
  remotePath?: string;
};

export type AggregatedSnapshot = WorkspaceSnapshot & {
  projects: AggregatedProject[];
};

export type AddRemotePayload = {
  cwd?: string;
  hostId?: string;
  serverInstanceId?: string;
  workspaceId?: string;
  name?: string;
};

const OPEN_METHODS: ReadonlySet<string> = new Set([
  Ipc.conversationsOpen,
  Ipc.conversationsCreate,
  Ipc.conversationsCreateSide,
  Ipc.engineFork,
]);
const STATE_METHODS: ReadonlySet<string> = new Set([
  Ipc.engineGetState,
  Ipc.engineSetModel,
  Ipc.engineSetThinking,
  Ipc.engineSetInterrupt,
  Ipc.engineSetAutoCompact,
  Ipc.engineSetSteering,
  Ipc.engineSetFollowUp,
  Ipc.engineCompact,
]);
// These writes belong to this desktop's configuration. After the local write succeeds,
// the same snapshot is sent to every live SSH Agent so a remote conversation never
// silently falls back to that host's empty providers.json. The payload contains secrets
// by design and is accepted only with the per-SSH token established during bootstrap.
const CONFIG_SYNC_METHODS: ReadonlySet<string> = new Set([
  Ipc.settingsSet,
  Ipc.settingsClear,
  Ipc.providersAdd,
  Ipc.providersAddNative,
  Ipc.providersCcSwitchImport,
  Ipc.providersLogout,
  Ipc.providersRefresh,
  Ipc.providersRemove,
  Ipc.providersSaveFastVibe,
  Ipc.providersUpdate,
  Ipc.providersOAuthLogin,
  Ipc.engineSaveMcpServers,
  Ipc.engineSaveAgentConfig,
  Ipc.engineRemoveAgentConfig,
  Ipc.modelsDevUpdate,
]);
export function shouldSyncAgentConfig(method: string): boolean {
  return CONFIG_SYNC_METHODS.has(method);
}

const CATALOG_RESULT_METHODS: ReadonlySet<string> = new Set([
  Ipc.conversationsRename,
  Ipc.conversationsDelete,
  Ipc.conversationsRecordPrompt,
  Ipc.conversationsSetProject,
  Ipc.projectsAdd,
  Ipc.projectsRename,
  Ipc.projectsRemove,
  Ipc.projectsReorder,
]);

export class RemoteGateway {
  #deps: GatewayDeps;
  /** Namespaced conversations, keyed by the server that owns them. */
  #remoteConversations = new Map<string, Conversation[]>();
  /** Unscoped workspace ids last seen on a server, for `missing`. */
  #remoteWorkspaces = new Map<string, Set<string>>();
  /** One configuration write at a time per server, so provider edits cannot cross. */
  #configSyncs = new Map<string, Promise<void>>();
  #configConnections = new Map<string, string>();

  constructor(deps: GatewayDeps) {
    this.#deps = deps;
  }

  /**
   * Warm bound servers at launch, without opening a conversation or blocking the UI.
   * Only bindings opt a host in; saved/discovered SSH hosts alone are not a request
   * to connect. Each server is attempted once and failures are independent.
   */
  async restoreBoundServers(): Promise<Array<{ serverInstanceId: string; error: string }>> {
    const servers = [...new Set(readBindings(this.#deps.bindingsFile).map((binding) => binding.serverInstanceId))];
    const outcomes = await Promise.allSettled(servers.map((id) => this.refreshServer(id)));
    return outcomes.flatMap((outcome, index) => outcome.status === "rejected"
      ? [{ serverInstanceId: servers[index], error: outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason) }]
      : []);
  }

  /**
   * Route one call. Local methods stay on this machine; a namespaced top-level id
   * is sent to that server after a lazy reconnect and an identity check.
   *
   * Extra fields the renderer may add for routing (`conversationId` on a permission
   * answer or a subagent abort) are unscoped with the rest of the payload. Handlers
   * that do not declare them ignore them.
   */
  async dispatch(method: string, payload: unknown, ctx: unknown): Promise<unknown> {
    if (method === Ipc.projectsAddRemote) return this.#addRemote(payload, ctx);
    if (method === Ipc.projectsRename) return this.#renameProject(payload, ctx);
    if (method === Ipc.projectsRemove) return this.#removeProject(payload, ctx);
    if (method === Ipc.projectsReorder) return this.#reorderProjects(payload, ctx);
    if (method === Ipc.conversationsSetProject) return this.#setConversationProject(payload, ctx);
    if (method === Ipc.conversationsList) return this.aggregate(this.#deps.localSnapshot());

    const scope = resolveServerScope(payload);
    if (!scope) {
      const result = await this.#deps.localDispatch(method, payload, ctx);
      if (shouldSyncAgentConfig(method)) void this.#syncConnectedServers();
      return this.#overlayLocalResult(result);
    }

    const server = await this.#ensureServer(scope.serverInstanceId);
    const result = await this.#deps.connections.call(
      server,
      method,
      unscopePayload(payload, scope.serverInstanceId),
    );
    return this.#scopeResult(method, result, scope.serverInstanceId);
  }

  /**
   * A push from a bound server.
   *
   * When `server` is omitted the payload is already namespaced: the server half is
   * read off the rows. Pass `alreadyNamespaced` (or call `acceptNamespacedRemotePush`)
   * when the parent has rewritten the payload *and* can name the server — an empty
   * catalog has no rows to derive from, and namespacing twice would double-prefix.
   *
   * A remote `workspace:changed` is folded into the cache and the *aggregated*
   * snapshot is what gets broadcast — never the remote catalog alone. An engine
   * event that carries `.snapshot` is merged the same way before it is relayed,
   * because the renderer applies that object as the catalog.
   */
  acceptRemotePush(channel: string, payload: unknown, server?: string, alreadyNamespaced = false): void {
    if (!shouldRelayRemotePush(channel)) return;
    if (channel === Ipc.event && isRecord(payload) && payload.type === "conversation_opened") return;

    const serverId = typeof server === "string" && server ? server : undefined;
    let next = payload;
    if (serverId && !alreadyNamespaced) {
      next = namespaceRemotePush(channel, payload, serverId);
      if (next === undefined) return;
    }

    if (channel === Ipc.workspaceChanged) {
      const source = serverId ?? deriveServerFromRows(next);
      if (source) this.#ingestCatalog(next, source);
      this.publishLocalSnapshot(this.#deps.localSnapshot());
      return;
    }

    if (channel === Ipc.event && isRecord(next) && next.snapshot != null) {
      const source = serverId ?? deriveServerFromRows(next.snapshot) ?? deriveServerFromRows(next);
      if (source) this.#ingestCatalog(next.snapshot, source);
      next = { ...next, snapshot: this.aggregate(this.#deps.localSnapshot()) };
    }

    this.#deps.broadcast(channel, next);
  }

  /**
   * Relay a push that is already in this machine's ids, with an explicit server
   * source. Empty remote catalogs have nothing to derive a server from.
   */
  acceptNamespacedRemotePush(channel: string, payload: unknown, serverId: string): void {
    this.acceptRemotePush(channel, payload, serverId, true);
  }

  /**
   * Re-read one server's catalog and republish the merge.
   *
   * Index should call this after a connect so bindings that were `offline` pick up
   * the live workspace list. A failed fetch is thrown, not swallowed: the binding
   * stays on disk either way.
   */
  async refreshServer(serverInstanceId: string): Promise<void> {
    const server = await this.#ensureServer(serverInstanceId);
    await this.#refreshServerCatalog(server);
    this.publishLocalSnapshot(this.#deps.localSnapshot());
  }

  /** Local + every binding, with remote conversations limited to bound workspace keys. */
  aggregate(localSnapshot: WorkspaceSnapshot): AggregatedSnapshot {
    const bindings = readBindings(this.#deps.bindingsFile);
    const boundKeys = boundWorkspaceKeys(bindings);
    const baseProjects: AggregatedProject[] = [
      ...localSnapshot.projects,
      ...bindings.map((binding) => this.#projectFromBinding(binding)),
    ];
    const projects = orderProjects(baseProjects, readProjectOrder(this.#deps.bindingsFile));
    const remoteConversations: Conversation[] = [];
    for (const binding of bindings) {
      const key = bindingProjectKey(binding);
      const cached = this.#remoteConversations.get(binding.serverInstanceId) ?? [];
      for (const conversation of cached) {
        const workspace = conversation.project ?? conversation.cwd;
        if (workspace === key && boundKeys.has(workspace)) remoteConversations.push(conversation);
      }
    }
    return {
      projects,
      conversations: [...localSnapshot.conversations, ...remoteConversations],
      activeId: localSnapshot.activeId,
    };
  }

  /** Local events carrying a catalog must preserve the bound remote rows too. */
  publishLocalEvent(event: Record<string, unknown>): void {
    const next = isRecord(event.snapshot)
      ? { ...event, snapshot: this.aggregate(this.#deps.localSnapshot()) }
      : event;
    this.#deps.broadcast(Ipc.event, next);
  }

  /** Re-broadcast the merged catalog. Local `activeId` wins; a remote snapshot cannot steal it. */
  publishLocalSnapshot(localSnapshot: WorkspaceSnapshot): void {
    this.#deps.broadcast(Ipc.workspaceChanged, this.aggregate(localSnapshot));
  }

  async #addRemote(payload: unknown, ctx: unknown): Promise<unknown> {
    const record = isRecord(payload) ? (payload as AddRemotePayload) : {};
    const cwd = typeof record.cwd === "string" ? record.cwd.trim() : "";
    if (!cwd) throw new Error("远程项目目录不能为空");

    const decodedKey = decodeRemoteProjectKey(cwd);
    const decodedRef = decodedKey ?? decodeScopedId(cwd);
    const decodedLocal = decodedKey?.remoteWorkspaceId ?? decodeScopedId(cwd)?.localId;
    const hostId = typeof record.hostId === "string" ? record.hostId.trim() : "";
    const namedServer = typeof record.serverInstanceId === "string" ? record.serverInstanceId.trim() : "";
    const isRemote = Boolean(hostId || namedServer || decodedRef);
    // Gateway is wired for every App Server caller. A payload with no remote ref is
    // not "add this path to the local catalog" — that is the headless handler's job,
    // and falling through would register a remote filesystem path as a local project.
    if (!isRemote) throw new Error("绑定远程项目需要主机或服务器标识");
    void ctx;

    const workspaceId = (typeof record.workspaceId === "string" && record.workspaceId.trim())
      || decodedLocal
      || cwd;
    const remotePath = decodedLocal || cwd;
    const expectedServer = namedServer || decodedRef?.serverInstanceId || "";
    const profile = this.#profileFor(hostId, expectedServer);
    if (!profile) throw new Error("找不到远程主机配置");

    const server = await this.#deps.connections.connect(profile);
    if (expectedServer && server.serverInstanceId !== expectedServer) {
      throw mismatchError(expectedServer, server.serverInstanceId);
    }
    if (!server.connectionId) throw new Error("找不到远程主机配置");

    await this.#syncConfig(server, true);
    await this.#deps.connections.call(server, Ipc.projectsAddRemote, { cwd: remotePath });
    const catalog = await this.#fetchServerCatalog(server);

    const binding: ProjectBinding = {
      id: newBindingId(),
      kind: "remote",
      name: (typeof record.name === "string" && record.name.trim()) || basename(remotePath) || workspaceId,
      connectionId: server.connectionId,
      serverInstanceId: server.serverInstanceId,
      remoteWorkspaceId: workspaceId,
      remotePath,
      createdAt: Date.now(),
    };
    saveBinding(this.#deps.bindingsFile, binding);
    const existingOrder = readProjectOrder(this.#deps.bindingsFile);
    const bindingKey = bindingProjectKey(binding);
    const fallbackOrder = [
      ...this.#deps.localSnapshot().projects.map((item) => item.cwd),
      ...readBindings(this.#deps.bindingsFile)
        .filter((item) => bindingProjectKey(item) !== bindingKey)
        .map((item) => bindingProjectKey(item)),
    ];
    reorderProjectOrder(
      this.#deps.bindingsFile,
      [bindingKey, ...(existingOrder.length ? existingOrder : fallbackOrder).filter((key) => key !== bindingKey)],
    );
    this.#ingestCatalog(catalog, server.serverInstanceId);
    const known = this.#remoteWorkspaces.get(server.serverInstanceId) ?? new Set<string>();
    known.add(binding.remoteWorkspaceId);
    this.#remoteWorkspaces.set(server.serverInstanceId, known);

    const snapshot = this.aggregate(this.#deps.localSnapshot());
    this.#deps.broadcast(Ipc.workspaceChanged, snapshot);
    const project = snapshot.projects.find((item) => item.cwd === bindingProjectKey(binding));
    return { ...snapshot, project };
  }

  async #renameProject(payload: unknown, ctx: unknown): Promise<unknown> {
    const record = isRecord(payload) ? payload : {};
    const cwd = typeof record.cwd === "string" ? record.cwd : "";
    const name = typeof record.name === "string" ? record.name : "";
    const decoded = decodeRemoteProjectKey(cwd);
    if (decoded) {
      const binding = this.#bindingForProjectKey(cwd);
      if (!binding) throw new Error("未绑定的远程项目");
      renameBinding(this.#deps.bindingsFile, binding.id, name);
      const snapshot = this.aggregate(this.#deps.localSnapshot());
      this.#deps.broadcast(Ipc.workspaceChanged, snapshot);
      return snapshot;
    }
    return this.#overlayLocalResult(await this.#deps.localDispatch(Ipc.projectsRename, payload, ctx));
  }

  async #removeProject(payload: unknown, ctx: unknown): Promise<unknown> {
    const record = isRecord(payload) ? payload : {};
    const cwd = typeof record.cwd === "string" ? record.cwd : "";
    const decoded = decodeRemoteProjectKey(cwd);
    if (decoded) {
      const binding = this.#bindingForProjectKey(cwd);
      if (!binding) throw new Error("未绑定的远程项目");
      // Unbind only. The remote workspace is not deleted.
      removeBinding(this.#deps.bindingsFile, binding.id);
      this.#dropBoundConversations(binding);
      const snapshot = this.aggregate(this.#deps.localSnapshot());
      this.#deps.broadcast(Ipc.workspaceChanged, snapshot);
      return { ...snapshot, nextId: snapshot.activeId ?? null };
    }
    return this.#overlayLocalResult(await this.#deps.localDispatch(Ipc.projectsRemove, payload, ctx));
  }

  /**
   * Mixed local+remote reorder. The order is local UI state: local projects still
   * keep their catalog order, while this store records the complete mixed sequence so
   * a reload cannot move remote rows back below every local row.
   */
  async #reorderProjects(payload: unknown, ctx: unknown): Promise<unknown> {
    const record = isRecord(payload) ? payload : {};
    const cwds = Array.isArray(record.cwds) ? record.cwds.filter((item): item is string => typeof item === "string") : [];
    if (cwds.some((cwd) => decodeRemoteProjectKey(cwd))) {
      const localCwds = cwds.filter((cwd) => !decodeRemoteProjectKey(cwd));
      if (localCwds.length > 0) {
        await this.#deps.localDispatch(Ipc.projectsReorder, { cwds: localCwds }, ctx);
      }
      reorderProjectOrder(this.#deps.bindingsFile, cwds);
      const snapshot = this.aggregate(this.#deps.localSnapshot());
      this.#deps.broadcast(Ipc.workspaceChanged, snapshot);
      return snapshot;
    }
    // Keep the mixed-order file in sync for a local-only catalog too. A previous
    // remote binding may have left `projectOrder` populated after the binding was
    // removed; if it is not refreshed here, `aggregate()` applies that stale order
    // over the catalog's freshly reordered local projects and the row snaps back.
    const localResult = await this.#deps.localDispatch(Ipc.projectsReorder, payload, ctx);
    if (cwds.length > 0) reorderProjectOrder(this.#deps.bindingsFile, cwds);
    const result = this.#overlayLocalResult(localResult);
    return result;
  }

  async #setConversationProject(payload: unknown, ctx: unknown): Promise<unknown> {
    this.#assertSetProjectScope(payload);
    const scope = resolveServerScope(payload);
    if (!scope) {
      return this.#overlayLocalResult(await this.#deps.localDispatch(Ipc.conversationsSetProject, payload, ctx));
    }
    const server = await this.#ensureServer(scope.serverInstanceId);
    const result = await this.#deps.connections.call(
      server,
      Ipc.conversationsSetProject,
      unscopePayload(payload, scope.serverInstanceId),
    );
    return this.#scopeResult(Ipc.conversationsSetProject, result, scope.serverInstanceId);
  }

  #assertSetProjectScope(payload: unknown): void {
    if (!isRecord(payload)) return;
    const id = typeof payload.id === "string" ? payload.id : "";
    const project = payload.project;
    if (typeof project !== "string" || !project) return;
    const idRef = decodeScopedId(id);
    const projectRef = decodeScopedId(project);
    if (Boolean(idRef) !== Boolean(projectRef)) {
      throw new Error("不能把会话移到另一台服务器的项目");
    }
  }

  async #ensureServer(serverInstanceId: string): Promise<ConnectedServerRef> {
    const live = this.#deps.connections.serverForInstance(serverInstanceId);
    if (live) {
      if (live.serverInstanceId !== serverInstanceId) throw mismatchError(serverInstanceId, live.serverInstanceId);
      await this.#syncConfig(live);
      return live;
    }
    const profile = this.#profileFor("", serverInstanceId);
    if (!profile) throw new Error(`远程项目所在的 App Server 不在线：${serverInstanceId}`);
    const server = await this.#deps.connections.connect(profile);
    if (server.serverInstanceId !== serverInstanceId) {
      throw mismatchError(serverInstanceId, server.serverInstanceId);
    }
    await this.#syncConfig(server, true);
    await this.#refreshServerCatalog(server);
    return server;
  }

  /** Push the latest desktop configuration to every currently connected Agent. */
  async syncConfiguration(): Promise<void> {
    await this.#syncConnectedServers();
  }

  async #syncConnectedServers(): Promise<void> {
    const statuses = this.#deps.connections.statuses();
    await Promise.all(statuses.filter((status) => status.state === "ready" && status.serverInstanceId).map(async (status) => {
      const server = this.#deps.connections.serverForInstance(status.serverInstanceId!);
      if (server) await this.#syncConfig(server, true).catch(() => undefined);
    }));
  }

  async #syncConfig(server: ConnectedServerRef, force = false): Promise<void> {
    const current = this.#configConnections.get(server.serverInstanceId);
    if (!force && current === server.connectionId && !this.#configSyncs.has(server.serverInstanceId)) return;
    const previous = this.#configSyncs.get(server.serverInstanceId) ?? Promise.resolve();
    const next = previous.catch(() => undefined).then(async () => {
      const already = this.#configConnections.get(server.serverInstanceId);
      if (!force && already === server.connectionId) return;
      const config = this.#deps.localAgentConfig();
      if (Object.keys(config).length === 0 || !server.configSyncToken) return;
      const syncPayload: AgentConfigSyncPayload = { ...config, syncToken: server.configSyncToken };
      await this.#deps.connections.call(server, Ipc.engineSyncConfig, syncPayload);
      this.#configConnections.set(server.serverInstanceId, server.connectionId);
    });
    this.#configSyncs.set(server.serverInstanceId, next);
    try {
      await next;
    } finally {
      if (this.#configSyncs.get(server.serverInstanceId) === next) this.#configSyncs.delete(server.serverInstanceId);
    }
  }

  async #fetchServerCatalog(server: ConnectedServerRef): Promise<unknown> {
    const list = await this.#deps.connections.call(server, Ipc.conversationsList, undefined);
    return namespaceCatalogSnapshot(list, server.serverInstanceId);
  }

  async #refreshServerCatalog(server: ConnectedServerRef): Promise<void> {
    this.#ingestCatalog(await this.#fetchServerCatalog(server), server.serverInstanceId);
  }

  #ingestCatalog(payload: unknown, serverInstanceId: string): void {
    if (!isRecord(payload)) return;
    const boundKeys = boundWorkspaceKeys(
      readBindings(this.#deps.bindingsFile).filter((item) => item.serverInstanceId === serverInstanceId),
    );
    const conversations = Array.isArray(payload.conversations)
      ? payload.conversations.filter((item): item is Conversation => {
          if (!isRecord(item) || typeof item.id !== "string") return false;
          const workspace = (typeof item.project === "string" && item.project) || (typeof item.cwd === "string" ? item.cwd : "");
          return Boolean(workspace) && boundKeys.has(workspace);
        }) as Conversation[]
      : [];
    this.#remoteConversations.set(serverInstanceId, conversations);

    const workspaceIds = new Set<string>();
    if (Array.isArray(payload.projects)) {
      for (const item of payload.projects) {
        if (!isRecord(item) || typeof item.cwd !== "string") continue;
        const decoded = decodeRemoteProjectKey(item.cwd);
        workspaceIds.add(decoded?.remoteWorkspaceId ?? item.cwd);
      }
    }
    for (const conversation of conversations) {
      const workspace = conversation.project ?? conversation.cwd;
      const decoded = decodeRemoteProjectKey(workspace);
      if (decoded) workspaceIds.add(decoded.remoteWorkspaceId);
    }
    this.#remoteWorkspaces.set(serverInstanceId, workspaceIds);
  }

  #rememberConversation(conversation: unknown, serverInstanceId: string): void {
    if (!isRecord(conversation) || typeof conversation.id !== "string") return;
    const workspace = (typeof conversation.project === "string" && conversation.project)
      || (typeof conversation.cwd === "string" ? conversation.cwd : "");
    if (!workspace) return;
    const boundKeys = boundWorkspaceKeys(
      readBindings(this.#deps.bindingsFile).filter((item) => item.serverInstanceId === serverInstanceId),
    );
    if (!boundKeys.has(workspace)) return;
    const cached = this.#remoteConversations.get(serverInstanceId) ?? [];
    if (cached.some((item) => item.id === conversation.id)) return;
    this.#remoteConversations.set(serverInstanceId, [...cached, conversation as Conversation]);
  }

  #scopeResult(method: string, result: unknown, serverInstanceId: string): unknown {
    if (result == null) return result;
    if (OPEN_METHODS.has(method)) return this.#scopeOpenResult(result, serverInstanceId);
    if (method === Ipc.engineGetSnapshot) return scopeSnapshot(result, serverInstanceId);
    if (STATE_METHODS.has(method)) return scopeSessionState(result, serverInstanceId);
    if (method === Ipc.workspaceTerminalStart) return scopeTerminal(result, serverInstanceId);
    if (method === Ipc.workspacePreview) return scopePreview(result, serverInstanceId);
    if (method === Ipc.workspaceReadDir) return scopeReadDir(result, serverInstanceId);
    if (method === Ipc.engineGetRunning) return namespaceIdList(result, serverInstanceId);
    if (method === Ipc.engineGetSubagents) return scopeSubagents(result, serverInstanceId);
    if (CATALOG_RESULT_METHODS.has(method)) {
      if (isRecord(result) && Array.isArray(result.conversations)) {
        this.#ingestCatalog(namespaceCatalogSnapshot(result, serverInstanceId), serverInstanceId);
      }
      const snapshot = this.aggregate(this.#deps.localSnapshot());
      const nextId = isRecord(result) && typeof result.nextId === "string" && result.nextId
        ? scopeId(result.nextId, serverInstanceId)
        : snapshot.activeId ?? null;
      return { ...result, ...snapshot, ...(isRecord(result) && "nextId" in result ? { nextId } : {}) };
    }
    // Unknown methods: do not walk nested ids (message ids, toolCallId, index stay verbatim).
    return result;
  }

  #scopeOpenResult(result: unknown, serverInstanceId: string): unknown {
    if (!isRecord(result)) return result;
    this.#ingestCatalog(namespaceCatalogSnapshot(result, serverInstanceId), serverInstanceId);
    const conversation = namespaceConversationRecord(result.conversation, serverInstanceId);
    this.#rememberConversation(conversation, serverInstanceId);
    const state = scopeSessionState(result.state, serverInstanceId);
    const snapshot = this.aggregate(this.#deps.localSnapshot());
    const openedId = isRecord(conversation) && typeof conversation.id === "string" ? conversation.id : undefined;
    const conversations = openedId && !snapshot.conversations.some((item) => item.id === openedId) && isRecord(conversation)
      ? [...snapshot.conversations, conversation as Conversation]
      : snapshot.conversations;
    return {
      ...result,
      ...snapshot,
      conversations,
      activeId: openedId ?? snapshot.activeId,
      conversation,
      messages: result.messages,
      state,
    };
  }

  #overlayLocalResult(result: unknown): unknown {
    if (!isRecord(result) || !Array.isArray(result.projects) || !Array.isArray(result.conversations)) {
      return result;
    }
    const aggregated = this.aggregate({
      projects: result.projects as Project[],
      conversations: result.conversations as Conversation[],
      activeId: typeof result.activeId === "string" ? result.activeId : undefined,
    });
    return {
      ...result,
      projects: aggregated.projects,
      conversations: aggregated.conversations,
      activeId: result.activeId ?? aggregated.activeId,
    };
  }

  #projectFromBinding(binding: ProjectBinding): AggregatedProject {
    const status = this.#statusFor(binding);
    const state = this.#bindingState(binding, status);
    const capabilities = status?.state === "ready"
      ? bindingCapabilities(status.capabilities)
      : undefined;
    return {
      cwd: bindingProjectKey(binding),
      name: binding.name,
      createdAt: binding.createdAt,
      updatedAt: binding.lastOpenedAt ?? binding.createdAt,
      kind: "remote",
      bindingId: binding.id,
      bindingState: state,
      connectionId: binding.connectionId,
      serverInstanceId: binding.serverInstanceId,
      remotePath: binding.remotePath,
      ...(capabilities ? { capabilities } : {}),
    };
  }

  #bindingState(binding: ProjectBinding, status: RemoteConnectionStatus | undefined): ProjectBindingState {
    if (!status) return "offline";
    if (status.state === "connecting") return "connecting";
    if (status.state === "incompatible") return "incompatible";
    if (status.state === "ready") {
      if (status.serverInstanceId && status.serverInstanceId !== binding.serverInstanceId) return "incompatible";
      const known = this.#remoteWorkspaces.get(binding.serverInstanceId);
      if (known && !known.has(binding.remoteWorkspaceId)) return "missing";
      return "available";
    }
    if (status.state === "error" && isAuthError(status.error)) return "auth-required";
    return "offline";
  }

  #statusFor(binding: ProjectBinding): RemoteConnectionStatus | undefined {
    const statuses = this.#deps.connections.statuses();
    return (
      statuses.find((item) => item.serverInstanceId === binding.serverInstanceId)
      ?? statuses.find((item) => item.connectionId === binding.connectionId)
    );
  }

  #bindingForProjectKey(cwd: string): ProjectBinding | undefined {
    const decoded = decodeRemoteProjectKey(cwd);
    if (!decoded) return undefined;
    return readBindings(this.#deps.bindingsFile).find(
      (item) => item.serverInstanceId === decoded.serverInstanceId && item.remoteWorkspaceId === decoded.remoteWorkspaceId,
    );
  }

  #profileFor(hostId: string, serverInstanceId: string): RemoteHostProfile | undefined {
    const profiles = this.#deps.profiles();
    if (hostId) {
      const match = profiles.find((item) => item.id === hostId);
      if (match) return match;
    }
    if (serverInstanceId) {
      const binding = readBindings(this.#deps.bindingsFile).find((item) => item.serverInstanceId === serverInstanceId);
      if (binding) {
        const match = profiles.find((item) => item.id === binding.connectionId);
        if (match) return match;
      }
    }
    return undefined;
  }

  #dropBoundConversations(binding: ProjectBinding): void {
    const key = bindingProjectKey(binding);
    const cached = this.#remoteConversations.get(binding.serverInstanceId);
    if (!cached) return;
    this.#remoteConversations.set(
      binding.serverInstanceId,
      cached.filter((item) => (item.project ?? item.cwd) !== key),
    );
  }
}

function scopeSubagents(result: unknown, serverInstanceId: string): unknown {
  if (!Array.isArray(result)) return result;
  return result.map((item) => {
    if (!isRecord(item) || typeof item.conversationId !== "string" || !item.conversationId) return item;
    return { ...item, conversationId: scopeId(item.conversationId, serverInstanceId) };
  });
}

function scopeSnapshot(result: unknown, serverInstanceId: string): unknown {
  if (!isRecord(result)) return result;
  const next: Record<string, unknown> = { ...result };
  if (typeof next.conversationId === "string" && next.conversationId) {
    next.conversationId = scopeId(next.conversationId, serverInstanceId);
  }
  if (Array.isArray(next.pendingUi)) {
    next.pendingUi = next.pendingUi.map((item) => scopeUiItem(item, serverInstanceId));
  }
  if (Array.isArray(next.turnEvents)) {
    next.turnEvents = next.turnEvents.map((item) => scopeUiItem(item, serverInstanceId));
  }
  return next;
}

function scopeSessionState(result: unknown, serverInstanceId: string): unknown {
  if (!isRecord(result)) return result;
  const next: Record<string, unknown> = { ...result };
  if (typeof next.conversationId === "string" && next.conversationId) {
    next.conversationId = scopeId(next.conversationId, serverInstanceId);
  }
  if (typeof next.cwd === "string" && next.cwd) {
    next.cwd = scopeId(next.cwd, serverInstanceId);
  }
  return next;
}

function scopeTerminal(result: unknown, serverInstanceId: string): unknown {
  if (!isRecord(result)) return result;
  const next: Record<string, unknown> = { ...result };
  if (typeof next.id === "string" && next.id) next.id = scopeId(next.id, serverInstanceId);
  if (typeof next.cwd === "string" && next.cwd) next.cwd = scopeId(next.cwd, serverInstanceId);
  return next;
}

function scopePreview(result: unknown, serverInstanceId: string): unknown {
  if (!isRecord(result)) return result;
  const next: Record<string, unknown> = { ...result };
  if (typeof next.path === "string" && next.path) next.path = scopeId(next.path, serverInstanceId);
  return next;
}

function scopeReadDir(result: unknown, serverInstanceId: string): unknown {
  if (!Array.isArray(result)) return result;
  return result.map((item) => {
    if (!isRecord(item) || typeof item.path !== "string" || !item.path) return item;
    return { ...item, path: scopeId(item.path, serverInstanceId) };
  });
}

function scopeUiItem(value: unknown, serverInstanceId: string): unknown {
  if (!isRecord(value)) return value;
  const next: Record<string, unknown> = { ...value };
  if (typeof next.conversationId === "string" && next.conversationId) {
    next.conversationId = scopeId(next.conversationId, serverInstanceId);
  }
  if (
    (next.type === "extension_ui_request" || next.type === "extension_ui_dismiss")
    && typeof next.id === "string"
    && next.id
  ) {
    next.id = scopeId(next.id, serverInstanceId);
  }
  return next;
}

function deriveServerFromRows(payload: unknown): string | null {
  if (!isRecord(payload)) return null;
  const direct = decodeScopedId(payload.conversationId) ?? decodeScopedId(payload.id);
  if (direct) return direct.serverInstanceId;
  for (const key of ["conversations", "projects"] as const) {
    const rows = payload[key];
    if (!Array.isArray(rows)) continue;
    for (const row of rows) {
      if (!isRecord(row)) continue;
      const decoded = decodeScopedId(row.id) ?? decodeScopedId(row.cwd) ?? decodeScopedId(row.project);
      if (decoded) return decoded.serverInstanceId;
    }
  }
  return null;
}

function boundWorkspaceKeys(bindings: ProjectBinding[]): Set<string> {
  return new Set(bindings.map((item) => bindingProjectKey(item)));
}

/** Apply the local sidebar order without making activity or remote state reorder rows. */
function orderProjects(projects: AggregatedProject[], order: string[]): AggregatedProject[] {
  if (order.length === 0) return projects;
  const rank = new Map<string, number>();
  order.forEach((key, index) => rank.set(key, index));
  const ranked = projects.filter((project) => rank.has(project.cwd)).sort((a, b) => rank.get(a.cwd)! - rank.get(b.cwd)!);
  const unranked = projects.filter((project) => !rank.has(project.cwd));
  return unranked.length ? [...unranked, ...ranked] : ranked;
}

function newBindingId(): string {
  return `bind_${randomUUID()}`;
}

function mismatchError(expected: string, actual: string): Error {
  return new Error(`远程服务器身份不匹配：期望 ${expected}，实际 ${actual}`);
}

function isAuthError(error: string | undefined): boolean {
  if (!error) return false;
  return /鉴权|auth|token|password/i.test(error);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
