import { randomUUID } from "node:crypto";
import { execFile } from "node:child_process";
import { unlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { ThinkingLevel } from "@earendil-works/pi-agent-core";
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
  ConversationSearchHit,
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
  ModelPrice,
  NativeProviderConfig,
  PermissionQuestion,
} from "@shared/types";
import { parseCompactCommand } from "@shared/slash";
import { ConversationCatalog } from "../engine/conversation-catalog";
import { searchConversationContent } from "../engine/conversation-search";
import { readDefaultModel } from "../engine/app-settings";
import { mapEngineMessages } from "../engine/map-messages";
import { ReasoningStore } from "../engine/reasoning-store";
import { usageLedgerFor, type UsageLedger } from "../engine/usage-ledger";
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
import { importCcSwitch, scanCcSwitch } from "../engine/cc-switch";
import { catalogPrice } from "../engine/models-dev";
import { priceUsage } from "../engine/pricing";
import { getFastVibePaths, type FastVibePaths } from "../engine/paths";
import { McpManager, type McpServerConfig, type McpServerStatus } from "./mcp-manager";
import { SkillManager } from "./skill-manager";
import { builtinExtensionFile, builtinExtensionPaths, builtinSkillPaths, ExtensionManager } from "./extension-manager";
import { createTuiWidget, renderExtensionMessage, renderTuiComponent, type TuiComponent } from "./tui-bridge";

type ManagedSession = { conversationId: string; cwd: string; session: AgentSession; extensions: LoadExtensionsResult; unsubscribe: () => void };
/** SDK UI context plus FastVibe's single-panel multi-question prompt. */
type FastVibeExtensionUIContext = ExtensionUIContext & {
  questions(title: string, questions: PermissionQuestion[], opts?: { timeout?: number }): Promise<Array<string | null> | undefined>;
  /**
   * Run one subagent role on a throwaway in-process session. Injected here so the
   * built-in subagent extension has a runner on the embedded engine, which ships
   * no `pi` CLI to spawn (see `resources/extensions/subagent/index.ts`).
   */
  runSubagent(request: SubagentHostRequest): Promise<SubagentHostResponse>;
};

type SubagentHostUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: number;
  contextTokens: number;
  turns: number;
};

type SubagentHostRequest = {
  /** `${parentToolCallId}:${index}` — the same id the tool-call tracker mints. */
  subagentId: string;
  agent: string;
  task: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  fallbackModel?: string;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  signal?: AbortSignal;
};

type SubagentHostResponse = {
  messages: unknown[];
  exitCode: number;
  usage: SubagentHostUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
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

function isAssistantEngineMessage(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

/**
 * Roll a throwaway subagent session's transcript into the accounting the tool
 * card shows. Tokens come from each assistant message; the final stop reason and
 * error come from the last one that set them.
 */
function summarizeSubagentMessages(messages: unknown[]): {
  usage: SubagentHostUsage;
  stopReason?: string;
  errorMessage?: string;
} {
  const usage: SubagentHostUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0, contextTokens: 0, turns: 0 };
  let stopReason: string | undefined;
  let errorMessage: string | undefined;
  for (const raw of messages) {
    if (!isRecord(raw) || raw.role !== "assistant") continue;
    usage.turns += 1;
    const messageUsage = isRecord(raw.usage) ? raw.usage : undefined;
    if (messageUsage) {
      usage.input += num(messageUsage.input);
      usage.output += num(messageUsage.output);
      usage.cacheRead += num(messageUsage.cacheRead);
      usage.cacheWrite += num(messageUsage.cacheWrite);
      usage.cost += isRecord(messageUsage.cost) ? num(messageUsage.cost.total) : num(messageUsage.cost);
      const total = num(messageUsage.totalTokens);
      if (total) usage.contextTokens = total;
    }
    if (typeof raw.stopReason === "string") stopReason = raw.stopReason;
    if (typeof raw.errorMessage === "string") errorMessage = raw.errorMessage;
  }
  return { usage, stopReason, errorMessage };
}

function isToolCallPart(type: string): boolean {
  return type === "toolCall" || type === "tool_use" || type === "tool_call" || type === "toolcall";
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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
  #pendingUi = new Map<string, { resolve: (value: unknown) => void; fallback: unknown; conversationId: string }>();
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
  /** Append-only record of finalized turns, so 使用统计 survives session deletion. */
  #usage: UsageLedger;
  #interruptMode: "immediate" | "wait" = "immediate";
  #mcp: McpManager;
  #skills: SkillManager;
  /** pi package installs (extensions), kept in the isolated agentDir. */
  #extensions: ExtensionManager;
  /** Live subagent registry and bounded transcript cache. */
  #subagents = new Map<string, SubagentInfo>();
  #subagentMessages = new Map<string, ChatMessage[]>();
  /** In-flight subagent sessions, keyed by subagent id, so `stop()` can dispose them. */
  #subagentSessions = new Map<string, AgentSession>();

  constructor() {
    this.#paths = getFastVibePaths();
    this.#catalog = new ConversationCatalog(this.#paths.conversationsFile, this.#paths.scratchDir);
    this.#reasoning = new ReasoningStore(this.#paths.reasoningFile);
    this.#usage = usageLedgerFor(this.#paths.usageLedgerFile);
    this.#mcp = new McpManager(this.#paths.mcpFile);
    this.#skills = new SkillManager(this.#paths.agentDir, this.#paths.skillsDir);
    this.#extensions = new ExtensionManager(this.#paths.agentDir, this.#paths.scratchDir);
    const active = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
    this.#cwd = active?.project ?? this.#paths.scratchDir;
  }

  listWorkspace(): WorkspaceSnapshot { return this.#catalog.snapshot(); }
  searchConversations(query: string): Promise<ConversationSearchHit[]> {
    return searchConversationContent(query, this.#catalog.list());
  }
  flush(): void { this.#catalog.flush(); this.#reasoning.flush(); this.#usage.flush(); }
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
        this.#catalog.takeSideChats().map(async (item) => {
          if (!item.sessionFile) return;
          await this.#usage.capture(item.sessionFile);
          await unlink(item.sessionFile).catch(() => undefined);
        }),
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
      await Promise.all(
        [...this.#subagentSessions.values()].map(async (session) => {
          try {
            session.dispose();
          } catch {
            // Already torn down by its runner; nothing left to release.
          }
        }),
      );
      this.#subagentSessions.clear();
      await Promise.all(sessions.map(async (item) => { item.unsubscribe(); this.#persist(item.session); await item.session.dispose(); }));
      this.#models = null;
      this.#runtime = null;
      await this.#mcp.close();
      if (this.#status.state === "ready" || this.#status.state === "starting") this.#setStatus({ state: "idle" });
    });
  }

  async prompt(message: string, options?: { streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> }): Promise<void> {
    const session = await this.#active();
    if (await this.#compactIfCommand(session, message)) return;
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
    if (await this.#compactIfCommand(managed.session, message)) return;
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
    managed.session.setSessionName(conversation.title);
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
    const session = await this.#active();
    const timeout = new Promise<never>((_, reject) => {
      const timer = setTimeout(() => reject(new Error("停止运行超时；会话仍可能在后台运行")), 15_000);
      timer.unref?.();
    });
    try {
      await Promise.race([session.abort(), timeout]);
    } catch (error) {
      // Do not report idle after an uncertain abort. The caller can reopen the
      // session, while the explicit error prevents a follow-up prompt from being
      // sent to a runtime whose termination was not confirmed.
      this.#setStatus({ state: "error", cwd: this.#cwd, message: error instanceof Error ? error.message : "停止运行失败" });
      throw error;
    }
  }
  /**
   * Resume the interrupted turn without a new user message. `agent.continue()`
   * re-enters the loop from the transcript's last user/tool-result message, so a run
   * a user aborted or that failed mid-turn picks up where it stopped.
   *
   * The SDK's own auto-retry first drops the trailing errored assistant message from
   * agent state: `continue()` rejects a transcript whose last message is an
   * assistant, and that message is deliberately kept out of the transcript so the
   * resumed turn does not stack on top of a failed one.
   *
   * Engine-side queued messages are cleared first — the renderer owns the follow-up
   * queue and drains it itself, so a resume must not silently flush it.
   */
  async continueTurn(): Promise<void> {
    this.#resolvePendingUi();
    const session = await this.#active();
    const messages = session.agent.state.messages;
    const last = messages[messages.length - 1];
    if (last?.role === "assistant") {
      const stopReason = (last as { stopReason?: string }).stopReason;
      if (stopReason === "error" || stopReason === "aborted" || stopReason === "length") {
        session.agent.state.messages = messages.slice(0, -1);
      }
    }
    await session.agent.continue();
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
    const builtins: SlashCommand[] = [{ name: "compact", description: "压缩当前会话的上下文", source: "builtin" }];
    const unique = new Map<string, SlashCommand>();
    for (const command of [...promptCommands, ...extensionCommands, ...builtins]) unique.set(command.name, command);
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
  async getSubagentMessages(subagentId: string): Promise<ChatMessage[]> {
    return this.#subagentMessages.get(subagentId)?.slice() ?? [];
  }
  async getSubagents(): Promise<SubagentInfo[]> {
    return [...this.#subagents.values()].sort((a, b) => (b.startedAt ?? 0) - (a.startedAt ?? 0));
  }
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

  renameConversation(id: string, title: string): WorkspaceSnapshot {
    const trimmed = title.trim();
    if (trimmed) {
      this.#catalog.update(id, { title: trimmed, titleManual: true });
      const active = this.#sessions.get(id);
      if (active) active.session.setSessionName(trimmed);
    }
    return this.#catalog.snapshot();
  }
  async deleteConversation(id: string): Promise<ConversationDeleteResult> {
    const children = this.#catalog.listAll().filter((item) => item.parentId === id && item.kind === "side-chat");
    for (const child of children) await this.deleteConversation(child.id);
    const wasActive = this.#catalog.activeId === id;
    const removed = this.#catalog.remove(id);
    if (removed?.sessionFile) {
      // Fold the transcript into the usage ledger *before* unlinking it: a turn the
      // live hook never saw (history from before the ledger existed, or a run that
      // ended outside this process) still counts after the file is gone.
      await this.#usage.capture(removed.sessionFile);
      await unlink(removed.sessionFile).catch(() => undefined);
    }
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
  recordPrompt(id: string, text: string): WorkspaceSnapshot {
    const preview = text.trim().slice(0, 80);
    const current = this.#catalog.get(id);
    const keepTitle =
      Boolean(current?.titleManual) ||
      Boolean(current?.title && current.title !== "新会话" && current.title !== "新任务");
    const title = keepTitle && current?.title ? current.title : preview.slice(0, 24) || "新会话";
    this.#catalog.update(id, { title, preview });
    // Leave `sessionName` empty so the session-title extension can generate one.
    return this.#catalog.snapshot();
  }
  addProject(cwd: string): ProjectAddResult { const project = this.#catalog.ensureProject(cwd); if (!project) throw new Error("invalid project"); return { ...this.#catalog.snapshot(), project }; }
  renameProject(cwd: string, name: string): WorkspaceSnapshot { this.#catalog.renameProject(cwd, name); return this.#catalog.snapshot(); }
  reorderProjects(cwds: string[]): WorkspaceSnapshot { this.#catalog.reorderProjects(cwds); return this.#catalog.snapshot(); }
  async removeProject(cwd: string): Promise<ConversationDeleteResult> { const wasActive = this.#catalog.get(this.#catalog.activeId ?? "")?.project === cwd; const removed = this.#catalog.removeProject(cwd); await Promise.all(removed.map(async (item) => { if (item.sessionFile) { await this.#usage.capture(item.sessionFile); await unlink(item.sessionFile).catch(() => undefined); } if (item.worktree) await this.#removeWorktree(item.worktree.path); const managed = this.#sessions.get(item.id); if (managed) { managed.unsubscribe(); await managed.session.dispose(); this.#sessions.delete(item.id); } })); return { ...this.#catalog.snapshot(), nextId: wasActive ? (this.#catalog.activeId ?? null) : null }; }
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
  async scanCcSwitch() { return scanCcSwitch(this.#paths); }
  async importCcSwitch(ids: string[]): Promise<ProviderConfig[]> { await importCcSwitch(this.#paths, ids); await this.reloadProviders(); return this.listProviders(); }
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

  /**
   * Worktree isolation is kept even though its only caller (the parallel-run
   * dialog) is gone: `Conversation.worktree` and `#removeWorktree` still clean up
   * conversations an earlier build isolated, so new creation stays next to them.
   */
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
    // (`plan`, `goal`, `todo`, session-title) alongside whatever the user installed. `createAgentSession`
    // only auto-reloads a loader it creates, so reload ours before handing it over.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.#paths.agentDir,
      settingsManager,
      additionalExtensionPaths: builtinExtensionPaths(),
      additionalSkillPaths: builtinSkillPaths(),
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
      uiContext: this.#extensionUi(conversation.id),
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
      // File the finished turn in the usage ledger, so 使用统计 outlives the transcript
      // if this conversation is later deleted.
      if (event.type === "message_end" && isAssistantEngineMessage(event.message)) {
        this.#recordUsage(event.message, result.session, now);
      }
      if (event.type === "session_info_changed") {
        this.#applySessionTitle(conversation.id, event.name);
      }
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
  #emit(event: Record<string, unknown>): void {
    this.#trackSubagentEvent(event);
    for (const listener of this.#eventListeners) listener(event);
  }
  #trackSubagentEvent(event: Record<string, unknown>): void {
    const type = typeof event.type === "string" ? event.type : "";
    if (type === "tool_execution_start" || type === "toolcall_start") {
      const toolName = String(event.toolName ?? event.name ?? "").toLowerCase();
      if (toolName === "subagent") {
        const args = (event.args ?? event.arguments) as Record<string, unknown> | undefined;
        const callId = String(event.toolCallId ?? event.tool_call_id ?? event.id ?? randomUUID());
        const conversationId = typeof event.conversationId === "string" ? event.conversationId : undefined;
        const entries: Array<{ agent: string; task?: string; mode: string }> = [];
        if (typeof args?.agent === "string") entries.push({ agent: args.agent, task: typeof args.task === "string" ? args.task : undefined, mode: "single" });
        if (Array.isArray(args?.tasks)) for (const item of args.tasks) if (item && typeof item === "object" && typeof (item as Record<string, unknown>).agent === "string") entries.push({ agent: String((item as Record<string, unknown>).agent), task: typeof (item as Record<string, unknown>).task === "string" ? String((item as Record<string, unknown>).task) : undefined, mode: "parallel" });
        if (Array.isArray(args?.chain)) for (const item of args.chain) if (item && typeof item === "object" && typeof (item as Record<string, unknown>).agent === "string") entries.push({ agent: String((item as Record<string, unknown>).agent), task: typeof (item as Record<string, unknown>).task === "string" ? String((item as Record<string, unknown>).task) : undefined, mode: "chain" });
        for (const [index, item] of entries.entries()) {
          const id = `${callId}:${index}`;
          this.#subagents.set(id, { id, conversationId, agent: item.agent, name: item.agent, mode: item.mode, status: "running", detail: item.task, startedAt: Date.now() });
        }
      }
      return;
    }
    if (type === "tool_execution_end" || type === "toolcall_end") {
      const toolName = String(event.toolName ?? event.name ?? "").toLowerCase();
      if (toolName === "subagent") {
        const callId = String(event.toolCallId ?? event.tool_call_id ?? event.id ?? "");
        for (const [id, item] of this.#subagents) if (id.startsWith(`${callId}:`)) this.#subagents.set(id, { ...item, status: event.isError ? "error" : "completed", endedAt: Date.now(), error: event.isError ? String(event.error ?? "执行失败") : item.error });
      }
      return;
    }
    if (type !== "subagent_lifecycle" && type !== "subagent_progress" && type !== "subagent_event") return;
    const id = typeof event.subagentId === "string" ? event.subagentId : typeof event.id === "string" ? event.id : "";
    if (!id) return;
    const previous = this.#subagents.get(id);
    const status = typeof event.status === "string" ? event.status : previous?.status;
    const nested = event.event && typeof event.event === "object" ? event.event as Record<string, unknown> : undefined;
    const nestedType = typeof nested?.type === "string" ? nested.type : "";
    const now = Date.now();
    const next: SubagentInfo = {
      ...previous,
      id,
      agent: typeof event.agent === "string" ? event.agent : previous?.agent,
      name: typeof event.name === "string" ? event.name : previous?.name,
      description: typeof event.description === "string" ? event.description : previous?.description,
      mode: typeof event.mode === "string" ? event.mode : previous?.mode,
      status: status ?? (nestedType === "agent_end" ? "completed" : "running"),
      detail: typeof event.detail === "string" ? event.detail : typeof event.progress === "string" ? event.progress : previous?.detail,
      progress: typeof event.progress === "number" ? event.progress : previous?.progress,
      startedAt: previous?.startedAt ?? now,
      endedAt: nestedType === "agent_end" || status === "completed" || status === "error" ? now : previous?.endedAt,
      error: typeof event.error === "string" ? event.error : previous?.error,
    };
    this.#subagents.set(id, next);
    if (nested && nestedType === "message_end" && nested.message && typeof nested.message === "object") {
      const message = nested.message as Record<string, unknown>;
      const text = typeof message.content === "string" ? message.content : typeof message.text === "string" ? message.text : "";
      if (text) {
        const item: ChatMessage = { id: `${id}-${now}`, role: "assistant", text, tools: [], createdAt: now };
        const list = this.#subagentMessages.get(id) ?? [];
        this.#subagentMessages.set(id, [...list, item].slice(-200));
      }
    }
  }
  /**
   * The session-title extension names a chat via `setSessionName`. Apply it to
   * the catalog unless the user already renamed this conversation by hand.
   */
  #applySessionTitle(id: string, name: string | undefined): void {
    const title = name?.trim();
    if (!title) return;
    const current = this.#catalog.get(id);
    if (!current || current.titleManual || current.title === title) return;
    this.#catalog.update(id, { title });
    this.#emit({ type: "conversation_renamed", conversationId: id, title, snapshot: this.#catalog.snapshot() });
  }
  /** True when the active conversation has a run in flight (`agent_end` clears it). */
  #isLive(): boolean { return this.#activeId !== null && this.#running.get(this.#activeId) === true; }
  /**
   * Send a plain turn, first waiting out any run the SDK still reports as
   * streaming (it flips `isStreaming` only after `agent_end` listeners and
   * auto-compaction settle). Without this a follow-up that the UI considers
   * "after completion" throws "Agent is already processing".
   */
  async #promptWhenIdle(session: AgentSession, message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    if (await this.#compactIfCommand(session, message)) return;
    if (session.isStreaming) await session.agent.waitForIdle();
    await session.prompt(message, { images });
  }
  /**
   * `/compact` is a TUI builtin, not an SDK prompt. Intercept it so the composer
   * slash palette (and a typed `/compact keep X`) actually compact instead of
   * sending the slash line to the model.
   */
  async #compactIfCommand(session: AgentSession, message: string): Promise<boolean> {
    const command = parseCompactCommand(message);
    if (!command) return false;
    await session.compact(command.instructions);
    return true;
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

  /**
   * File a finished assistant turn in the usage ledger.
   *
   * The ledger exists so 使用统计 does not change when a conversation is deleted: the
   * transcript that would otherwise be the record is unlinked, so each turn is copied
   * here as it lands. `at` is the message's own timestamp (request start), matching what
   * `parseSessionTurns` reads out of the transcript, and the entry id is resolved a
   * microtask later because the SDK appends the entry once its listeners return.
   */
  #recordUsage(
    message: unknown,
    session: AgentSession,
    now: number,
  ): void {
    if (!isAssistantEngineMessage(message)) return;
    // Keep an untyped handle for the identity comparison: `message` narrows to a record
    // above, while the stored entry's `message` stays an `AgentMessage`.
    const messageRef: unknown = message;
    const sessionId = session.sessionId;
    if (!sessionId) return;
    const usage = isRecord(message.usage) ? message.usage : undefined;
    const input = num(usage?.input);
    const output = num(usage?.output);
    const cacheRead = num(usage?.cacheRead);
    const cacheWrite = num(usage?.cacheWrite);
    const reported = usage ? num(usage.totalTokens) : 0;
    const cost = usage && isRecord(usage.cost) ? num(usage.cost.total) : 0;
    const at = num(message.timestamp) || now;
    const provider = typeof message.provider === "string" ? message.provider : "未知";
    const model = typeof message.model === "string" ? message.model : "未知";
    let toolCalls = 0;
    if (Array.isArray(message.content)) {
      for (const part of message.content) {
        if (isRecord(part) && isToolCallPart(String(part.type ?? ""))) toolCalls += 1;
      }
    }
    queueMicrotask(() => {
      const entry = [...session.sessionManager.getEntries()]
        .reverse()
        .find((item) => item.type === "message" && item.message === messageRef);
      if (!entry) return;
      this.#usage.record([
        {
          sessionId,
          entryId: entry.id,
          provider,
          model,
          at,
          input,
          output,
          cacheRead,
          cacheWrite,
          tokens: reported || input + output + cacheRead + cacheWrite,
          cost,
          toolCalls,
        },
      ]);
    });
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
  #setComponentWidget(conversationId: string, key: string, factory: unknown, placement: string | undefined): void {
    const scopedKey = `${conversationId}:${key}`;
    this.#clearWidget(scopedKey);
    const component = createTuiWidget(factory);
    if (!component) return;
    this.#widgetComponents.set(scopedKey, component);
    const draw = (): void => {
      const runs = renderTuiComponent(component, this.#widgetWidth);
      const signature = JSON.stringify(runs);
      if (this.#widgetSignature.get(scopedKey) === signature) return;
      this.#widgetSignature.set(scopedKey, signature);
      this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "setWidget", widgetKey: key, widgetRuns: runs, widgetPlacement: placement });
    };
    draw();
    const timer = setInterval(draw, 1000);
    timer.unref?.();
    this.#widgetTimers.set(scopedKey, timer);
  }

  /**
   * FastVibe extends the SDK's UI context with a single-panel multi-question
   * prompt. The built-in `question` tool feature-detects it and falls back to
   * sequential `select`/`input` on hosts that do not provide it (real pi/TUI).
   */
  /**
   * Run one subagent role to completion on a throwaway session.
   *
   * The whole point is context isolation: the role gets its own session, its own
   * system prompt and only the tools its definition allows, and streams its
   * events back under `subagent_event` so the right pane can show the transcript.
   * A throwaway `DefaultResourceLoader` loads no FastVibe extension (no recursion,
   * no plan/goal) except the permission sandbox, so a delegated `bash`/`edit` is
   * still gated by the user's current mode.
   */
  async #runSubagent(conversationId: string, request: SubagentHostRequest): Promise<SubagentHostResponse> {
    if (!this.#runtime || !this.#models) throw new Error("engine not ready");
    const cwd = request.cwd || this.#cwd;
    const settingsManager = SettingsManager.create(cwd, this.#paths.agentDir);
    const sandbox = builtinExtensionFile("permission-sandbox.ts");
    const loader = new DefaultResourceLoader({
      cwd,
      agentDir: this.#paths.agentDir,
      settingsManager,
      noExtensions: true,
      noThemes: true,
      noPromptTemplates: true,
      noSkills: true,
      ...(sandbox ? { additionalExtensionPaths: [sandbox] } : {}),
      ...(request.systemPrompt.trim() ? { appendSystemPrompt: [request.systemPrompt] } : {}),
    });
    await loader.reload();

    // The user's 「默认模型」 (设置 → 供应商) is the model for every delegated run,
    // independent of which model the parent chat happens to be on. Falls back to the
    // parent session's model only when that preference is unset or unusable.
    const preferred = readDefaultModel(this.#paths);
    const model = this.#resolveSubagentModel(
      preferred ? `${preferred.provider}/${preferred.id}` : undefined,
      request.fallbackModel ?? request.model,
    );
    const tools =
      request.tools && request.tools.length > 0
        ? request.tools
        : ["read", "bash", "edit", "write", "grep", "find", "ls"];
    const { subagentId } = request;
    const lifecycle = (status: string, error?: string): void => {
      this.#emit({ type: "subagent_lifecycle", subagentId, conversationId, agent: request.agent, name: request.agent, status, detail: request.task, ...(error ? { error } : {}) });
    };
    lifecycle("running");

    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    const onAbort = (): void => {
      void session?.abort().catch(() => undefined);
    };
    let thrown: string | undefined;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let messages: unknown[] = [];
    let summary = summarizeSubagentMessages([]);
    let usedModel = model ? `${model.provider}/${model.id}` : undefined;
    try {
      const created = await createAgentSession({
        cwd,
        agentDir: this.#paths.agentDir,
        modelRuntime: this.#runtime,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
        resourceLoader: loader,
        tools,
        ...(model ? { model } : {}),
        ...(request.thinkingLevel ? { thinkingLevel: request.thinkingLevel } : {}),
      });
      session = created.session;
      // Bind the parent's UI so the sandbox's `confirm` renders in the same
      // composer panel as a main-tool approval, and `hasUI` is true for the hook.
      await session.bindExtensions({ mode: "rpc", uiContext: this.#extensionUi(conversationId) });
      this.#subagentSessions.set(subagentId, session);
      unsubscribe = session.subscribe((event) => {
        this.#emit({
          type: "subagent_event",
          subagentId,
          conversationId,
          event: slimStreamEvent(event as unknown as Record<string, unknown>),
        });
      });
      if (request.signal) {
        if (request.signal.aborted) onAbort();
        else request.signal.addEventListener("abort", onAbort, { once: true });
      }
      await session.prompt(request.task);
    } catch (error) {
      thrown = error instanceof Error ? error.message : String(error);
    }
    request.signal?.removeEventListener("abort", onAbort);
    unsubscribe?.();
    if (session) {
      messages = session.messages.slice();
      summary = summarizeSubagentMessages(messages);
      if (session.model) usedModel = `${session.model.provider}/${session.model.id}`;
    }
    stopReason = thrown ? "error" : summary.stopReason;
    errorMessage = thrown ?? summary.errorMessage;
    const failed = stopReason === "error" || stopReason === "aborted";
    lifecycle(failed ? "error" : "completed", errorMessage);
    this.#subagentSessions.delete(subagentId);
    session?.dispose();

    return {
      messages,
      exitCode: failed ? 1 : 0,
      usage: summary.usage,
      model: usedModel,
      stopReason,
      errorMessage,
    };
  }

  /**
   * Resolve a subagent's model: the pin (the user's 默认模型), else the fallback
   * (the parent session's model).
   *
   * A pin is only honored when this install can actually authenticate it: the
   * catalog (`getAll()`) carries every reseller's models, and a pin that points at
   * an unreachable vendor would otherwise be picked and fail the whole delegation
   * with "No API key found". A pin may omit its provider; an id with no usable auth
   * falls back instead of failing.
   */
  #resolveSubagentModel(spec?: string, fallback?: string): ReturnType<ModelRegistry["find"]> {
    const registry = this.#models;
    if (!registry) return undefined;
    const usable = (model: ReturnType<ModelRegistry["find"]>) =>
      Boolean(model) && registry.hasConfiguredAuth(model!);
    const bySpec = (value?: string): ReturnType<ModelRegistry["find"]> => {
      if (!value) return undefined;
      const slash = value.indexOf("/");
      const direct = slash > 0 ? registry.find(value.slice(0, slash), value.slice(slash + 1)) : undefined;
      if (usable(direct)) return direct;
      // Bare ids (`claude-haiku-4-5`) resolve against the authenticated models only,
      // so a role's vendor default can never outrank the user's working model.
      return registry.getAvailable().find((item) => item.id === value);
    };
    return bySpec(spec) ?? bySpec(fallback);
  }

  #extensionUi(conversationId: string): FastVibeExtensionUIContext {
    // Keep the editor mirror per extension session. This is useful to plugins that
    // compose a prompt in several calls, while the renderer remains the source of
    // truth for normal composer typing.
    let editorText = "";
    const dialog = <T>(method: string, request: Record<string, unknown>, fallback: T, timeout?: number): Promise<T> => {
      const id = randomUUID();
      return new Promise<T>((resolve) => {
        const timer = timeout && timeout > 0 ? setTimeout(() => {
          this.#pendingUi.delete(id);
          resolve(fallback);
        }, timeout) : undefined;
        this.#pendingUi.set(id, { fallback, conversationId, resolve: (value) => { if (timer) clearTimeout(timer); resolve(value as T); } });
        this.#emit({ type: "extension_ui_request", id, conversationId, method, ...request });
      });
    };
    return {
      select: (title, options, opts) => dialog<string | undefined>("select", { title, options, timeout: opts?.timeout }, undefined, opts?.timeout),
      questions: (title, questions, opts) =>
        dialog<Array<string | null> | undefined>("questions", { title, questions, timeout: opts?.timeout }, undefined, opts?.timeout),
      runSubagent: (request) => this.#runSubagent(conversationId, request),
      confirm: (title, message, opts) => dialog("confirm", { title, message, timeout: opts?.timeout }, false, opts?.timeout),
      input: (title, placeholder, opts) => dialog("input", { title, placeholder, timeout: opts?.timeout }, undefined, opts?.timeout),
      editor: (title, prefill) => dialog("editor", { title, prefill }, undefined),
      notify: (message, type) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "notify", message, notifyType: type }); },
      onTerminalInput: () => () => undefined,
      setStatus: (key, text) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "setStatus", statusKey: key, statusText: text }); },
      setWorkingMessage: () => undefined,
      setWorkingVisible: () => undefined,
      setWorkingIndicator: () => undefined,
      setHiddenThinkingLabel: () => undefined,
      setWidget: (key, content, options) => {
        const placement = options?.placement;
        const scopedKey = `${conversationId}:${key}`;
        if (content === undefined) {
          this.#clearWidget(scopedKey);
          this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "setWidget", widgetKey: key, widgetPlacement: placement });
          return;
        }
        if (Array.isArray(content)) {
          this.#clearWidget(scopedKey);
          this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "setWidget", widgetKey: key, widgetLines: content, widgetPlacement: placement });
          return;
        }
        this.#setComponentWidget(conversationId, key, content, placement);
      },
      setFooter: () => undefined,
      setHeader: () => undefined,
      setTitle: (title) => { this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "setTitle", title }); },
      custom: async <T>() => {
        throw new Error("FastVibe 不支持 ctx.ui.custom()；请使用 ctx.ui.select()、confirm()、input()、editor() 或 questions()");
      },
      pasteToEditor: (text) => { editorText = text; this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "set_editor_text", text }); },
      setEditorText: (text) => { editorText = text; this.#emit({ type: "extension_ui_request", id: randomUUID(), conversationId, method: "set_editor_text", text }); },
      getEditorText: () => editorText,
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
