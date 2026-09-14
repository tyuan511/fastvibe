import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  AuthStorage,
  createAgentSession,
  ModelRegistry,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type ExtensionUIContext,
  type LoadExtensionsResult,
} from "@mariozechner/pi-coding-agent";
import type {
  ChatMessage,
  Conversation,
  ConversationDeleteResult,
  ConversationOpenResult,
  ConversationReadyEvent,
  ExtensionInfo,
  FastVibeModel,
  EngineSessionState,
  EngineStatus,
  ProjectAddResult,
  ProviderConfig,
  ProviderModel,
  SessionStats,
  SkillDraft,
  SkillInfo,
  SlashCommand,
  SubagentInfo,
  WorkspaceSnapshot,
  MultiRunRequest,
  MultiRunResult,
  NativeProviderConfig,
} from "@shared/types";
import { ConversationCatalog } from "../engine/conversation-catalog";
import { mapEngineMessages } from "../engine/map-messages";
import {
  addNativeProvider as addNativeProviderConfig,
  addProvider as addProviderConfig,
  applyProviders,
  fetchProviderModels,
  listProviderConfigs,
  loadProviderKeys,
  nativeProviderCatalog,
  providerKeyEnv,
  refreshProviderModels,
  removeProvider as removeProviderConfig,
  saveFastVibe as saveFastVibeConfig,
  setProviderKey,
  updateProvider as updateProviderConfig,
  usableProviders,
} from "../engine/providers";
import { getFastVibePaths, type FastVibePaths } from "../engine/paths";
import { McpManager, type McpServerConfig, type McpServerStatus } from "./mcp-manager";
import { SkillManager } from "./skill-manager";

type ManagedSession = { conversationId: string; cwd: string; session: AgentSession; extensions: LoadExtensionsResult; unsubscribe: () => void };
const execFileAsync = promisify(execFile);

/** Host adapter backed by pi-coding-agent. It keeps one AgentSession per conversation in one Node process. */
export class PiProcessManager {
  #paths: FastVibePaths;
  #catalog: ConversationCatalog;
  #sessions = new Map<string, ManagedSession>();
  #activeId: string | null = null;
  #status: EngineStatus = { state: "idle" };
  #cwd: string;
  #statusListeners = new Set<(status: EngineStatus) => void>();
  #eventListeners = new Set<(event: Record<string, unknown>) => void>();
  #readyListeners = new Set<(payload: ConversationReadyEvent) => void>();
  #auth: AuthStorage | null = null;
  #models: ModelRegistry | null = null;
  #modelsCache: FastVibeModel[] | null = null;
  #operation: Promise<unknown> = Promise.resolve();
  #pendingUi = new Map<string, { resolve: (value: unknown) => void; fallback: unknown }>();
  #sessionPromises = new Map<string, Promise<ManagedSession>>();
  #interruptMode: "immediate" | "wait" = "immediate";
  #mcp: McpManager;
  #skills: SkillManager;

  constructor() {
    this.#paths = getFastVibePaths();
    this.#catalog = new ConversationCatalog(this.#paths.conversationsFile, this.#paths.scratchDir);
    this.#mcp = new McpManager(this.#paths.mcpFile);
    this.#skills = new SkillManager(this.#paths.agentDir, this.#paths.skillsDir);
    const active = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
    this.#cwd = active?.project ?? this.#paths.scratchDir;
  }

  listWorkspace(): WorkspaceSnapshot { return this.#catalog.snapshot(); }
  flush(): void { this.#catalog.flush(); }
  get status(): EngineStatus { return this.#status; }
  get cwd(): string { return this.#cwd; }
  onStatus(listener: (status: EngineStatus) => void): () => void { this.#statusListeners.add(listener); return () => this.#statusListeners.delete(listener); }
  onEvent(listener: (event: Record<string, unknown>) => void): () => void { this.#eventListeners.add(listener); return () => this.#eventListeners.delete(listener); }
  onConversationReady(listener: (payload: ConversationReadyEvent) => void): () => void { this.#readyListeners.add(listener); return () => this.#readyListeners.delete(listener); }

  start(cwd = this.#cwd): Promise<EngineStatus> {
    return this.#queue(async () => {
      if (this.#status.state === "ready" && this.#models) return this.#status;
      this.#cwd = cwd;
      this.#setStatus({ state: "starting", cwd });
      await Promise.all(
        this.#catalog.takeSideChats().map((item) =>
          item.sessionFile ? unlink(item.sessionFile).catch(() => undefined) : Promise.resolve(),
        ),
      );
      const keys = await loadProviderKeys(this.#paths);
      const providers = usableProviders(this.#paths, keys);
      if (providers.length === 0) { this.#setStatus({ state: "needsAuth", cwd }); return this.#status; }
      const applied = applyProviders(this.#paths);
      this.#modelsCache = applied;
      this.#auth = AuthStorage.inMemory();
      for (const provider of providers) {
        const key = keys[provider.apiKeyEnv];
        if (key) this.#auth.set(provider.id, { type: "api_key", key });
      }
      this.#models = ModelRegistry.create(this.#auth, join(this.#paths.agentDir, "models.json"));
      await this.#models.refresh();
      await this.#mcp.load();
      await this.#mcp.connectAll();
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
      await this.#mcp.close();
      if (this.#status.state === "ready" || this.#status.state === "starting") this.#setStatus({ state: "idle" });
    });
  }

  async prompt(message: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void> {
    const session = await this.#active();
    await session.prompt(message, options);
  }

  async promptConversation(id: string, message: string): Promise<void> {
    const conversation = this.#catalog.get(id);
    if (!conversation) throw new Error("conversation not found");
    await this.#ensureReady();
    const managed = await this.#ensureSession(conversation);
    await managed.session.prompt(message);
  }

  async getConversationMessages(id: string): Promise<ChatMessage[]> {
    const managed = this.#sessions.get(id);
    if (managed) return mapEngineMessages(managed.session.messages);
    const conversation = this.#catalog.get(id);
    if (!conversation) return [];
    await this.#ensureReady();
    const created = await this.#ensureSession(conversation);
    return mapEngineMessages(created.session.messages);
  }

  async createSideConversation(project?: string, parentId?: string, title?: string): Promise<ConversationOpenResult> {
    await this.#ensureReady();
    if (!parentId) throw new Error("辅助对话必须绑定主会话");
    const parent = this.#catalog.get(parentId);
    if (!parent || parent.kind === "side-chat") throw new Error("主会话不存在");
    const previous = this.#activeId;
    const conversation = this.#catalog.create(parent.project, { cwd: parent.cwd }, {
      activate: false,
      kind: "side-chat",
      parentId,
      title: title?.trim() || "辅助对话",
    });
    const managed = await this.#ensureSession(conversation);
    if (previous) {
      const prior = this.#sessions.get(previous);
      if (prior) this.#activate(prior);
      else this.#catalog.setActive(previous);
    }
    const state = this.#state(managed.session);
    const updated =
      this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
    return this.#opened(updated, [], state);
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
  async compact(customInstructions?: string): Promise<EngineSessionState> { await (await this.#active()).compact(customInstructions); return this.getState(); }
  async getCommands(): Promise<SlashCommand[]> {
    const session = await this.#active();
    const managed = this.#sessions.get(this.#activeId ?? "");
    const promptCommands = session.promptTemplates.map((item) => ({ name: item.name, description: item.description, source: "prompt" }));
    const extensionCommands = managed?.extensions.extensions.flatMap((extension) => [...extension.commands.values()].map((command) => ({ name: command.name, description: command.description, source: "extension" }))) ?? [];
    const unique = new Map<string, SlashCommand>();
    for (const command of [...promptCommands, ...extensionCommands]) unique.set(command.name, command);
    return [...unique.values()];
  }
  async getExtensions(): Promise<ExtensionInfo[]> {
    await this.#ensureReady();
    const managed = this.#sessions.get(this.#activeId ?? "");
    if (!managed) return [];
    const loaded = managed.extensions.extensions.map((extension) => ({
      path: extension.path,
      name: extension.sourceInfo?.source ?? extension.path.split(/[\\/]/).pop() ?? extension.path,
      commands: extension.commands.size,
      tools: extension.tools.size,
    }));
    const errors = managed.extensions.errors.map((error) => ({ path: error.path, name: error.path.split(/[\\/]/).pop() ?? error.path, commands: 0, tools: 0, error: error.error }));
    return [...loaded, ...errors];
  }
  async listMcpServers(): Promise<McpServerStatus[]> { await this.#mcp.load(); return this.#mcp.list(); }
  async saveMcpServers(configs: McpServerConfig[]): Promise<McpServerStatus[]> { await this.#mcp.save(configs); if (this.#status.state === "ready") { await this.stop(); await this.start(this.#cwd); } return this.#mcp.list(); }
  async listSkills(): Promise<SkillInfo[]> { return this.#skills.list(this.#cwd); }
  async createSkill(draft: SkillDraft): Promise<SkillInfo[]> { const skills = await this.#skills.create(this.#cwd, draft); await this.#reloadSkills(); return skills; }
  async importSkill(sourceDir: string): Promise<SkillInfo[]> { const skills = await this.#skills.importFrom(this.#cwd, sourceDir); await this.#reloadSkills(); return skills; }
  async removeSkill(name: string): Promise<SkillInfo[]> { const skills = await this.#skills.remove(this.#cwd, name); await this.#reloadSkills(); return skills; }
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
      const stale = this.#catalog.list().filter((item) => !item.preview);
      for (const item of stale) await this.deleteConversation(item.id);
      const conversation = this.#catalog.create(project);
      const managed = await this.#ensureSession(conversation);
      this.#activate(managed);
      const state = this.#state(managed.session);
      const updated = this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
      return this.#opened(updated, [], state);
  }

  async multiRun(request: MultiRunRequest): Promise<MultiRunResult> {
    await this.#ensureReady();
    const prompt = request.prompt.trim();
    const models = request.models.slice(0, 5);
    if (!prompt || models.length === 0) throw new Error("并行运行需要提示词和至少一个模型");
    const previous = this.#catalog.activeId;
    const conversationIds: string[] = [];
    await Promise.all(models.map(async (selection, index) => {
      const model = this.#models?.find(selection.provider, selection.modelId);
      if (!model) throw new Error(`模型不存在: ${selection.provider}/${selection.modelId}`);
      const conversation = this.#catalog.create(request.project);
      if (request.isolate && request.project) {
        const workspace = await this.#createWorktree(request.project, conversation.id, request.name ?? model.id);
        this.#catalog.update(conversation.id, { cwd: workspace.path, worktree: workspace });
      }
      const managed = await this.#ensureSession(this.#catalog.get(conversation.id)!);
      await managed.session.setModel(model);
      const suffix = models.length > 1 ? ` · ${model.id}` : "";
      const title = request.name?.trim() ? `${request.name.trim()}${suffix}` : `并行运行 ${index + 1}${suffix}`;
      this.#catalog.update(conversation.id, { title, preview: prompt.slice(0, 80) });
      conversationIds.push(conversation.id);
      await managed.session.prompt(prompt);
    }));
    if (previous && this.#catalog.get(previous)) this.#catalog.setActive(previous);
    else if (conversationIds[0]) this.#catalog.setActive(conversationIds[0]);
    return { ...this.#catalog.snapshot(), conversationIds };
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
  async deleteConversation(id: string): Promise<ConversationDeleteResult> {
    const children = this.#catalog.listAll().filter((item) => item.parentId === id && item.kind === "side-chat");
    for (const child of children) await this.deleteConversation(child.id);
    const wasActive = this.#catalog.activeId === id;
    const removed = this.#catalog.remove(id);
    if (removed?.sessionFile) await unlink(removed.sessionFile).catch(() => undefined);
    if (removed?.worktree) await this.#removeWorktree(removed.worktree.path);
    const managed = this.#sessions.get(id);
    if (managed) {
      managed.unsubscribe();
      await managed.session.dispose();
      this.#sessions.delete(id);
    }
    return { ...this.#catalog.snapshot(), nextId: wasActive ? (this.#catalog.activeId ?? null) : null };
  }
  async setConversationProject(id: string, project: string | null): Promise<WorkspaceSnapshot> {
    const before = this.#catalog.get(id);
    const updated = this.#catalog.setProject(id, project ?? undefined);
    if (!updated || before?.cwd === updated.cwd) return this.#catalog.snapshot();
    if (before?.worktree) await this.#removeWorktree(before.worktree.path);
    const managed = this.#sessions.get(id);
    if (managed) {
      managed.unsubscribe();
      await managed.session.dispose();
      this.#sessions.delete(id);
    }
    if (this.#activeId === id) {
      await this.#ensureReady();
      const reopened = await this.#ensureSession(updated);
      this.#activate(reopened);
    }
    return this.#catalog.snapshot();
  }
  recordPrompt(id: string, text: string): WorkspaceSnapshot { const preview = text.trim().slice(0, 80); const current = this.#catalog.get(id); const title = current?.title && current.title !== "新会话" && current.title !== "新任务" ? current.title : preview.slice(0, 24) || "新会话"; this.#catalog.update(id, { title, preview }); const active = this.#sessions.get(id); if (active) active.session.setSessionName(title); return this.#catalog.snapshot(); }
  addProject(cwd: string): ProjectAddResult { const project = this.#catalog.ensureProject(cwd); if (!project) throw new Error("invalid project"); return { ...this.#catalog.snapshot(), project }; }
  renameProject(cwd: string, name: string): WorkspaceSnapshot { this.#catalog.renameProject(cwd, name); return this.#catalog.snapshot(); }
  async removeProject(cwd: string): Promise<ConversationDeleteResult> { const wasActive = this.#catalog.get(this.#catalog.activeId ?? "")?.project === cwd; const removed = this.#catalog.removeProject(cwd); await Promise.all(removed.map(async (item) => { if (item.sessionFile) await unlink(item.sessionFile).catch(() => undefined); if (item.worktree) await this.#removeWorktree(item.worktree.path); const managed = this.#sessions.get(item.id); if (managed) { managed.unsubscribe(); await managed.session.dispose(); this.#sessions.delete(item.id); } })); return { ...this.#catalog.snapshot(), nextId: wasActive ? (this.#catalog.activeId ?? null) : null }; }
  async loadMessages(): Promise<ChatMessage[]> { return mapEngineMessages((await this.#active()).messages); }
  /**
   * An unconfigured engine legitimately has zero models, so report that rather than
   * throwing "engine not ready" at the composer's model menu.
   */
  async getAvailableModels(): Promise<FastVibeModel[]> {
    if (this.#modelsCache) return this.#modelsCache;
    if (this.#status.state === "needsAuth") return [];
    await this.#ensureReady();
    return this.#modelsCache ?? [];
  }
  async setModel(provider: string, modelId: string): Promise<EngineSessionState> { await this.#ensureReady(); const model = this.#models?.find(provider, modelId); if (!model) throw new Error("模型不存在"); await (await this.#active()).setModel(model); return this.getState(); }
  async setInterruptMode(mode: "immediate" | "wait"): Promise<EngineSessionState> { this.#interruptMode = mode; return this.getState(); }
  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<EngineSessionState> { (await this.#active()).setSteeringMode(mode); return this.getState(); }
  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<EngineSessionState> { (await this.#active()).setFollowUpMode(mode); return this.getState(); }
  async exportHtml(): Promise<string | undefined> { return (await this.#active()).exportToHtml(); }
  async setAutoCompaction(enabled: boolean): Promise<EngineSessionState> { (await this.#active()).setAutoCompactionEnabled(enabled); return this.getState(); }
  async setThinkingLevel(level: string): Promise<EngineSessionState> { (await this.#active()).setThinkingLevel(level as any); return this.getState(); }
  async getState(): Promise<EngineSessionState> { return this.#state(await this.#active()); }

  async listProviders(): Promise<ProviderConfig[]> { return listProviderConfigs(this.#paths, await loadProviderKeys(this.#paths)); }
  async listNativeProviders(): Promise<NativeProviderConfig[]> { return nativeProviderCatalog(); }
  async addNativeProvider(id: string, apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> { await addNativeProviderConfig(this.#paths, id, apiKey, models); await this.reloadProviders(); return this.listProviders(); }
  async fetchModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> { return fetchProviderModels(baseUrl, apiKey); }
  async refreshProviderModels(id: string): Promise<ProviderModel[]> { return refreshProviderModels(this.#paths, id); }
  async saveFastVibe(apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> { await saveFastVibeConfig(this.#paths, apiKey, models); await this.reloadProviders(); return this.listProviders(); }
  async addProvider(draft: { name: string; baseUrl: string; apiKey: string; api?: import("@shared/types").ProviderApi }, models: ProviderModel[]): Promise<ProviderConfig[]> { await addProviderConfig(this.#paths, draft, models); await this.reloadProviders(); return this.listProviders(); }
  async updateProvider(id: string, patch: { name?: string; baseUrl?: string; api?: string; enabled?: boolean; models?: ProviderModel[]; apiKey?: string }): Promise<ProviderConfig[]> { updateProviderConfig(this.#paths, id, { name: patch.name, baseUrl: patch.baseUrl?.trim().replace(/\/+$/, ""), api: patch.api, enabled: patch.enabled, models: patch.models }); if (patch.apiKey !== undefined) { const env = providerKeyEnv(this.#paths, id); if (env) await setProviderKey(this.#paths, env, patch.apiKey); } await this.reloadProviders(); return this.listProviders(); }
  async removeProvider(id: string): Promise<ProviderConfig[]> { removeProviderConfig(this.#paths, id); await this.reloadProviders(); return this.listProviders(); }
  async reloadProviders(): Promise<EngineStatus> { await this.stop(); return this.start(this.#cwd); }
  async handleExtensionUi(_event: Record<string, unknown>): Promise<void> { return; }

  async #createWorktree(project: string, id: string, label: string): Promise<{ path: string; branch: string }> {
    const root = (await execFileAsync("git", ["-C", project, "rev-parse", "--show-toplevel"], { timeout: 5000 })).stdout.trim();
    if (!root) throw new Error("无法识别 Git 项目");
    const safe = label.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 32) || "run";
    const branch = `fastvibe/${safe}-${id.slice(0, 8)}`;
    const path = join(this.#paths.worktreesDir, `${safe}-${id.slice(0, 8)}`);
    await execFileAsync("git", ["-C", root, "worktree", "add", "-b", branch, path, "HEAD"], { timeout: 30000, maxBuffer: 128 * 1024 });
    return { path, branch };
  }

  async #removeWorktree(path: string): Promise<void> {
    await execFileAsync("git", ["-C", path, "worktree", "remove", "--force", path], { timeout: 30000, maxBuffer: 128 * 1024 }).catch(() => undefined);
  }

  async #reloadSkills(): Promise<void> {
    await Promise.all(
      [...this.#sessions.values()].map((item) =>
        item.session.isStreaming ? Promise.resolve() : item.session.reload().catch(() => undefined),
      ),
    );
  }
  async #ensureReady(): Promise<void> { if (this.#status.state !== "ready" || !this.#models) await this.start(this.#cwd); if (this.#status.state !== "ready" || !this.#models) throw new Error("engine not ready"); }
  async #active(): Promise<AgentSession> { await this.#ensureReady(); const active = this.#activeId ? this.#sessions.get(this.#activeId) : undefined; if (active) return active.session; const conversation = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined; if (!conversation) throw new Error("no active conversation"); const managed = await this.#ensureSession(conversation); this.#activate(managed); return managed.session; }
  async #ensureSession(conversation: Conversation): Promise<ManagedSession> {
    const existing = this.#sessions.get(conversation.id);
    if (existing) return existing;
    const pending = this.#sessionPromises.get(conversation.id);
    if (pending) return pending;
    if (!this.#auth || !this.#models) throw new Error("engine not ready");
    const cwd = conversation.cwd || conversation.project || this.#paths.scratchDir;
    const sessionDir = join(this.#paths.sessionsDir, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
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
      agentDir: this.#paths.agentDir,
      authStorage: this.#auth,
      modelRegistry: this.#models,
      sessionManager,
      settingsManager: SettingsManager.create(cwd, this.#paths.agentDir),
      customTools: await this.#mcp.tools(),
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
    const managed: ManagedSession = { conversationId: conversation.id, cwd, session: result.session, extensions: result.extensionsResult, unsubscribe: () => undefined };
    managed.unsubscribe = result.session.subscribe((event) => {
      const payload = { ...(event as unknown as Record<string, unknown>), conversationId: conversation.id };
      if (this.#activeId === conversation.id || conversation.kind === "side-chat") {
        this.#emit(payload);
        return;
      }
      if (event.type === "agent_end") {
        this.#emit({ type: "conversation_activity", conversationId: conversation.id, title: this.#catalog.get(conversation.id)?.title ?? "会话", status: "completed" });
      }
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
  #state(session: AgentSession): EngineSessionState { const model = session.model; const usage = session.getContextUsage(); return { model: model ? { provider: model.provider, id: model.id } : undefined, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting, interruptMode: this.#interruptMode, sessionFile: session.sessionFile, sessionId: session.sessionId, sessionName: session.sessionName, messageCount: session.messages.length, queuedMessageCount: session.pendingMessageCount, autoCompactionEnabled: session.autoCompactionEnabled, steeringMode: session.steeringMode, followUpMode: session.followUpMode, contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined }; }
  #opened(conversation: Conversation, messages: ChatMessage[], state: EngineSessionState | null): ConversationOpenResult { return { ...this.#catalog.snapshot(), conversation, messages, state, status: this.#status }; }
  #setStatus(status: EngineStatus): void { this.#status = status; for (const listener of this.#statusListeners) listener(status); }
  #queue<T>(work: () => Promise<T>): Promise<T> { const next = this.#operation.then(work, work); this.#operation = next.then(() => undefined, () => undefined); return next; }
}
