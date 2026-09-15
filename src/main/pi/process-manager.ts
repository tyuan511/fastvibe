import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRegistry,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type AgentSessionEvent,
  type ExtensionUIContext,
  type LoadExtensionsResult,
  type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type {
  ChatMessage,
  Conversation,
  ConversationDeleteResult,
  ConversationOpenResult,
  ConversationReadyEvent,
  ExtensionInfo,
  ExtensionPackage,
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
  ThinkingTiming,
  TuiRun,
  WorkspaceSnapshot,
  MultiRunRequest,
  MultiRunResult,
  ModelPrice,
  NativeProviderConfig,
  PermissionQuestion,
} from "@shared/types";
import { ConversationCatalog } from "../engine/conversation-catalog";
import { readDefaultModel } from "../engine/app-settings";
import { mapEngineMessages } from "../engine/map-messages";
import { ReasoningStore } from "../engine/reasoning-store";
import {
  addNativeProvider as addNativeProviderConfig,
  addProvider as addProviderConfig,
  applyProviders,
  fetchProviderModels,
  listProviderConfigs,
  loadProviderKeys,
  modelPriceIndex,
  nativeProviderCatalog,
  providerKeyEnv,
  refreshProviderModels,
  removeProvider as removeProviderConfig,
  saveFastVibe as saveFastVibeConfig,
  setProviderKey,
  updateProvider as updateProviderConfig,
  usableProviders,
} from "../engine/providers";
import { catalogPrice } from "../engine/models-dev";
import { priceUsage } from "../engine/pricing";
import { getFastVibePaths, type FastVibePaths } from "../engine/paths";
import { McpManager, type McpServerConfig, type McpServerStatus } from "./mcp-manager";
import { SkillManager } from "./skill-manager";
import { builtinExtensionPaths, ExtensionManager } from "./extension-manager";
import { createTuiWidget, renderExtensionMessage, renderTuiComponent, type TuiComponent } from "./tui-bridge";

type ManagedSession = { conversationId: string; cwd: string; session: AgentSession; extensions: LoadExtensionsResult; unsubscribe: () => void };
/** SDK UI context plus FastVibe's single-panel multi-question prompt. */
type FastVibeExtensionUIContext = ExtensionUIContext & {
  questions(title: string, questions: PermissionQuestion[], opts?: { timeout?: number }): Promise<Array<string | null> | undefined>;
};
/** The command-capable context bound to a replacement session (`withSession` callbacks). */
type ReplacementContext = ReturnType<AgentSession["createReplacedSessionContext"]>;
/** Per-conversation wall-clock accounting, measured from engine events. */
type RunTiming = {
  /** Completed run time (model + tools). */
  totalMs: number;
  /** Completed tool execution time. */
  toolMs: number;
  /** Start of the in-flight run, if any. */
  runStartedAt?: number;
  /** Start of the oldest in-flight tool call, if any. */
  toolStartedAt?: number;
  /** In-flight tool call count; tools may overlap. */
  openTools: number;
};
/** Thinking blocks of the message currently streaming, per conversation. */
type ReasoningRun = { blocks: ThinkingTiming[] };
const execFileAsync = promisify(execFile);

/**
 * Streaming `message_update` events carry the whole accumulated assistant message
 * plus its full partial content on every token. The renderer only reads
 * `assistantMessageEvent`, so forwarding those fields made long replies O(n²) over
 * IPC (each token re-serialised the entire answer) and was a main cause of the UI
 * freezing mid-run. Strip the unused weight; keep the ordered deltas.
 */
function errorSummary(message: unknown): Record<string, unknown> | undefined {
  if (typeof message !== "object" || message === null) return undefined;
  const record = message as Record<string, unknown>;
  if (record.role !== "assistant" || record.stopReason !== "error") return undefined;
  return { role: "assistant", stopReason: "error", errorMessage: record.errorMessage };
}

function slimStreamEvent(event: Record<string, unknown>): Record<string, unknown> {
  if (event.type === "message_update") {
    const inner = event.assistantMessageEvent;
    if (typeof inner !== "object" || inner === null) return event;
    const innerRecord = inner as Record<string, unknown>;
    const { message: _message, ...rest } = event;
    if (innerRecord.type === "text_delta" || innerRecord.type === "thinking_delta") {
      const { partial: _partial, ...deltaOnly } = innerRecord;
      return { ...rest, assistantMessageEvent: deltaOnly };
    }
    if (innerRecord.type === "error") {
      const { partial: _partial, error, ...deltaOnly } = innerRecord;
      return { ...rest, assistantMessageEvent: { ...deltaOnly, error: errorSummary(error) } };
    }
    return rest;
  }
  // `agent_end` / `turn_end` / `message_end` carry the whole transcript. The UI
  // only needs the last assistant's stopReason/errorMessage to show a failure.
  if (event.type === "agent_end") {
    const messages = Array.isArray(event.messages) ? event.messages : [];
    const last = [...messages].reverse().find((item) => errorSummary(item));
    const { messages: _messages, ...rest } = event;
    return last ? { ...rest, messages: [errorSummary(last)] } : rest;
  }
  if (event.type === "turn_end" || event.type === "message_end") {
    const { message, toolResults: _toolResults, ...rest } = event;
    const summary = errorSummary(message);
    return summary ? { ...rest, message: summary } : rest;
  }
  return event;
}

function isUserEngineMessage(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user";
}

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
  #runtime: ModelRuntime | null = null;
  #models: ModelRegistry | null = null;
  #modelsCache: FastVibeModel[] | null = null;
  /** Every configured model's price ladder, refreshed whenever the registry is. */
  #prices: Map<string, ModelPrice> = new Map();
  #operation: Promise<unknown> = Promise.resolve();
  #pendingUi = new Map<string, { resolve: (value: unknown) => void; fallback: unknown }>();
  /** Live component-factory widgets: re-rendered on a timer so a dashboard stays current. */
  #widgetTimers = new Map<string, NodeJS.Timeout>();
  /** Created component instances, kept so a dashboard's internal state survives a redraw. */
  #widgetComponents = new Map<string, TuiComponent>();
  /** Last rendered widget signature, so an unchanged dashboard is not re-sent. */
  #widgetSignature = new Map<string, string>();
  /** Column width widgets are laid out at (the terminal width equivalent). */
  #widgetWidth = 100;
  #sessionPromises = new Map<string, Promise<ManagedSession>>();
  /** Last known running state per conversation, so every change is broadcast exactly once. */
  #running = new Map<string, boolean>();
  /** Conversations whose session must be re-pointed at the reloaded model registry once its run lands. */
  #modelDirty = new Set<string>();
  /** Per-conversation timings for the composer's turn statistics. */
  #timing = new Map<string, RunTiming>();
  /** Live thinking blocks per conversation; filed against the entry when it lands. */
  #reasoningRun = new Map<string, ReasoningRun>();
  /** Bounds of finished blocks, so a reloaded transcript keeps showing them. */
  #reasoning: ReasoningStore;
  #interruptMode: "immediate" | "wait" = "immediate";
  #mcp: McpManager;
  #skills: SkillManager;
  /** pi package installs (extensions), kept in the isolated agentDir. */
  #extensions: ExtensionManager;

  constructor() {
    this.#paths = getFastVibePaths();
    this.#catalog = new ConversationCatalog(this.#paths.conversationsFile, this.#paths.scratchDir);
    this.#reasoning = new ReasoningStore(this.#paths.reasoningFile);
    this.#mcp = new McpManager(this.#paths.mcpFile);
    this.#skills = new SkillManager(this.#paths.agentDir, this.#paths.skillsDir);
    this.#extensions = new ExtensionManager(this.#paths.agentDir, this.#paths.scratchDir);
    const active = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
    this.#cwd = active?.project ?? this.#paths.scratchDir;
  }

  listWorkspace(): WorkspaceSnapshot { return this.#catalog.snapshot(); }
  flush(): void { this.#catalog.flush(); this.#reasoning.flush(); }
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
      this.#prices = modelPriceIndex(this.#paths);
      // Credentials live in an in-memory overlay so keys are never written to the
      // SDK's own auth file; `models.json` (which FastVibe owns) is the only file
      // the runtime reads, and dynamic catalogs stay in memory too.
      this.#runtime = await ModelRuntime.create({
        credentials: new InMemoryCredentialStore(),
        modelsStore: new InMemoryModelsStore(),
        modelsPath: join(this.#paths.agentDir, "models.json"),
        allowModelNetwork: false,
        refreshOnCreate: false,
      });
      for (const provider of providers) {
        const key = keys[provider.apiKeyEnv];
        if (key) await this.#runtime.setRuntimeApiKey(provider.id, key);
      }
      this.#models = new ModelRegistry(this.#runtime);
      await this.#models.refresh({ allowNetwork: false });
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
      this.#resolvePendingUi();
      for (const key of [...this.#widgetTimers.keys()]) this.#clearWidget(key);
      this.#activeId = null;
      // Tell the UI every tracked conversation stopped, so no stale spinner
      // survives an engine stop/restart.
      for (const [id, running] of this.#running) {
        if (running) this.#emit({ type: "conversation_running", conversationId: id, running: false });
      }
      this.#running.clear();
      this.#timing.clear();
      await Promise.all(sessions.map(async (item) => { item.unsubscribe(); this.#persist(item.session); await item.session.dispose(); }));
      this.#models = null;
      this.#runtime = null;
      await this.#mcp.close();
      if (this.#status.state === "ready" || this.#status.state === "starting") this.#setStatus({ state: "idle" });
    });
  }

  async prompt(message: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void> {
    const session = await this.#active();
    if (this.#activeId) await this.#flushModelRebind(this.#activeId);
    // The UI marks a run finished the moment `agent_end` arrives, but the SDK
    // keeps `isStreaming` true until its listeners and auto-compaction settle.
    // A plain prompt in that window would throw "Agent is already processing",
    // so wait it out — the caller already decided the run is over.
    if (session.isStreaming && !options?.streamingBehavior) await session.agent.waitForIdle();
    await session.prompt(message, options);
  }

  async promptConversation(id: string, message: string): Promise<void> {
    const conversation = this.#catalog.get(id);
    if (!conversation) throw new Error("conversation not found");
    await this.#ensureReady();
    const managed = await this.#ensureSession(conversation);
    await this.#flushModelRebind(id);
    await this.#promptWhenIdle(managed.session, message);
  }

  async getConversationMessages(id: string): Promise<ChatMessage[]> {
    const managed = this.#sessions.get(id);
    if (managed) return this.#messages(managed.session);
    const conversation = this.#catalog.get(id);
    if (!conversation) return [];
    await this.#ensureReady();
    const created = await this.#ensureSession(conversation);
    return this.#messages(created.session);
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
    // Steering is only drained between turns of a live run. `session.isStreaming`
    // still reads true while the SDK settles after `agent_end`, and a steer parked
    // in that window is never delivered — so trust our own run flag, and fall back
    // to a fresh turn whenever the run has already ended (or never started).
    if (!this.#isLive()) {
      await this.#promptWhenIdle(session, message, images);
      return;
    }
    if (this.#interruptMode === "wait") {
      await this.#promptWhenIdle(session, message, images);
      return;
    }
    await session.steer(message, images);
  }
  async followUp(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    const session = await this.#active();
    if (!this.#isLive()) {
      await this.#promptWhenIdle(session, message, images);
      return;
    }
    await session.followUp(message, images);
  }
  async abort(): Promise<void> {
    // A `tool_call` hook may be parked on an extension UI prompt (permission
    // sandbox / question tool). Resolve those before aborting: the hook cannot
    // observe the abort signal while it awaits `ctx.ui.confirm`, so leaving the
    // promise pending would hang the tool, keep `agent_end` from firing and pin
    // the conversation as "running" forever.
    this.#resolvePendingUi();
    await (await this.#active()).abort();
  }
  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> { return (await this.#active()).clearQueue(); }
  async branch(entryId: string): Promise<ChatMessage[]> { await (await this.#active()).navigateTree(entryId); return this.loadMessages(); }

  async getSessionStats(): Promise<SessionStats> {
    const session = await this.#active();
    const stats = session.getSessionStats();
    const timing = this.#timing.get(this.#activeId ?? "");
    const now = Date.now();
    const totalMs = (timing?.totalMs ?? 0) + (timing?.runStartedAt !== undefined ? now - timing.runStartedAt : 0);
    const toolMs = (timing?.toolMs ?? 0) + (timing?.toolStartedAt !== undefined ? now - timing.toolStartedAt : 0);
    return {
      tokens: {
        input: stats.tokens.input,
        output: stats.tokens.output,
        cacheRead: stats.tokens.cacheRead,
        cacheWrite: stats.tokens.cacheWrite,
        total: stats.tokens.total,
      },
      cost: this.#sessionCost(session),
      toolCalls: stats.toolCalls,
      steps: stats.assistantMessages,
      timing: { totalMs, modelMs: Math.max(0, totalMs - toolMs), toolMs },
    };
  }
  /**
   * The conversation's cost, billed per turn against each model's price ladder.
   *
   * `session.getSessionStats()` adds up the flat `usage.cost` the engine recorded,
   * which cannot reflect a model's long-context tiers — pi prices a run with a single
   * rate. The token counts are the engine's, and only the rate is chosen here; a turn
   * whose model the app cannot price falls back to what the engine recorded.
   */
  #sessionCost(session: AgentSession): number {
    let total = 0;
    for (const message of session.state.messages) {
      if (message.role !== "assistant") continue;
      const price =
        this.#prices.get(`${message.provider}/${message.model}`) ??
        this.#prices.get(message.model) ??
        catalogPrice(message.model);
      total += priceUsage(price ?? {}, message.usage) ?? message.usage.cost.total ?? 0;
    }
    return total;
  }
  async compact(customInstructions?: string): Promise<EngineSessionState> { await (await this.#active()).compact(customInstructions); return this.getState(); }  async getCommands(): Promise<SlashCommand[]> {
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
  respondPermission(payload: { id: string; confirmed?: boolean; value?: string; cancelled?: boolean; answers?: Array<string | null> }): void {
    const pending = this.#pendingUi.get(payload.id);
    if (!pending) return;
    this.#pendingUi.delete(payload.id);
    const resolved = payload.cancelled
      ? pending.fallback
      : Array.isArray(payload.answers)
        ? payload.answers
        : typeof payload.value === "string"
          ? payload.value
          : payload.confirmed ?? pending.fallback;
    pending.resolve(resolved);
  }
  async newSession(): Promise<void> { await (await this.#active()).abort(); }

  async createConversation(project?: string): Promise<ConversationOpenResult> {
      const stale = this.#catalog.list().filter((item) => !item.preview);
      for (const item of stale) await this.deleteConversation(item.id);
      const conversation = this.#catalog.create(project);
      return this.#openFresh(conversation);
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
      await this.#flushModelRebind(conversation.id);
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
      const messages = this.#messages(managed.session);
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
    this.#running.delete(id);
    this.#timing.delete(id);
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
  async loadMessages(): Promise<ChatMessage[]> { return this.#messages(await this.#active()); }
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
  /** Conversation ids with a run in flight, for the sidebar's run indicators. */
  getRunningConversations(): string[] { return [...this.#running].filter(([, running]) => running).map(([id]) => id); }

  async listProviders(): Promise<ProviderConfig[]> { return listProviderConfigs(this.#paths, await loadProviderKeys(this.#paths)); }
  async listNativeProviders(): Promise<NativeProviderConfig[]> { return nativeProviderCatalog(); }
  async addNativeProvider(id: string, apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> { await addNativeProviderConfig(this.#paths, id, apiKey, models); await this.reloadProviders(); return this.listProviders(); }
  async fetchModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> { return fetchProviderModels(baseUrl, apiKey); }
  async refreshProviderModels(id: string): Promise<ProviderModel[]> { return refreshProviderModels(this.#paths, id); }
  async saveFastVibe(apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> { await saveFastVibeConfig(this.#paths, apiKey, models); await this.reloadProviders(); return this.listProviders(); }
  async addProvider(draft: { name: string; baseUrl: string; apiKey: string; api?: import("@shared/types").ProviderApi }, models: ProviderModel[]): Promise<ProviderConfig[]> { await addProviderConfig(this.#paths, draft, models); await this.reloadProviders(); return this.listProviders(); }
  async updateProvider(id: string, patch: { name?: string; baseUrl?: string; api?: string; enabled?: boolean; models?: ProviderModel[]; apiKey?: string }): Promise<ProviderConfig[]> { updateProviderConfig(this.#paths, id, { name: patch.name, baseUrl: patch.baseUrl?.trim().replace(/\/+$/, ""), api: patch.api, enabled: patch.enabled, models: patch.models }); if (patch.apiKey !== undefined) { const env = providerKeyEnv(this.#paths, id); if (env) await setProviderKey(this.#paths, env, patch.apiKey); } await this.reloadProviders(); return this.listProviders(); }
  async removeProvider(id: string): Promise<ProviderConfig[]> { await removeProviderConfig(this.#paths, id); await this.reloadProviders(); return this.listProviders(); }
  /**
   * Provider config changed on disk. Apply it to the running engine — no teardown.
   *
   * This used to be `stop()` + `start()`, which disposed every live session: an edit
   * in Settings → 供应商 aborted the reply that was streaming, dropped the other
   * conversations' sessions, and closed the MCP connections — the chat simply went
   * dead on an unrelated settings change. The runtime's credential overlay is a
   * mutable in-memory map and `ModelRegistry.refresh()` re-reads `models.json` in
   * place, so keys, endpoints and model lists can be swapped underneath a live session.
   */
  async reloadProviders(): Promise<EngineStatus> {
    // A cold engine has no conversation to break, and the first provider the user
    // connects is exactly when a full start (registry, MCP, session) is required.
    if (this.#status.state !== "ready" || !this.#runtime || !this.#models) return this.start(this.#cwd);
    return this.#queue(async () => {
      const runtime = this.#runtime;
      const registry = this.#models;
      if (!runtime || !registry) return this.#status;
      const keys = await loadProviderKeys(this.#paths);
      const providers = usableProviders(this.#paths, keys);
      // The overlay is the only thing we put keys in, so it also lists exactly the
      // providers we set — drop the ones the user just removed or disabled.
      for (const credential of await runtime.listCredentials()) {
        if (!providers.some((item) => item.id === credential.providerId)) {
          await runtime.removeRuntimeApiKey(credential.providerId);
        }
      }
      for (const provider of providers) {
        const key = keys[provider.apiKeyEnv];
        if (key) await runtime.setRuntimeApiKey(provider.id, key);
      }
      // Rewrite models.json — the only provider config the SDK reads — then let the
      // shared registry re-read it, so every session resolves the new definition.
      this.#modelsCache = applyProviders(this.#paths);
      this.#prices = modelPriceIndex(this.#paths);
      // `refresh()` is async in pi 0.85; the rebind below reads the registry
      // synchronously, so it must finish before we swap the model objects in.
      await registry.refresh({ allowNetwork: false });
      if (providers.length === 0) {
        if (this.#status.state !== "needsAuth") this.#setStatus({ state: "needsAuth", cwd: this.#cwd });
        return this.#status;
      }
      await this.#rebindModels();
      if (this.#status.state !== "ready") this.#setStatus({ state: "ready", cwd: this.#cwd });
      return this.#status;
    });
  }
  async handleExtensionUi(_event: Record<string, unknown>): Promise<void> { return; }
  listExtensionPackages(): ExtensionPackage[] { return this.#extensions.list(); }
  async installExtensionPackage(source: string): Promise<ExtensionPackage[]> { await this.#extensions.install(source); await this.#reloadSkills(); return this.#extensions.list(); }
  async removeExtensionPackage(source: string): Promise<ExtensionPackage[]> { await this.#extensions.remove(source); await this.#reloadSkills(); return this.#extensions.list(); }

  /**
   * Session replacement requested by an extension command (`ctx.newSession`).
   *
   * FastVibe hands the SDK a prepared SessionManager so the extension's `setup`
   * can seed the new session before anything binds, then creates a fresh
   * conversation, activates it, tells the renderer to follow, and only then runs
   * `withSession` against the replacement. The source session is left intact so a
   * plan handoff does not destroy the planning conversation.
   */
  async #extensionNewSession(
    sourceId: string,
    options?: {
      parentSession?: string;
      setup?: (sessionManager: ReturnType<typeof SessionManager.create>) => Promise<void>;
      withSession?: (ctx: ReplacementContext) => Promise<void>;
    },
  ): Promise<{ cancelled: boolean }> {
    const source = this.#catalog.get(sourceId);
    const cwd = this.#sessions.get(sourceId)?.cwd ?? source?.cwd ?? this.#paths.scratchDir;
    const sessionDir = join(this.#paths.sessionsDir, `--${cwd.replace(/^[/\\]/, "").replace(/[/\\:]/g, "-")}--`);
    const sessionManager = SessionManager.create(cwd, sessionDir);
    if (options?.setup) await options.setup(sessionManager);
    const conversation = this.#catalog.create(source?.project, { cwd });
    const managed = await this.#createSession(conversation, cwd, sessionManager, {
      type: "session_start",
      reason: "new",
      ...(options?.parentSession ? { previousSessionFile: options.parentSession } : {}),
    });
    this.#catalog.setActive(conversation.id);
    this.#activate(managed);
    const state = this.#state(managed.session);
    const updated = this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
    this.#emit({ type: "conversation_opened", result: this.#opened(updated, [], state) });
    if (options?.withSession) await options.withSession(managed.session.createReplacedSessionContext());
    return { cancelled: false };
  }

  /** Switch to a session file an extension asked for, opening it under the catalog. */
  async #extensionSwitchSession(
    sessionPath: string,
    options?: { withSession?: (ctx: ReplacementContext) => Promise<void> },
  ): Promise<{ cancelled: boolean }> {
    await this.#ensureReady();
    let conversation = this.#catalog.listAll().find((item) => item.sessionFile === sessionPath);
    if (!conversation) conversation = this.#catalog.create(undefined, { sessionFile: sessionPath });
    this.#catalog.setActive(conversation.id);
    const managed = await this.#ensureSession(conversation);
    this.#activate(managed);
    const state = this.#state(managed.session);
    const messages = this.#messages(managed.session);
    const updated = this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
    this.#emit({ type: "conversation_opened", result: this.#opened(updated, messages, state) });
    if (options?.withSession) await options.withSession(managed.session.createReplacedSessionContext());
    return { cancelled: false };
  }

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
  async #ensureReady(): Promise<void> { if (this.#status.state !== "ready" || !this.#models) await this.start(this.#cwd); if (this.#status.state === "needsAuth") throw new Error("尚未配置模型供应商，请先在设置中连接模型"); if (this.#status.state !== "ready" || !this.#models) throw new Error("engine not ready"); }
  /**
   * A session needs a provider, but `needsAuth` is a normal first-run state, not an
   * error: an empty conversation is still created and the composer's model menu is
   * how the user connects one.
   */
  async #sessionIfReady(conversation: Conversation): Promise<ManagedSession | null> {
    if (this.#status.state === "needsAuth") return null;
    await this.#ensureReady();
    return this.#ensureSession(conversation);
  }
  async #openFresh(conversation: Conversation): Promise<ConversationOpenResult> {
    const managed = await this.#sessionIfReady(conversation);
    if (!managed) return this.#opened(conversation, [], null);
    this.#activate(managed);
    const state = this.#state(managed.session);
    const updated = this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
    return this.#opened(updated, [], state);
  }
  async #active(): Promise<AgentSession> { await this.#ensureReady(); const active = this.#activeId ? this.#sessions.get(this.#activeId) : undefined; if (active) return active.session; const conversation = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined; if (!conversation) throw new Error("no active conversation"); const managed = await this.#ensureSession(conversation); this.#activate(managed); return managed.session; }
  async #ensureSession(conversation: Conversation): Promise<ManagedSession> {
    const existing = this.#sessions.get(conversation.id);
    if (existing) return existing;
    const pending = this.#sessionPromises.get(conversation.id);
    if (pending) return pending;
    if (!this.#runtime || !this.#models) throw new Error("engine not ready");
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
  async #createSession(
    conversation: Conversation,
    cwd: string,
    sessionManager: ReturnType<typeof SessionManager.create>,
    sessionStartEvent?: SessionStartEvent,
  ): Promise<ManagedSession> {
    if (!this.#runtime || !this.#models) throw new Error("engine not ready");
    const settingsManager = SettingsManager.create(cwd, this.#paths.agentDir);
    // A loader we own lets us splice in FastVibe's built-in extensions
    // (`plan`, `goal`) alongside whatever the user installed. `createAgentSession`
    // only auto-reloads a loader it creates, so reload ours before handing it over.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.#paths.agentDir,
      settingsManager,
      additionalExtensionPaths: builtinExtensionPaths(),
    });
    await resourceLoader.reload();
    const result = await createAgentSession({
      cwd,
      agentDir: this.#paths.agentDir,
      modelRuntime: this.#runtime,
      sessionManager,
      settingsManager,
      resourceLoader,
      customTools: await this.#mcp.tools(),
      ...(sessionStartEvent ? { sessionStartEvent } : {}),
    });
    await result.session.bindExtensions({
      // Extensions see `rpc`, not the default `print`: FastVibe bridges dialogs,
      // status, widgets and session replacement, so TUI-aware plugins (plan mode,
      // goals) take their non-terminal code paths instead of refusing to run.
      mode: "rpc",
      uiContext: this.#extensionUi(),
      commandContextActions: {
        waitForIdle: () => result.session.agent.waitForIdle(),
        newSession: (options) => this.#extensionNewSession(conversation.id, options),
        // FastVibe branches in place (`navigateTree`); a separate fork file is not
        // tracked by the catalog, so report cancellation rather than half-create one.
        fork: async () => ({ cancelled: true }),
        navigateTree: async (entryId) => {
          const navigation = await result.session.navigateTree(entryId);
          return { cancelled: navigation.cancelled };
        },
        switchSession: (sessionPath, options) => this.#extensionSwitchSession(sessionPath, options),
        reload: () => result.session.reload(),
      },
      onError: (error) => this.#emit({ type: "extension_error", extensionPath: error.extensionPath, event: error.event, error: error.error }),
    });
    const managed: ManagedSession = { conversationId: conversation.id, cwd, session: result.session, extensions: result.extensionsResult, unsubscribe: () => undefined };
    managed.unsubscribe = result.session.subscribe((event) => {
      // Accumulate wall-clock timings for the composer's turn statistics. Tools
      // may overlap, so the open count gates a single tool span.
      const now = Date.now();
      if (event.type === "agent_start") {
        const timing = this.#timingFor(conversation.id);
        if (timing.runStartedAt === undefined) timing.runStartedAt = now;
      } else if (event.type === "agent_end") {
        // A provider edited mid-run is applied to the config the run started under;
        // the session picks the reloaded model up now that nothing is in flight.
        void this.#flushModelRebind(conversation.id).catch(() => undefined);
        const timing = this.#timingFor(conversation.id);
        if (timing.runStartedAt !== undefined) {
          timing.totalMs += now - timing.runStartedAt;
          timing.runStartedAt = undefined;
        }
      } else if (event.type === "tool_execution_start") {
        const timing = this.#timingFor(conversation.id);
        if (timing.toolStartedAt === undefined) timing.toolStartedAt = now;
        timing.openTools += 1;
      } else if (event.type === "tool_execution_end") {
        const timing = this.#timingFor(conversation.id);
        timing.openTools = Math.max(0, timing.openTools - 1);
        if (timing.openTools === 0 && timing.toolStartedAt !== undefined) {
          timing.toolMs += now - timing.toolStartedAt;
          timing.toolStartedAt = undefined;
        }
      }
      // Time each thinking block as it streams. The transcript stores one timestamp
      // per assistant message (its request start), so this is the only chance to
      // record how long a block thought before the block is folded into the entry.
      this.#timeReasoning(conversation.id, event, result.session, now);
      // Broadcast run start/end for every conversation, active or not, so the
      // sidebar keeps showing which chats are still working after the user
      // switches away or starts a new one. `agent_end` is the authoritative end:
      // `session.isStreaming` only flips false after its listeners settle.
      const running =
        event.type === "agent_end"
          ? false
          : event.type === "agent_start" || event.type === "turn_start"
            ? true
            : undefined;
      if (running !== undefined && this.#running.get(conversation.id) !== running) {
        this.#running.set(conversation.id, running);
        this.#emit({ type: "conversation_running", conversationId: conversation.id, running });
      }
      // A user turn has no id of its own; the session entry that stores it does.
      // The renderer's optimistic copy needs that id to branch (retry / edit) back
      // into the session tree, so hand it over once the entry has been persisted
      // (which happens immediately after this event is emitted).
      if (event.type === "message_end" && isUserEngineMessage(event.message)) {
        const userMessage = event.message;
        queueMicrotask(() => {
          const entry = [...result.session.sessionManager.getEntries()]
            .reverse()
            .find((item) => item.type === "message" && item.message === userMessage);
          // Flush the user turn now: the SDK holds the first write until an assistant
          // message exists, so without this a restart mid-run (the dev server reloads
          // constantly) drops the prompt that was just sent.
          this.#persist(result.session);
          if (this.#activeId !== conversation.id && conversation.kind !== "side-chat") return;
          if (entry) this.#emit({ type: "user_message_persisted", conversationId: conversation.id, entryId: entry.id });
        });
      }
      const payload: Record<string, unknown> = {
        ...slimStreamEvent(event as unknown as Record<string, unknown>),
        conversationId: conversation.id,
      };
      // Bounds of the block being streamed, so the renderer derives its elapsed time
      // from the same clock that will be filed against the entry later — including
      // when the user switches back into a block that is still open.
      if (event.type === "message_update") {
        const block = this.#liveThinkingBlock(conversation.id);
        if (block) {
          payload.thinkingStartedAt = block.startedAt;
          if (block.endedAt !== undefined) payload.thinkingEndedAt = block.endedAt;
        }
      }
      if (this.#activeId === conversation.id || conversation.kind === "side-chat") {
        this.#emit(payload);
        return;
      }
      if (event.type === "agent_end") {
        this.#emit({ type: "conversation_activity", conversationId: conversation.id, title: this.#catalog.get(conversation.id)?.title ?? "会话", status: "completed" });
      }
    });
    this.#sessions.set(conversation.id, managed);
    // A conversation with no history yet starts on the user's pinned 默认模型.
    if (result.session.messages.length === 0) await this.#applyPreferredModel(result.session);
    const payload: ConversationReadyEvent = {
      id: conversation.id,
      messages: this.#messages(result.session),
      state: this.#state(result.session),
      status: this.#status,
    };
    for (const listener of this.#readyListeners) listener(payload);
    return managed;
  }
  #emit(event: Record<string, unknown>): void { for (const listener of this.#eventListeners) listener(event); }
  /** True when the active conversation has a run in flight (`agent_end` clears it). */
  #isLive(): boolean { return this.#activeId !== null && this.#running.get(this.#activeId) === true; }
  /**
   * Send a plain turn, first waiting out any run the SDK still reports as
   * streaming (it flips `isStreaming` only after `agent_end` listeners and
   * auto-compaction settle). Without this a follow-up that the UI considers
   * "after completion" throws "Agent is already processing".
   */
  async #promptWhenIdle(session: AgentSession, message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    if (session.isStreaming) await session.agent.waitForIdle();
    await session.prompt(message, { images });
  }
  #timingFor(id: string): RunTiming {
    let timing = this.#timing.get(id);
    if (!timing) {
      timing = { totalMs: 0, toolMs: 0, openTools: 0 };
      this.#timing.set(id, timing);
    }
    return timing;
  }

  /**
   * Close the open thinking block, if any. Bounds are only ever written once, so a
   * provider that emits `thinking_end` and then another content event cannot extend
   * the block it already closed.
   */
  #closeThinkingBlock(run: ReasoningRun, now: number): void {
    const block = run.blocks.at(-1);
    if (block && block.endedAt === undefined) block.endedAt = now;
  }

  /**
   * Track where this conversation's thinking blocks start and end.
   *
   * The bounds are filed against the session entry the assistant message becomes,
   * because that entry id is what `#messages` hands the renderer as the message id —
   * so the timing follows the message through every reload. Until then they ride
   * along on the streamed events, which is what lets the renderer resume a block the
   * user switched away from in the middle of.
   */
  #timeReasoning(conversationId: string, event: AgentSessionEvent, session: AgentSession, now: number): void {
    if (event.type === "message_start") {
      this.#reasoningRun.set(conversationId, { blocks: [] });
      return;
    }
    if (event.type === "message_update") {
      let run = this.#reasoningRun.get(conversationId);
      if (!run) {
        run = { blocks: [] };
        this.#reasoningRun.set(conversationId, run);
      }
      const inner = event.assistantMessageEvent.type;
      if (inner === "thinking_start") {
        run.blocks.push({ startedAt: now });
      } else if (inner !== "thinking_delta") {
        // `thinking_end` is authoritative; the content that follows a block would
        // only be reached without one if a provider skipped the end event.
        this.#closeThinkingBlock(run, now);
      }
      return;
    }
    if (event.type !== "message_end") return;
    const run = this.#reasoningRun.get(conversationId);
    this.#reasoningRun.delete(conversationId);
    if (!run) return;
    this.#closeThinkingBlock(run, now);
    const blocks = run.blocks;
    if (blocks.length === 0) return;
    const message = event.message;
    // The entry is appended right after this event settles (the SDK persists it
    // synchronously once its listeners return), so the id only exists a microtask
    // later — same dance as `user_message_persisted` below.
    queueMicrotask(() => {
      const entry = [...session.sessionManager.getEntries()]
        .reverse()
        .find((item) => item.type === "message" && item.message === message);
      if (entry) this.#reasoning.set(entry.id, blocks);
    });
  }

  /** The block currently being streamed, if any — the renderer derives its elapsed time from it. */
  #liveThinkingBlock(conversationId: string): ThinkingTiming | undefined {
    return this.#reasoningRun.get(conversationId)?.blocks.at(-1);
  }

  #clearWidget(key: string): void {
    const timer = this.#widgetTimers.get(key);
    if (timer) clearInterval(timer);
    this.#widgetTimers.delete(key);
    this.#widgetComponents.get(key)?.dispose?.();
    this.#widgetComponents.delete(key);
    this.#widgetSignature.delete(key);
  }

  /**
   * Render a component-factory widget and keep it fresh.
   *
   * Extensions that target a terminal hand `setWidget` a pi-tui component factory
   * (goal's dashboard) rather than text lines. We render it host-side via
   * `renderTuiWidget` and poll, since the component refreshes itself through the
   * TUI it was handed — which is a stub here. An unchanged frame is not re-sent.
   */
  #setComponentWidget(key: string, factory: unknown, placement: string | undefined): void {
    this.#clearWidget(key);
    const component = createTuiWidget(factory);
    if (!component) return;
    this.#widgetComponents.set(key, component);
    const draw = (): void => {
      const runs = renderTuiComponent(component, this.#widgetWidth);
      const signature = JSON.stringify(runs);
      if (this.#widgetSignature.get(key) === signature) return;
      this.#widgetSignature.set(key, signature);
      this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: key, widgetRuns: runs, widgetPlacement: placement });
    };
    draw();
    const timer = setInterval(draw, 1000);
    timer.unref?.();
    this.#widgetTimers.set(key, timer);
  }

  /**
   * FastVibe extends the SDK's UI context with a single-panel multi-question
   * prompt. The built-in `question` tool feature-detects it and falls back to
   * sequential `select`/`input` on hosts that do not provide it (real pi/TUI).
   */
  #extensionUi(): FastVibeExtensionUIContext {
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
      questions: (title, questions, opts) =>
        dialog<Array<string | null> | undefined>("questions", { title, questions, timeout: opts?.timeout }, undefined, opts?.timeout),
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
      setWidget: (key, content, options) => {
        const placement = options?.placement;
        if (content === undefined) {
          this.#clearWidget(key);
          this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: key, widgetPlacement: placement });
          return;
        }
        if (Array.isArray(content)) {
          this.#clearWidget(key);
          this.#emit({ type: "extension_ui_request", id: randomUUID(), method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: placement });
          return;
        }
        this.#setComponentWidget(key, content, placement);
      },
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
  /**
   * Answer every in-flight extension prompt with its fallback. Called when the
   * run is aborted or the engine stops — a hook awaiting a dialog that will
   * never be answered otherwise deadlocks the tool and the whole run.
   */
  #resolvePendingUi(): void {
    for (const [id, pending] of this.#pendingUi) {
      this.#pendingUi.delete(id);
      pending.resolve(pending.fallback);
    }
  }
  #activate(managed: ManagedSession): void { this.#activeId = managed.conversationId; this.#cwd = managed.cwd; this.#catalog.setActive(managed.conversationId); this.#setStatus({ state: "ready", cwd: managed.cwd }); }
  /**
   * The engine's message list carries no ids of its own; the session entry that
   * owns each message does. Reuse those entry ids so the renderer can branch
   * (edit / retry) at the exact point in the session tree, which is also what
   * makes a retry replace its original turn instead of stacking a second copy.
   */
  #messages(session: AgentSession): ChatMessage[] {
    const entryIds = new Map<unknown, string>();
    const timings = new Map<string, ThinkingTiming[]>();
    for (const entry of session.sessionManager.getEntries()) {
      if (entry.type !== "message") continue;
      entryIds.set(entry.message, entry.id);
      const blocks = this.#reasoning.get(entry.id);
      if (blocks) timings.set(entry.id, blocks);
    }
    // Extension custom messages are drawn by their own registered renderer, so the
    // plugin's terminal layout (goal's activity/audit cards) shows up in the GUI.
    const runner = session.extensionRunner;
    const renderCustom = (message: Record<string, unknown>): TuiRun[][] | undefined => {
      const customType = typeof message.customType === "string" ? message.customType : undefined;
      if (!customType) return undefined;
      const renderer = runner.getMessageRenderer(customType);
      if (!renderer) return undefined;
      return renderExtensionMessage(renderer, message, this.#widgetWidth);
    };
    return mapEngineMessages(session.messages, (message) => entryIds.get(message), timings, renderCustom);
  }
  /**
   * Force the SDK to write the session file.
   *
   * The SDK defers the first write until an assistant message exists — a deliberate
   * choice so a conversation with no reply leaves no file, and the reason a restart
   * mid-run otherwise loses the prompt that was just sent. Rewriting the current
   * entries and flipping `flushed` keeps the SDK's own persistence a pure append, so
   * the next assistant message does not rewrite (and duplicate) the header.
   */
  #persist(session: AgentSession): void {
    const manager = session.sessionManager as unknown as {
      persist?: boolean;
      flushed?: boolean;
      _rewriteFile?: () => void;
    };
    if (!manager.persist || !session.sessionFile || typeof manager._rewriteFile !== "function") return;
    try {
      manager._rewriteFile();
      manager.flushed = true;
    } catch {
      // Best effort: never let a disk hiccup break a run.
    }
  }
  #state(session: AgentSession): EngineSessionState { const model = session.model; const usage = session.getContextUsage(); return { model: model ? { provider: model.provider, id: model.id } : undefined, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting, interruptMode: this.#interruptMode, sessionFile: session.sessionFile, sessionId: session.sessionId, sessionName: session.sessionName, messageCount: session.messages.length, queuedMessageCount: session.pendingMessageCount, autoCompactionEnabled: session.autoCompactionEnabled, steeringMode: session.steeringMode, followUpMode: session.followUpMode, contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined }; }
  #opened(conversation: Conversation, messages: ChatMessage[], state: EngineSessionState | null): ConversationOpenResult { return { ...this.#catalog.snapshot(), conversation, messages, state, status: this.#status }; }

  /**
   * Re-point live sessions at the model objects the reloaded registry hands out.
   *
   * After `refresh()` every `Model` is a fresh instance carrying the current
   * endpoint, api and context window; a session still holding the old one would keep
   * calling the previous baseUrl. A run that is mid-flight belongs to the config it
   * started under, so it is flagged and rebound once it lands.
   */
  async #rebindModels(): Promise<void> {
    for (const [id, managed] of this.#sessions) {
      if (managed.session.isStreaming) this.#modelDirty.add(id);
      else await this.#rebindModel(id, managed.session);
    }
  }

  /** Apply a deferred rebind, called once a flagged run ends and before the next prompt. */
  async #flushModelRebind(id: string): Promise<void> {
    if (!this.#modelDirty.has(id)) return;
    const managed = this.#sessions.get(id);
    if (!managed) {
      this.#modelDirty.delete(id);
      return;
    }
    if (managed.session.isStreaming) return;
    await this.#rebindModel(id, managed.session);
  }

  async #rebindModel(id: string, session: AgentSession): Promise<void> {
    this.#modelDirty.delete(id);
    const registry = this.#models;
    const current = session.model;
    if (!registry || !current) return;
    const refreshed = registry.find(current.provider, current.id);
    // Same model, refreshed definition: swap it quietly. A settings edit is not a
    // user model switch, and `setModel()` would append a model_change entry per
    // conversation to every provider edit.
    if (refreshed && refreshed !== current) {
      session.agent.state.model = refreshed;
      session.setThinkingLevel(session.thinkingLevel); // re-clamp to the model's capabilities
      return;
    }
    if (refreshed) return;
    // The model is gone — provider removed, disabled, key cleared, or that model
    // unchecked. Move to the pinned 「默认模型」, else to another model of the user's
    // own providers (never a stray SDK built-in that merely has an env key), and let
    // setModel() record the switch the user did not ask for.
    const pinned = readDefaultModel(this.#paths);
    let fallback = pinned ? registry.find(pinned.provider, pinned.id) : undefined;
    if (!fallback) {
      for (const item of this.#modelsCache ?? []) {
        const candidate = registry.find(item.provider, item.id);
        if (candidate && registry.hasConfiguredAuth(candidate)) {
          fallback = candidate;
          break;
        }
      }
    }
    fallback ??= registry.getAvailable()[0];
    if (!fallback) return;
    try {
      await session.setModel(fallback);
    } catch {
      // No credential for the replacement either: leave the session alone. The next
      // request reports it and the composer offers 「添加模型」.
    }
  }

  /**
   * Apply the user's pinned 「默认模型」 to a conversation that has no history yet.
   *
   * The preference lives in FastVibe's own settings file: the SDK's
   * `defaultProvider`/`defaultModel` keys cannot hold it, because `AgentSession.setModel`
   * rewrites them to the last used model on every switch. Best effort by design — a
   * pin whose provider was removed or whose key is gone leaves the engine default in
   * place rather than blocking the session.
   */
  async #applyPreferredModel(session: AgentSession): Promise<void> {
    const pinned = readDefaultModel(this.#paths);
    if (!pinned) return;
    const model = this.#models?.find(pinned.provider, pinned.id);
    if (!model) return;
    try {
      await session.setModel(model);
    } catch {
      // No credential for it any more (or the model went away): keep the default.
    }
  }

  #setStatus(status: EngineStatus): void { this.#status = status; for (const listener of this.#statusListeners) listener(status); }
  #queue<T>(work: () => Promise<T>): Promise<T> { const next = this.#operation.then(work, work); this.#operation = next.then(() => undefined, () => undefined); return next; }
}
