import { randomUUID } from "node:crypto";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
} from "@mariozechner/pi-coding-agent";
import type {
  ChatMessage,
  Conversation,
  ConversationDeleteResult,
  ConversationOpenResult,
  ConversationReadyEvent,
  FastVibeModel,
  OmpSessionState,
  OmpStatus,
  ProjectAddResult,
  ProviderConfig,
  ProviderModel,
  SessionStats,
  SlashCommand,
  SubagentInfo,
  WorkspaceSnapshot,
} from "@shared/types";
import { ConversationCatalog } from "../omp/conversation-catalog";
import { mapEngineMessages } from "../omp/map-messages";
import {
  addProvider as addProviderConfig,
  applyProviders,
  fetchProviderModels,
  listProviderConfigs,
  loadProviderKeys,
  providerKeyEnv,
  refreshProviderModels,
  removeProvider as removeProviderConfig,
  saveFastVibe as saveFastVibeConfig,
  setProviderKey,
  updateProvider as updateProviderConfig,
  usableProviders,
} from "../omp/providers";
import { getFastVibePaths, type FastVibePaths } from "../omp/paths";

type ManagedSession = { conversationId: string; cwd: string; session: AgentSession; unsubscribe: () => void };

/** Host adapter backed by pi-coding-agent. It keeps one AgentSession per conversation in one Node process. */
export class PiProcessManager {
  #paths: FastVibePaths;
  #catalog: ConversationCatalog;
  #sessions = new Map<string, ManagedSession>();
  #activeId: string | null = null;
  #status: OmpStatus = { state: "idle" };
  #cwd: string;
  #statusListeners = new Set<(status: OmpStatus) => void>();
  #eventListeners = new Set<(event: Record<string, unknown>) => void>();
  #readyListeners = new Set<(payload: ConversationReadyEvent) => void>();
  #auth: AuthStorage | null = null;
  #models: ModelRegistry | null = null;
  #modelsCache: FastVibeModel[] | null = null;
  #operation: Promise<unknown> = Promise.resolve();
  #pendingUi = new Map<string, { resolve: (value: unknown) => void; fallback: unknown }>();
  #sessionPromises = new Map<string, Promise<ManagedSession>>();
  #interruptMode: "immediate" | "wait" = "immediate";

  constructor() {
    this.#paths = getFastVibePaths();
    this.#catalog = new ConversationCatalog(this.#paths.conversationsFile, this.#paths.ompScratch);
    const active = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
    this.#cwd = active?.project ?? this.#paths.ompScratch;
  }

  listWorkspace(): WorkspaceSnapshot { return this.#catalog.snapshot(); }
  flush(): void { this.#catalog.flush(); }
  get status(): OmpStatus { return this.#status; }
  get cwd(): string { return this.#cwd; }
  onStatus(listener: (status: OmpStatus) => void): () => void { this.#statusListeners.add(listener); return () => this.#statusListeners.delete(listener); }
  onEvent(listener: (event: Record<string, unknown>) => void): () => void { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener); }
  onConversationReady(listener: (payload: ConversationReadyEvent) => void): () => void { this.#readyListeners.add(listener); return () => this.#readyListeners.delete(listener); }

  start(cwd = this.#cwd): Promise<OmpStatus> {
    return this.#queue(async () => {
      if (this.#status.state === "ready" && this.#models) return this.#status;
      this.#cwd = cwd;
      this.#setStatus({ state: "starting", cwd });
      const keys = await loadProviderKeys(this.#paths);
      const providers = usableProviders(this.#paths, keys);
      if (providers.length === 0) { this.#setStatus({ state: "needsAuth", cwd }); return this.#status; }
      const applied = applyProviders(this.#paths);
      this.#modelsCache = applied.models;
      this.#auth = AuthStorage.inMemory();
      for (const provider of providers) {
        const key = keys[provider.apiKeyEnv];
        if (key) this.#auth.set(provider.id, { type: "api_key", key });
      }
      this.#models = ModelRegistry.create(this.#auth, join(this.#paths.ompAgent, "models.json"));
      await this.#models.refresh();
      const active = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
      if (active) await this.#ensureSession(active);
      this.#setStatus({ state: "ready", cwd: this.#cwd });
      return this.#status;
    });
  }

  async stop(): Promise<void> {
    await this.#queue(async () => {
      const sessions = [...this.#sessions.values()];
      this.#sessions.clear();
      this.#sessionPromises.clear();
      for (const [id, pending] of this.#pendingUi) {
        this.#pendingUi.delete(id);
        pending.resolve(pending.fallback);
      }
      this.#activeId = null;
      await Promise.all(sessions.map(async (item) => { item.unsubscribe(); await item.session.dispose(); }));
      this.#models = null;
      this.#auth = null;
      if (this.#status.state === "ready" || this.#status.state === "starting") this.#setStatus({ state: "idle" });
    });
  }

  async prompt(message: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void> {
    const session = await this.#active();
    await session.prompt(message, options);
  }
  async steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    const session = await this.#active();
    if (this.#interruptMode === "wait" && session.isStreaming) await session.agent.waitForIdle();
    await session.steer(message, images);
  }
  async followUp(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> { await (await this.#active()).followUp(message, images); }
  async abort(): Promise<void> { await (await this.#active()).abort(); }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> { return (await this.#active()).clearQueue(); }
  async branch(entryId: string): Promise<ChatMessage[]> { await (await this.#active()).navigateTree(entryId); return this.loadMessages(); }

  async getSessionStats(): Promise<SessionStats> {
    const stats = (await this.#active()).getSessionStats();
    return { tokens: { input: stats.tokens.input, output: stats.tokens.output, total: stats.tokens.total }, cost: stats.cost, toolCalls: stats.toolCalls };
  }
  async compact(customInstructions?: string): Promise<OmpSessionState> { await (await this.#active()).compact(customInstructions); return this.getState(); }
  async getCommands(): Promise<SlashCommand[]> {
    const session = await this.#active();
    return session.promptTemplates.map((item) => ({ name: item.name, description: item.description, source: "prompt" }));
  }
  async getSubagentMessages(_subagentId: string): Promise<ChatMessage[]> { return []; }
  async getSubagents(): Promise<SubagentInfo[]> { return []; }
  respondPermission(payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean }): void {
    const pending = this.#pendingUi.get(payload.id);
    if (!pending) return;
    this.#pendingUi.delete(payload.id);
    pending.resolve(payload.cancelled ? pending.fallback : typeof payload.value === "string" ? payload.value : payload.confirmed ?? pending.fallback);
  }
  async newSession(): Promise<void> { await (await this.#active()).abort(); }

  async createConversation(project?: string): Promise<ConversationOpenResult> {
      await this.#ensureReady();
      const conversation = this.#catalog.create(project);
      const managed = await this.#ensureSession(conversation);
      this.#activate(managed);
      const state = this.#state(managed.session);
      const updated = this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
      return this.#opened(updated, [], state);
  }

  async openConversation(id: string): Promise<ConversationOpenResult> {
      const conversation = this.#catalog.get(id);
      if (!conversation) throw new Error("conversation not found");
      await this.#ensureReady();
      this.#catalog.setActive(id);
      const managed = await this.#ensureSession(conversation);
      this.#activate(managed);
      const state = this.#state(managed.session);
      const messages = mapEngineMessages(managed.session.messages);
      const updated = this.#catalog.update(id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
      return this.#opened(updated, messages, state);
  }

  renameConversation(id: string, title: string): WorkspaceSnapshot { const trimmed = title.trim(); if (trimmed) { this.#catalog.update(id, { title: trimmed }); const active = this.#sessions.get(id); if (active) active.session.setSessionName(trimmed); } return this.#catalog.snapshot(); }
  async deleteConversation(id: string): Promise<ConversationDeleteResult> { const wasActive = this.#catalog.activeId === id; const removed = this.#catalog.remove(id); if (removed?.sessionFile) await unlink(removed.sessionFile).catch(() => undefined); const managed = this.#sessions.get(id); if (managed) { managed.unsubscribe(); await managed.session.dispose(); this.#sessions.delete(id); } return { ...this.#catalog.snapshot(), nextId: wasActive ? (this.#catalog.activeId ?? null) : null }; }
  async setConversationProject(id: string, project: string | null): Promise<WorkspaceSnapshot> { this.#catalog.setProject(id, project ?? undefined); return this.#catalog.snapshot(); }
  recordPrompt(id: string, text: string): WorkspaceSnapshot { const preview = text.trim().slice(0, 80); const current = this.#catalog.get(id); const title = current?.title && current.title !== "新会话" && current.title !== "新任务" ? current.title : preview.slice(0, 24) || "新会话"; this.#catalog.update(id, { title, preview }); const active = this.#sessions.get(id); if (active) active.session.setSessionName(title); return this.#catalog.snapshot(); }
  addProject(cwd: string): ProjectAddResult { const project = this.#catalog.ensureProject(cwd); if (!project) throw new Error("invalid project"); return { ...this.#catalog.snapshot(), project }; }
  renameProject(cwd: string, name: string): WorkspaceSnapshot { this.#catalog.renameProject(cwd, name); return this.#catalog.snapshot(); }
  async removeProject(cwd: string): Promise<ConversationDeleteResult> { const wasActive = this.#catalog.get(this.#catalog.activeId ?? "")?.project === cwd; const removed = this.#catalog.removeProject(cwd); await Promise.all(removed.map(async (item) => { if (item.sessionFile) await unlink(item.sessionFile).catch(() => undefined); const managed = this.#sessions.get(item.id); if (managed) { managed.unsubscribe(); await managed.session.dispose(); this.#sessions.delete(item.id); } })); return { ...this.#catalog.snapshot(), nextId: wasActive ? (this.#catalog.activeId ?? null) : null }; }
  async loadMessages(): Promise<ChatMessage[]> { return mapEngineMessages((await this.#active()).messages); }
  async getAvailableModels(): Promise<FastVibeModel[]> { if (this.#modelsCache) return this.#modelsCache; await this.#ensureReady(); return this.#modelsCache ?? []; }
  async setModel(provider: string, modelId: string): Promise<OmpSessionState> { await this.#ensureReady(); const model = this.#models?.find(provider, modelId); if (!model) throw new Error("模型不存在"); await (await this.#active()).setModel(model); return this.getState(); }
  async setInterruptMode(mode: "immediate" | "wait"): Promise<OmpSessionState> { this.#interruptMode = mode; return this.getState(); }
  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<OmpSessionState> { (await this.#active()).setSteeringMode(mode); return this.getState(); }
  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<OmpSessionState> { (await this.#active()).setFollowUpMode(mode); return this.getState(); }
  async exportHtml(): Promise<string | undefined> { return (await this.#active()).exportToHtml(); }
  async setAutoCompaction(enabled: boolean): Promise<OmpSessionState> { (await this.#active()).setAutoCompactionEnabled(enabled); return this.getState(); }
  async setThinkingLevel(level: string): Promise<OmpSessionState> { (await this.#active()).setThinkingLevel(level as any); return this.getState(); }
  async getState(): Promise<OmpSessionState> { return this.#state(await this.#active()); }

  async listProviders(): Promise<ProviderConfig[]> { return listProviderConfigs(this.#paths, await loadProviderKeys(this.#paths)); }
  async fetchModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> { return fetchProviderModels(baseUrl, apiKey); }
  async refreshProviderModels(id: string): Promise<ProviderModel[]> { return refreshProviderModels(this.#paths, id); }
  async saveFastVibe(apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> { await saveFastVibeConfig(this.#paths, apiKey, models); await this.reloadProviders(); return this.listProviders(); }
  async addProvider(draft: { name: string; baseUrl: string; apiKey: string }, models: ProviderModel[]): Promise<ProviderConfig[]> { await addProviderConfig(this.#paths, draft, models); await this.reloadProviders(); return this.listProviders(); }
  async updateProvider(id: string, patch: { name?: string; baseUrl?: string; models?: ProviderModel[]; apiKey?: string }): Promise<ProviderConfig[]> { updateProviderConfig(this.#paths, id, { name: patch.name, baseUrl: patch.baseUrl?.trim().replace(/\/+$/, ""), models: patch.models }); if (patch.apiKey !== undefined) { const env = providerKeyEnv(this.#paths, id); if (env) await setProviderKey(this.#paths, env, patch.apiKey); } await this.reloadProviders(); return this.listProviders(); }
  async removeProvider(id: string): Promise<ProviderConfig[]> { removeProviderConfig(this.#paths, id); await this.reloadProviders(); return this.listProviders(); }
  async reloadProviders(): Promise<OmpStatus> { await this.stop(); return this.start(this.#cwd); }
  async handleExtensionUi(_event: Record<string, unknown>): Promise<void> { return; }

  async #ensureReady(): Promise<void> { if (this.#status.state !== "ready" || !this.#models) await this.start(this.#cwd); if (this.#status.state !== "ready" || !this.#models) throw new Error("engine not ready"); }
  async #active(): Promise<AgentSession> { await this.#ensureReady(); const active = this.#activeId ? this.#sessions.get(this.#activeId) : undefined; if (active) return active.session; const conversation = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined; if (!conversation) throw new Error("no active conversation"); const managed = await this.#ensureSession(conversation); this.#activate(managed); return managed.session; }
  async #ensureSession(conversation: Conversation): Promise<ManagedSession> {
    const existing = this.#sessions.get(conversation.id);
    if (existing) return existing;
    const pending = this.#sessionPromises.get(conversation.id);
    if (pending) return pending;
    if (!this.#auth || !this.#models) throw new Error("engine not ready");
    const cwd = conversation.project ?? this.#paths.ompScratch;
    const sessionDir = join(this.#paths.ompSessions, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    const sessionManager = conversation.sessionFile
      ? SessionManager.open(conversation.sessionFile, undefined, cwd)
      : SessionManager.create(cwd, sessionDir);
    const creation = this.#createSession(conversation, cwd, sessionManager);
    this.#sessionPromises.set(conversation.id, creation);
    try {
      return await creation;
    } finally {
      this.#sessionPromises.delete(conversation.id);
    }
  }
  async #createSession(conversation: Conversation, cwd: string, sessionManager: ReturnType<typeof SessionManager.create>): Promise<ManagedSession> {
    if (!this.#auth || !this.#models) throw new Error("engine not ready");
    const result = await createAgentSession({
      cwd,
      agentDir: this.#paths.ompAgent,
      authStorage: this.#auth,
      modelRegistry: this.#models,
      sessionManager,
      settingsManager: SettingsManager.create(cwd, this.#paths.ompAgent),
    });
    await result.session.bindExtensions({
      uiContext: this.#extensionUi(),
      commandContextActions: {
        waitForIdle: () => result.session.agent.waitForIdle(),
        newSession: async () => { await result.session.abort(); return { cancelled: false }; },
        fork: async () => ({ cancelled: true }),
        navigateTree: async (entryId) => {
          const navigation = await result.session.navigateTree(entryId);
          return { cancelled: navigation.cancelled };
        },
        switchSession: async () => ({ cancelled: true }),
        reload: () => result.session.reload(),
      },
      onError: (error) => this.#emit({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error }),
    });
    const managed: ManagedSession = { conversationId: conversation.id, cwd, session: result.session, unsubscribe: () => undefined };
    managed.unsubscribe = result.session.subscribe((event) => {
      if (this.#activeId !== conversation.id) return;
      this.#emit(event as unknown as Record<string, unknown>);
    });
    this.#sessions.set(conversation.id, managed);
    const payload: ConversationReadyEvent = {
      id: conversation.id,
      messages: mapEngineMessages(result.session.messages),
      state: this.#state(result.session),
      status: this.#status,
    };
    for (const listener of this.#readyListeners) listener(payload);
    return managed;
  }
  #emit(event: Record<string, unknown>): void { for (const listener of this.#eventListeners) listener(event); }
  #extensionUi(): ExtensionUIContext {
    const dialog = <T>(method: string, request: Record<string, unknown>, fallback: T, timeout?: number): Promise<T> => {
      const id = randomUUID();
      return new Promise<T>((resolve) => {
        const timer = timeout && timeout > 0 ? setTimeout(() => {
          this.#pendingUi.delete(id);
          resolve(fallback);
        }, timeout) : undefined;
        this.#pendingUi.set(id, { fallback, resolve: (value) => { if (timer) clearTimeout(timer); resolve(value as T); } });
        this.#emit({ type: "extension_ui_request", id, method, ...request });
      });
    };
    return {
      select: (title, options, opts) => dialog<string | undefined>("select", { title, options, timeout: opts?.timeout }, undefined, opts?.timeout),
      confirm: (title, message, opts) => dialog("confirm", { title, message, timeout: opts?.timeout }, false, opts?.timeout),
      input: (title, placeholder, opts) => dialog("input", { title, placeholder, timeout: opts?.timeout }, undefined, opts?.timeout),
      editor: (title, prefill) => dialog("editor", { title, prefill }, undefined),
      notify: (message, type) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "notify", message, notifyType: type }); },
      onTerminalInput: () => () => undefined,
      setStatus: (key, text) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "setStatus", statusKey: key, statusText: text }); },
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (key, content, options) => { if (content === undefined || Array.isArray(content)) this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: options?.placement }); },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: (title) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "setTitle", title }); },
      custom: async <T>() => undefined as T,
      pasteToEditor: (text) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }); },
      setEditorText: (text) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "set_editor_text", text }); },
      getEditorText: () => "",
      addAutocompleteProvider: () => undefined,
      setEditorComponent: () => undefined,
      getEditorComponent: () => undefined,
      getAllThemes: () => [],
      getTheme: () => undefined,
      setTheme: () => ({ success: false, error: "Theme switching is unavailable in the desktop host" }),
      getToolsExpanded: () => false,
      setToolsExpanded: () => undefined,
      get theme() { return undefined as never; },
    };
  }
  #activate(managed: ManagedSession): void { this.#activeId = managed.conversationId; this.#cwd = managed.cwd; this.#catalog.setActive(managed.conversationId); this.#setStatus({ state: "ready", cwd: managed.cwd }); }
  #state(session: AgentSession): OmpSessionState { const model = session.model; const usage = session.getContextUsage(); return { model: model ? { provider: model.provider, id: model.id } : undefined, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting, interruptMode: this.#interruptMode, sessionFile: session.sessionFile, sessionId: session.sessionId, sessionName: session.sessionName, messageCount: session.messages.length, queuedMessageCount: session.pendingMessageCount, autoCompactionEnabled: session.autoCompactionEnabled, steeringMode: session.steeringMode, followUpMode: session.followUpMode, contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined }; }
  #opened(conversation: Conversation, messages: ChatMessage[], state: OmpSessionState | null): ConversationOpenResult { return { ...this.#catalog.snapshot(), conversation, messages, state, status: this.#status }; }
  #setStatus(status: OmpStatus): void { this.#status = status; for (const listener of this.#statusListeners) listener(status); }
  #queue<T>(work: () => Promise<T>): Promise<T> { const next = this.#operation.then(work, work); this.#operation = next.then(() => undefined, () => undefined); return next; }
}
