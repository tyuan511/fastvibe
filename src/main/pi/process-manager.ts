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
  CompactReason,
  Conversation,
  ConversationDeleteResult,
  ConversationOpenResult,
  ConversationReadyEvent,
  ConversationSearchHit,
  ExtensionInfo,
  ExtensionPackage,
  FastVibeModel,
  EngineModel,
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
  ImportCandidate,
  ImportRunResult,
  ImportSourceId,
  ImportSourceStatus,
} from "@shared/types";
import { parseCompactCommand } from "@shared/slash";
import { ConversationCatalog } from "../engine/conversation-catalog";
import { searchConversationContent } from "../engine/conversation-search";
import {
  importSessions as runImport,
  keyOf,
  scanImportCandidates,
  scanImportSources,
} from "../engine/import/runner";
import { readAutoCompact, readDefaultModel } from "../engine/app-settings";
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
import { bindBrowserConversation } from "./browser-bridge";
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
function sessionEntryIds(session: AgentSession): Map<unknown, string> {
  const ids = new Map<unknown, string>();
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type === "message") ids.set(entry.message, entry.id);
  }
  return ids;
}

/**
 * The instant each message's session entry was persisted, keyed by entry id.
 *
 * An entry is appended once its message has finished streaming, so its timestamp is
 * the reply's *end* — the engine's own message timestamp is only the request start.
 * That is what lets a reply's footer report when it finished and how long it took.
 * User and tool-result entries are written at the same instant they happened, so the
 * distinction only matters for an assistant reply (`mapEngineMessages` applies it
 * there alone).
 */
function sessionCompletionTimes(session: AgentSession): Map<string, number> {
  const times = new Map<string, number>();
  for (const entry of session.sessionManager.getEntries()) {
    if (entry.type !== "message") continue;
    const at = Date.parse(entry.timestamp);
    if (Number.isFinite(at)) times.set(entry.id, at);
  }
  return times;
}

function isUserEngineMessage(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "user";
}

function isAssistantEngineMessage(message: unknown): message is Record<string, unknown> {
  return typeof message === "object" && message !== null && (message as { role?: unknown }).role === "assistant";
}

const COMPACT_REASONS: ReadonlySet<string> = new Set<CompactReason>(["manual", "threshold", "overflow"]);

/**
 * Why a `compaction_start` event compacted, when it is a reason the card knows.
 *
 * The transcript's card labels 接近上限 / 超出窗口, so the engine has to carry the
 * reason it later serves with the running card it rebuilds on re-open.
 */
function compactReasonOf(event: { reason?: unknown }): CompactReason | undefined {
  const reason = typeof (event as { reason?: unknown }).reason === "string" ? (event as { reason: string }).reason : undefined;
  return reason && COMPACT_REASONS.has(reason) ? (reason as CompactReason) : undefined;
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
  /**
   * Conversations with a compaction in flight, and why it was started.
   *
   * The SDK compacts *inside* a run after a turn overflowed, and it also compacts on
   * demand with no run at all (`/compact`, and the threshold check a fresh prompt
   * runs before it is sent). The second kind is the reason this map exists: there is
   * no run flag to speak for it, and the renderer still has to know the conversation
   * is busy — and to show the 正在压缩上下文 card again after a chat switch or a
   * reload. It also covers the window before `compaction_start` lands, which opens
   * after the SDK has already prepared the summary request.
   */
  #compacting = new Map<string, CompactReason | undefined>();
  /**
   * The last 「this conversation is working」 value the renderer was told.
   *
   * `conversation_running` carries the union of a run and a compaction, so what to
   * broadcast is compared against this — not against `#running`, which knows only
   * half of it.
   */
  #busyBroadcast = new Map<string, boolean>();
  /** Conversations whose session must be re-pointed at the reloaded model registry once its run lands. */
  #modelDirty = new Set<string>();
  /**
   * Model and thinking level the user picked while no conversation existed.
   *
   * The empty hero offers the composer's model and thinking chips before anything has
   * been sent, and there is no session to bind the choice to. Refusing the switch
   * would leave the first pick a new user makes — the one that decides what they are
   * about to talk to — as an error banner, so hold it here instead and adopt it into
   * the session that pick is about (the next one created). Kept as a reference rather
   * than a `Model`, so a provider edit between the pick and the first prompt cannot
   * pin a stale object.
   */
  #pendingModel: EngineModel | undefined;
  #pendingThinking: string | undefined;
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
      for (const [id, busy] of this.#busyBroadcast) {
        if (busy) this.#emit({ type: "conversation_running", conversationId: id, running: false });
      }
      this.#running.clear();
      this.#compacting.clear();
      this.#busyBroadcast.clear();
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
    // A caller may consider the run over and still land inside the settle window —
    // an `agent_end` the SDK is about to retry, compact, or continue. The session is
    // not idle across any of it, and a plain prompt there throws ("Agent is already
    // processing"; "Cannot submit a prompt while compaction is in progress" for a
    // standalone `/compact`, which has no run at all), so wait it out.
    if (!session.isIdle && !options?.streamingBehavior) await session.waitForIdle();
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
    if (managed) return this.#messages(managed.session, id);
    const conversation = this.#catalog.get(id);
    if (!conversation) return [];
    await this.#ensureReady();
    const created = await this.#ensureSession(conversation);
    return this.#messages(created.session, id);
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
    const state = this.#state(managed.session, conversation.id);
    const updated =
      this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
    return this.#opened(updated, [], state);
  }
  async steer(message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    const session = await this.#active();
    // Steering is only drained between turns of a live run. `#isLive()` spans the
    // whole run — including the window between an `agent_end` and the `agent_start`
    // the SDK still owes it (a retry, a compaction, a queued continuation) — so a
    // steer parked in that window is picked up by that continuation rather than
    // being sent to a runtime that has already stopped.
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
  /**
   * Rebuild the engine's steering queue from the items FastVibe still wants
   * injected. Used when the user 撤回 / 删除 a 发送中 row: the SDK has no
   * per-message cancel, so we clear and re-steer the survivors.
   */
  async replaceSteering(
    items: Array<{ text: string; images?: Array<{ type: "image"; data: string; mimeType: string }> }>,
  ): Promise<void> {
    const session = await this.#active();
    session.clearQueue();
    for (const item of items) await session.steer(item.text, item.images);
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
    // promise pending would hang the tool, keep the run from ever settling and pin
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
   * Resume the interrupted turn without a new user message. The loop re-enters from
   * the transcript's last user/tool-result message, so a run a user aborted or that
   * failed mid-turn picks up where it stopped.
   *
   * The trailing errored assistant message is dropped from agent state first: a
   * continuation rejects a transcript whose last message is an assistant, and that
   * failed attempt is deliberately kept out of the running transcript so the resumed
   * turn does not stack on top of it.
   *
   * The resume goes through the SDK's run wrapper, not the bare `agent.continue()`
   * loop — see `#runContinuation`. A resume is half a turn, but it is still a *run*,
   * and the events only that wrapper emits are what every watcher reads.
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
    await this.#runContinuation(session);
  }
  /**
   * Drive a resumed turn the way the SDK drives a run.
   *
   * `agent.continue()` is a bare loop: a run's *lifecycle* lives one level up, in the
   * SDK's own run wrapper, which is what emits `agent_settled` — the only event that
   * ends a run, and the one Main, the sidebar's 运行中 mark, 运行时保持唤醒 and the
   * composer's 停止/继续 control all key off — and what applies the post-run policy
   * (auto-retry and its backoff, auto-compaction, continuations an extension queued).
   * Calling the raw loop instead broke a resumed run in two ways at once: nothing ever
   * cleared the run flag, so the conversation stayed 运行中 until some *unrelated* run
   * settled it; and its own `agent_end` reported `willRetry: true` for a retry that
   * nothing would perform, which told the renderer the failure was transient — so a
   * 502 mid-resume left the composer stuck on 停止 with no 继续 button at all.
   *
   * An empty message list is the continuation: the loop still starts from the
   * transcript's last user/tool-result message, with everything the SDK wraps around a
   * run kept intact. The wrapper is private (0.85.1 has no public entry point for
   * continuing an interrupted turn), hence the cast — so a version that renames it must
   * fail loudly here rather than silently go back to driving runs by hand.
   */
  async #runContinuation(session: AgentSession): Promise<void> {
    const run = (session as unknown as { _runAgentPrompt?: (messages: unknown[]) => Promise<void> })._runAgentPrompt;
    if (typeof run !== "function") throw new Error("当前引擎版本不支持继续运行");
    await run.call(session, []);
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
    // Commands come from the session's prompt templates and extensions, so an empty
    // hero has none to list rather than an error to report.
    const session = await this.#activeSession();
    if (!session) return [];
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

  /**
   * Other agents on this machine that FastVibe can pull sessions from (设置 → 导入).
   *
   * Scanning happens per pane open and is read-only throughout: the other agents' data
   * directories are never written to, and every import is a *copy* of the converted
   * transcript into FastVibe's own sessions directory — see
   * `docs/import-from-other-agents.md`.
   */
  async importSources(): Promise<ImportSourceStatus[]> { return scanImportSources(); }

  async importCandidates(source: ImportSourceId): Promise<ImportCandidate[]> {
    return scanImportCandidates(source, this.#importedKeys());
  }

  async importSessions(source: ImportSourceId, ids: string[]): Promise<ImportRunResult> {
    return runImport({ paths: this.#paths, catalog: this.#catalog, source, ids });
  }

  /** Sessions already imported, keyed `source:sourceId`, so the picker can mark them. */
  #importedKeys(): Set<string> {
    const keys = new Set<string>();
    for (const conversation of this.#catalog.listAll()) {
      if (conversation.importedFrom) keys.add(keyOf(conversation.importedFrom.source, conversation.importedFrom.sourceId));
    }
    return keys;
  }
  async getSubagentMessages(subagentId: string): Promise<ChatMessage[]> {
    const live = this.#subagentSessions.get(subagentId);
    if (live) {
      // The live pane draws the store's per-run stream, not this, but the mapping
      // still carries the entry ids and completion times so a mid-run read agrees
      // with the cached transcript written at the end.
      const entryIds = sessionEntryIds(live);
      return mapEngineMessages(
        live.messages,
        (message) => entryIds.get(message),
        undefined,
        undefined,
        sessionCompletionTimes(live),
      );
    }
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
      const state = this.#state(managed.session, id);
      const messages = this.#messages(managed.session, id);
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
    this.#clearBusy(id);
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
    // The session is gone, so no `agent_settled` will ever arrive for it.
    this.#clearBusy(id);
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
  async removeProject(cwd: string): Promise<ConversationDeleteResult> { const wasActive = this.#catalog.get(this.#catalog.activeId ?? "")?.project === cwd; const removed = this.#catalog.removeProject(cwd); await Promise.all(removed.map(async (item) => { if (item.sessionFile) { await this.#usage.capture(item.sessionFile); await unlink(item.sessionFile).catch(() => undefined); } if (item.worktree) await this.#removeWorktree(item.worktree.path); const managed = this.#sessions.get(item.id); if (managed) { managed.unsubscribe(); await managed.session.dispose(); this.#sessions.delete(item.id); } this.#clearBusy(item.id); })); return { ...this.#catalog.snapshot(), nextId: wasActive ? (this.#catalog.activeId ?? null) : null }; }
  async loadMessages(): Promise<ChatMessage[]> { const session = await this.#active(); return this.#messages(session, this.#activeId ?? undefined); }
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
  async setModel(provider: string, modelId: string): Promise<EngineSessionState> {
    await this.#ensureReady();
    const model = this.#models?.find(provider, modelId);
    if (!model) throw new Error("模型不存在");
    const session = await this.#activeSession();
    if (!session) {
      this.#pendingModel = { provider, id: modelId };
      return this.#draftState();
    }
    // Re-picking what is already selected is not a switch. The SDK appends a
    // `model_change` entry regardless, and the transcript draws a divider for every
    // one of them — 「A/x → A/x」 for a choice the user never changed.
    const current = session.model;
    if (current && current.provider === model.provider && current.id === model.id) {
      return this.#state(session, this.#activeId ?? undefined);
    }
    await this.#useModel(session, model);
    return this.#state(session, this.#activeId ?? undefined);
  }
  /**
   * Switch one session's model.
   *
   * The SDK records the pick as a `model_change` session entry, but nothing is
   * announced from here: choosing a model is not using one, and a divider drawn on
   * the pick said a switch had happened in the conversation while the next reply was
   * still free to be written by the previous model (or the pick to be reverted).
   * `#announceModelUse` emits it from the assistant `message_start` that actually
   * runs on the new model, which is the moment the divider is true.
   */
  async #useModel(
    session: AgentSession,
    model: Parameters<AgentSession["setModel"]>[0],
  ): Promise<void> {
    await session.setModel(model);
  }
  /**
   * Announce a model switch at the moment the new model actually answers.
   *
   * The transcript can say *where* a switch sits in the branch, but not whether it was
   * ever used: a `model_change` entry is written the instant the pick is made, so a
   * switch that nothing followed (or one reverted before the next prompt) drew a
   * divider for a run that never happened. The reply carries its own `provider`/`model`,
   * so the announcement is made from the assistant `message_start` — and the model to
   * compare against is the last assistant message already in the transcript, which
   * makes picking A, then B, then A again before sending announce nothing at all.
   *
   * The first reply of a conversation has no predecessor and is not a switch — the
   * model it starts on is the one the chat was created with, and it is already named
   * on the composer's chip.
   */
  #announceModelUse(
    conversationId: string,
    session: AgentSession,
    message: Record<string, unknown>,
  ): void {
    const provider = typeof message.provider === "string" ? message.provider : undefined;
    const id = typeof message.model === "string" ? message.model : undefined;
    if (!provider || !id) return;
    let previous: EngineModel | undefined;
    for (let index = session.messages.length - 1; index >= 0; index -= 1) {
      const item: unknown = session.messages[index];
      if (!isRecord(item) || item.role !== "assistant") continue;
      if (typeof item.provider !== "string" || typeof item.model !== "string") break;
      previous = { provider: item.provider, id: item.model };
      break;
    }
    if (!previous) return;
    if (previous.provider === provider && previous.id === id) return;
    this.#emit({ type: "model_changed", conversationId, model: { provider, id }, previous });
  }
  async setInterruptMode(mode: "immediate" | "wait"): Promise<EngineSessionState> { this.#interruptMode = mode; return this.getState(); }
  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<EngineSessionState> { (await this.#active()).setSteeringMode(mode); return this.getState(); }
  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<EngineSessionState> { (await this.#active()).setFollowUpMode(mode); return this.getState(); }
  async exportHtml(): Promise<string | undefined> { return (await this.#active()).exportToHtml(); }
  async setAutoCompaction(enabled: boolean): Promise<EngineSessionState> {
    // The preference is already in FastVibe's settings (`settings.json`), and every new
    // session reads it there, so on the empty hero there is nothing to apply it to yet.
    const session = await this.#activeSession();
    if (!session) return this.#draftState();
    session.setAutoCompactionEnabled(enabled);
    return this.#state(session, this.#activeId ?? undefined);
  }
  async setThinkingLevel(level: string): Promise<EngineSessionState> {
    const session = await this.#activeSession();
    if (!session) {
      this.#pendingThinking = level;
      return this.#draftState();
    }
    session.setThinkingLevel(level as ThinkingLevel);
    return this.#state(session, this.#activeId ?? undefined);
  }
  async getState(): Promise<EngineSessionState> {
    const session = await this.#activeSession();
    return session ? this.#state(session, this.#activeId ?? undefined) : this.#draftState();
  }
  /** Conversation ids with work in flight (a run or a compaction), for the sidebar's indicators. */
  getRunningConversations(): string[] {
    return [...new Set([...this.#running.keys(), ...this.#compacting.keys()])].filter((id) => this.#busy(id));
  }
  /**
   * Whether a conversation is still working: a run in flight, or a compaction.
   *
   * The sidebar's 运行中 mark and 运行时保持唤醒 both read this, so a chat that
   * compacts in the background stays visibly busy instead of looking idle.
   */
  #busy(id: string): boolean { return this.#running.get(id) === true || this.#compacting.has(id); }
  /**
   * Drop every trace of a conversation's work when its session is thrown away.
   *
   * A session discarded mid-run (or mid-compaction) never emits `agent_settled`, so
   * without this the chat keeps spinning in the sidebar — and 运行时保持唤醒 never
   * releases — after it was deleted, re-homed onto another project, or had its
   * project removed.
   */
  #clearBusy(id: string): void {
    const wasBusy = this.#busyBroadcast.get(id) === true;
    this.#running.delete(id);
    this.#compacting.delete(id);
    this.#busyBroadcast.delete(id);
    if (wasBusy) this.#emit({ type: "conversation_running", conversationId: id, running: false });
  }

  async listProviders(): Promise<ProviderConfig[]> { return listProviderConfigs(this.#paths, await loadProviderKeys(this.#paths)); }
  async listNativeProviders(): Promise<NativeProviderConfig[]> { return nativeProviderCatalog(); }
  async addNativeProvider(id: string, apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> { await addNativeProviderConfig(this.#paths, id, apiKey, models); await this.reloadProviders(); return this.listProviders(); }
  async fetchModels(baseUrl: string, apiKey: string, api?: string): Promise<ProviderModel[]> { return fetchProviderModels(baseUrl, apiKey, api); }
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
    const state = this.#state(managed.session, conversation.id);
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
    const state = this.#state(managed.session, conversation.id);
    const messages = this.#messages(managed.session, conversation.id);
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
    const state = this.#state(managed.session, conversation.id);
    const updated = this.#catalog.update(conversation.id, { sessionFile: state.sessionFile, sessionId: state.sessionId }) ?? conversation;
    return this.#opened(updated, [], state);
  }
  /**
   * The session the composer is talking about, or null when there is no conversation.
   *
   * Everything that acts *on a conversation* needs a session and may keep failing
   * loudly through `#active()`; the composer's model and thinking chips are not among
   * them — the empty hero offers both before anything exists to bind them to. Callers
   * of this method decide what a missing conversation means for them.
   */
  async #activeSession(): Promise<AgentSession | null> {
    await this.#ensureReady();
    const active = this.#activeId ? this.#sessions.get(this.#activeId) : undefined;
    if (active) return active.session;
    const conversation = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
    if (!conversation) return null;
    const managed = await this.#ensureSession(conversation);
    this.#activate(managed);
    return managed.session;
  }
  async #active(): Promise<AgentSession> {
    const session = await this.#activeSession();
    if (!session) throw new Error("no active conversation");
    return session;
  }
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
    // (`plan`, `goal`, `todo`, session-title, web-search) alongside whatever the user installed. `createAgentSession`
    // only auto-reloads a loader it creates, so reload ours before handing it over.
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.#paths.agentDir,
      settingsManager,
      additionalExtensionPaths: builtinExtensionPaths(),
      additionalSkillPaths: builtinSkillPaths(),
    });
    // browser-use closes over the conversation id at factory time, which is this reload.
    await bindBrowserConversation(conversation.id, () => resourceLoader.reload());
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
        // The session's own idle, as the SDK's print mode passes it: the agent is idle
        // between an `agent_end` and the retry/compaction it still owes the run, and a
        // plugin that takes that for 「done」 would poke a session mid-run.
        waitForIdle: () => result.session.waitForIdle(),
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
      // A model switch is announced when the new model actually starts answering, not
      // when it was picked: `#announceModelUse` compares this reply against the last
      // one in the transcript before the payload is forwarded, so the renderer's
      // divider lands on the reply that runs on the new model.
      if (event.type === "message_start" && isAssistantEngineMessage(event.message)) {
        this.#announceModelUse(conversation.id, result.session, event.message);
      }
      if (event.type === "session_info_changed") {
        this.#applySessionTitle(conversation.id, event.name);
      }
      // Broadcast work start/end for every conversation, active or not, so the
      // sidebar keeps showing which chats are still working after the user
      // switches away or starts a new one.
      //
      // A run ends at `agent_settled`, not at `agent_end`. The SDK emits `agent_end`
      // before it does any of the things it still owes the same run: retrying a
      // failed request (after an exponential backoff), auto-compacting, or
      // continuing with messages an `agent_end` handler queued — each of which then
      // starts another `agent_start` inside the *same* run. Taking `agent_end` for the
      // end dropped the chat to 空闲 for the whole backoff/compaction window and
      // re-lit it when the next attempt began. `agent_settled` is emitted exactly
      // once, after that whole post-run sequence has finished (it flips the SDK's own
      // `_isAgentRunActive`, which `session.isIdle` reports), so it is the only event
      // that means this conversation is really idle again.
      const running =
        event.type === "agent_start" || event.type === "turn_start"
          ? true
          : event.type === "agent_settled"
            ? false
            : undefined;
      // A compaction counts as work too, and this is the only chance to notice it:
      // a background conversation's payloads are dropped downstream, so nothing
      // else would tell the renderer that chat is busy (or that its card is back).
      // Widened to `string`: the SDK spells these `compaction_*`, the renderer still
      // handles the older `auto_compaction_*`, and both have to be tracked here.
      const eventType: string = event.type;
      let compactionTouched = false;
      if (eventType === "compaction_start" || eventType === "auto_compaction_start") {
        this.#compacting.set(conversation.id, compactReasonOf(event as { reason?: unknown }));
        compactionTouched = true;
      } else if (eventType === "compaction_end" || eventType === "auto_compaction_end") {
        this.#compacting.delete(conversation.id);
        compactionTouched = true;
      }
      if (running !== undefined) this.#running.set(conversation.id, running);
      if (running !== undefined || compactionTouched) {
        const busy = this.#busy(conversation.id);
        if (this.#busyBroadcast.get(conversation.id) !== busy) {
          this.#busyBroadcast.set(conversation.id, busy);
          this.#emit({ type: "conversation_running", conversationId: conversation.id, running: busy });
        }
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
      // 「任务已完成」 rides the same verdict as the sidebar mark: an `agent_end` that
      // is about to retry, compact or continue is not a finished run.
      if (event.type === "agent_settled") {
        this.#emit({ type: "conversation_activity", conversationId: conversation.id, title: this.#catalog.get(conversation.id)?.title ?? "会话", status: "completed" });
      }
    });
    this.#sessions.set(conversation.id, managed);
    // 自动压缩 is FastVibe's setting, but the engine keeps it in its own settings file
    // and the renderer's boot-time call cannot reach a session that does not exist yet
    // (a brand-new install has no conversation at launch) — so the preference is picked
    // up here, where every conversation passes. Skipped when it already matches, since
    // writing it touches the file.
    const autoCompact = readAutoCompact(this.#paths);
    if (result.session.autoCompactionEnabled !== autoCompact) result.session.setAutoCompactionEnabled(autoCompact);
    // A conversation with no history yet starts on the user's pinned 默认模型.
    if (result.session.messages.length === 0) await this.#applyPreferredModel(result.session);
    const payload: ConversationReadyEvent = {
      id: conversation.id,
      messages: this.#messages(result.session, conversation.id),
      state: this.#state(result.session, conversation.id),
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
      // A delegated run ends the same way the parent one does: `agent_end` only means
      // the SDK is about to retry / compact / continue it, so the tab reports 已完成
      // (and stamps `endedAt`) on `agent_settled`. The runner's own lifecycle event
      // lands after the session settles and stays the final word.
      status: status ?? (nestedType === "agent_settled" ? "completed" : "running"),
      detail: typeof event.detail === "string" ? event.detail : typeof event.progress === "string" ? event.progress : previous?.detail,
      progress: typeof event.progress === "number" ? event.progress : previous?.progress,
      startedAt: previous?.startedAt ?? now,
      endedAt: nestedType === "agent_settled" || status === "completed" || status === "error" ? now : previous?.endedAt,
      error: typeof event.error === "string" ? event.error : previous?.error,
    };
    this.#subagents.set(id, next);
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
  /** True when the active conversation has a run in flight (`agent_settled` clears it). */
  #isLive(): boolean { return this.#activeId !== null && this.#running.get(this.#activeId) === true; }
  /**
   * Send a plain turn, first waiting out anything the session still has in flight.
   *
   * `session.waitForIdle()`, not `agent.waitForIdle()`: the agent is idle between an
   * `agent_end` and the retry/compaction/continuation it still owes the run, while the
   * *session* is not — and prompting then throws ("Agent is already processing", or
   * "Cannot submit a prompt while compaction is in progress" for a manual `/compact`).
   */
  async #promptWhenIdle(session: AgentSession, message: string, images?: Array<{ type: "image"; data: string; mimeType: string }>): Promise<void> {
    if (await this.#compactIfCommand(session, message)) return;
    if (!session.isIdle) await session.waitForIdle();
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
      } else if (inner === "thinking_delta") {
        // Not every provider opens with `thinking_start`. Without this a stream of deltas
        // would leave `blocks` empty, and the message would be filed with no bounds at all —
        // that transcript then reads 「思考」 with no duration, forever, in every reload.
        // A second segment that arrives with no start event opens its own block too.
        const open = run.blocks.at(-1);
        if (!open || open.endedAt !== undefined) run.blocks.push({ startedAt: now });
      } else {
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

    // A delegated run uses the model its parent chat is on. Delegation is a tool
    // call inside that conversation, and a run on a *different* gateway than the one
    // the user just proved works fails on its own — the user's 「默认模型」
    // (设置 → 供应商) is a preference for a fresh chat's model chip, not a second
    // opinion about which vendor the current conversation should talk to. It is kept
    // as the fallback for a parent that has no usable model of its own.
    const preferred = readDefaultModel(this.#paths);
    const model = this.#resolveSubagentModel(
      request.fallbackModel ?? request.model,
      preferred ? `${preferred.provider}/${preferred.id}` : undefined,
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
      // `message_end` is slimmed for IPC, so the live stream is the only in-flight
      // transcript; persist the mapped session here so a tab opened after the run
      // still has the full reply (tools and parts included). The sub-session is
      // in-memory, but its entries still carry the persist instant, so a completed
      // pane's footer reads the same as a persisted transcript's.
      const subEntryIds = sessionEntryIds(session);
      this.#subagentMessages.set(
        subagentId,
        mapEngineMessages(messages, (message) => subEntryIds.get(message), undefined, undefined, sessionCompletionTimes(session)),
      );
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
   * Resolve a subagent's model: the preferred spec first, else the fallback.
   *
   * A spec is only honored when this install can actually authenticate it: the
   * catalog (`getAll()`) carries every reseller's models, and a spec that points at
   * an unreachable vendor would otherwise be picked and fail the whole delegation
   * with "No API key found". A spec may omit its provider; an id with no usable auth
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
      // A bare id (`claude-haiku-4-5`) resolves against the authenticated models only,
      // so a role's vendor default can never outrank the user's working model. The id
      // is re-checked for auth: `find`/`getAvailable` can surface a vendor entry whose
      // provider has no key in *this* install, which is exactly the "No API key found
      // for anthropic" failure a role's `model:` line used to cause.
      const bare = registry.getAvailable().find((item) => item.id === value);
      return usable(bare) ? bare : undefined;
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
  #activate(managed: ManagedSession): void {
    this.#activeId = managed.conversationId;
    this.#cwd = managed.cwd;
    this.#catalog.setActive(managed.conversationId);
    // The user is looking at a conversation now, so a pick made when none existed has
    // been adopted (`#createSession`) or is stale (an already-running chat keeps its
    // own model) — either way it must not leak into the next new session.
    this.#clearPendingPick();
    this.#setStatus({ state: "ready", cwd: managed.cwd });
  }
  /**
   * The engine's message list carries no ids of its own; the session entry that
   * owns each message does. Reuse those entry ids so the renderer can branch
   * (edit / retry) at the exact point in the session tree, which is also what
   * makes a retry replace its original turn instead of stacking a second copy.
   */
  #messages(session: AgentSession, conversationId: string | undefined): ChatMessage[] {
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
    const messages = mapEngineMessages(
      session.messages,
      (message) => entryIds.get(message),
      timings,
      renderCustom,
      sessionCompletionTimes(session),
    );
    this.#insertModelSwitches(session, messages);
    // The SDK keeps the reply in flight in `agent.state.streamingMessage` and only
    // pushes it into `agent.state.messages` on `message_end`. A read taken mid-run
    // therefore ends at the user prompt with no trailing assistant row — and the
    // renderer draws 「正在工作」 on that row (its live caret too), so a chat switched
    // away from and back looked idle with its streamed text gone until the next event
    // landed: the optimistic bubble `addUserMessage` made is replaced by this read.
    // Append the reply being streamed, so the transcript says what the composer and
    // the sidebar already do. An empty stand-in covers the window before the first
    // `message_start` (run start, or an auto-retry backoff).
    if (conversationId && this.#running.get(conversationId) === true && !this.#compacting.has(conversationId)) {
      const [inFlight] = mapEngineMessages(session.state.streamingMessage ? [session.state.streamingMessage] : []);
      if (inFlight?.role === "assistant") {
        messages.push({
          ...inFlight,
          id: `running:${conversationId}`,
          // `mapEngineMessages` is a transcript reader, so it marks every tool call
          // `done`. This one is still forming its arguments — the assistant message
          // has not ended, so none of its tools can have executed yet.
          tools: inFlight.tools.map((tool) => ({ ...tool, status: "running" as const })),
        });
      } else if (messages.at(-1)?.role !== "assistant") {
        // Between the run starting and the first `message_start` — the window a
        // prompt sits in right after it is sent — there is no partial to show, so
        // stand in the empty bubble the run is about to stream into. An assistant
        // already on the end means a reply (or an auto-retry's failure) is what the
        // transcript should show for the rest of the run, not a second working row.
        messages.push({ id: `running:${conversationId}`, role: "assistant", text: "", tools: [], parts: [], createdAt: Date.now() });
      }
    }
    // A compaction has no transcript entry until it lands, and its own payload only
    // reaches the renderer while this conversation is on screen. Serving the running
    // card from here is what makes it survive a chat switch (or a window reload)
    // instead of vanishing until the summary is finally written.
    if (conversationId && this.#compacting.has(conversationId)) {
      messages.push({
        id: `compact:${conversationId}`,
        role: "system",
        text: "",
        tools: [],
        parts: [],
        createdAt: Date.now(),
        kind: "compact",
        compact: { status: "running", reason: this.#compacting.get(conversationId) },
      });
    }
    return messages;
  }
  /**
   * Fold model switches into the transcript as divider parts, where the replies show them.
   *
   * A switch is drawn only where it was *used*, so the reply is the source of truth: every
   * assistant message carries the `provider`/`model` that produced it, which makes two
   * consecutive replies on different models a switch — and a pick that nothing followed (or
   * one reverted before the next prompt) no switch at all. The `model_change` entry the SDK
   * writes on the pick is deliberately *not* consulted: it is anchored to the last completed
   * message, which during a run sits *before* the reply still streaming, so the entry alone
   * cannot say which reply the new model actually wrote.
   *
   * The part is unshifted onto the first reply the new model produced — the same slot the
   * live `model_changed` splice uses, since the transcript reload and the live stream have to
   * agree. Consecutive engine messages of one reply are merged into a single row by the
   * renderer, so a switch made mid-run still lands *between that reply's parts* rather than
   * between turns.
   */
  #insertModelSwitches(session: AgentSession, messages: ChatMessage[]): void {
    if (messages.length === 0) return;
    const indexById = new Map(messages.map((message, index) => [message.id, index]));
    let previous: EngineModel | undefined;
    for (const entry of session.sessionManager.getBranch()) {
      if (entry.type !== "message") continue;
      const raw: unknown = entry.message;
      if (!isRecord(raw) || raw.role !== "assistant") continue;
      // A reply that does not name its model (nothing the engine produces is silent
      // about this, but an imported transcript can be) is transparent: it draws no
      // divider, and does not become the model the next reply is compared against.
      if (typeof raw.provider !== "string" || typeof raw.model !== "string") continue;
      const model: EngineModel = { provider: raw.provider, id: raw.model };
      const from = previous;
      // Recorded before the on-screen check below: a reply summarised away by a
      // compaction still moves the sequence on, so the divider that finally shows
      // names the model it really followed.
      previous = model;
      if (!from || (from.provider === model.provider && from.id === model.id)) continue;
      const index = indexById.get(entry.id);
      // Not on screen: summarised away by a compaction, or on another branch.
      if (index === undefined) continue;
      if (messages[index].role !== "assistant") continue;
      (messages[index].parts ??= []).unshift({ kind: "model", from, to: model });
    }
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
  /**
   * Snapshot one session for the composer and the sidebar.
   *
   * `conversationId` is carried so a reply that lands after the user switched
   * chats can still be attributed. `running` is the engine's own run flag (see the
   * event listener in `#ensureSession`), which now spans exactly the same window as
   * `session.isStreaming` — from the first `agent_start` to `agent_settled` — so a
   * state reply read mid-retry reports the chat as working, not idle.
   *
   * `running` is the run alone. A compaction is its own flag (`isCompacting`),
   * because the composer stops a run and a compaction the same way but the
   * sidebar's 运行中 covers both — the renderer unions them (`working`).
   */
  #state(session: AgentSession, conversationId: string | undefined): EngineSessionState { const model = session.model; const usage = session.getContextUsage(); return { conversationId, running: conversationId ? this.#running.get(conversationId) === true : false, model: model ? { provider: model.provider, id: model.id } : undefined, thinkingLevel: session.thinkingLevel, isStreaming: session.isStreaming, isCompacting: session.isCompacting, interruptMode: this.#interruptMode, sessionFile: session.sessionFile, sessionId: session.sessionId, sessionName: session.sessionName, messageCount: session.messages.length, queuedMessageCount: session.pendingMessageCount, autoCompactionEnabled: session.autoCompactionEnabled, steeringMode: session.steeringMode, followUpMode: session.followUpMode, contextUsage: usage ? { tokens: usage.tokens, contextWindow: usage.contextWindow, percent: usage.percent } : undefined }; }
  /** State for the empty hero: no session exists, so only the composer's own picks are known. */
  #draftState(): EngineSessionState { return { model: this.#pendingModel, thinkingLevel: this.#pendingThinking, isStreaming: false, running: false, interruptMode: this.#interruptMode }; }
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
      await this.#useModel(session, fallback);
    } catch {
      // No credential for the replacement either: leave the session alone. The next
      // request reports it and the composer offers 「添加模型」.
    }
  }

  /**
   * Apply the model and thinking level a brand-new conversation should start on: the
   * pick the user made while none existed, else the pinned 「默认模型」.
   *
   * The preference lives in FastVibe's own settings file: the SDK's
   * `defaultProvider`/`defaultModel` keys cannot hold it, because `AgentSession.setModel`
   * rewrites them to the last used model on every switch. Best effort by design — a
   * pin whose provider was removed or whose key is gone leaves the engine default in
   * place rather than blocking the session.
   */
  async #applyPreferredModel(session: AgentSession): Promise<void> {
    const pending = this.#pendingModel;
    const thinking = this.#pendingThinking;
    const pinned = readDefaultModel(this.#paths);
    this.#clearPendingPick();
    // The pick made on the hero wins; the pin is both its fallback and the normal path
    // for a conversation that starts with nothing pre-picked.
    const model =
      (pending ? this.#models?.find(pending.provider, pending.id) : undefined) ??
      (pinned ? this.#models?.find(pinned.provider, pinned.id) : undefined);
    if (model) {
      try {
        await session.setModel(model);
      } catch {
        // No credential for it any more (or the model went away): keep the default.
      }
    }
    // `setModel` re-clamps the level to the new model, so the pick lands after it.
    if (thinking) session.setThinkingLevel(thinking as ThinkingLevel);
  }

  #clearPendingPick(): void {
    this.#pendingModel = undefined;
    this.#pendingThinking = undefined;
  }

  #setStatus(status: EngineStatus): void { this.#status = status; for (const listener of this.#statusListeners) listener(status); }
  #queue<T>(work: () => Promise<T>): Promise<T> { const next = this.#operation.then(work, work); this.#operation = next.then(() => undefined, () => undefined); return next; }
}
