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
} from "@earendil-works/pi-coding-agent";
import type { ChatMessage, ThinkingTiming } from "@shared/types";
import { isAbortOutcome } from "@shared/abort";
import { readDefaultModel } from "../engine/runtime-settings";
import { currentAiLanguageDirective, currentCustomSystemPrompt } from "../engine/ai-language";
import { uiText } from "../engine/ui-text";
import { mapEngineMessages } from "../engine/map-messages";
import type { FastVibePaths } from "../engine/paths";
import { SubagentManager } from "../engine/subagents";
import { SubagentControl } from "./subagent-control";
import {
  guardSessionListener,
  sessionCompletionTimes,
  sessionEntryIds,
  slimStreamEvent,
  summarizeSubagentMessages,
  type SubagentHostUsage,
} from "./process-manager-events";
import { builtinExtensionFile } from "./extension-manager";

export type SubagentHostRequest = {
  /** `${parentToolCallId}:${index}` — the same id the tool-call tracker mints. */
  subagentId: string;
  agent: string;
  agentSource?: "user" | "project";
  task: string;
  systemPrompt: string;
  tools?: string[];
  model?: string;
  fallbackModel?: string;
  thinkingLevel?: ThinkingLevel;
  cwd: string;
  signal?: AbortSignal;
};

export type SubagentHostResponse = {
  messages: unknown[];
  exitCode: number;
  usage: SubagentHostUsage;
  model?: string;
  stopReason?: string;
  errorMessage?: string;
};

type ReasoningBlocks = { blocks: ThinkingTiming[] };

export type SubagentRunHost = {
  runtime: ModelRuntime | null;
  models: ModelRegistry | null;
  cwd: string;
  paths: FastVibePaths;
  subagentManager: SubagentManager;
  subagentControls: Map<string, SubagentControl>;
  subagentSessions: Map<string, AgentSession>;
  subagentMessages: Map<string, ChatMessage[]>;
  subagentReasoning: Map<string, Map<string, ThinkingTiming[]>>;
  reasoningRun: Map<string, ReasoningBlocks>;
  stoppedSubagents: Set<string>;
  emit(event: Record<string, unknown>): void;
  resolvePendingUi(conversationId?: string, owner?: string): void;
  extensionUi(conversationId: string, owner: string): ExtensionUIContext;
  publishSubagentState(subagentId: string, conversationId: string, session: AgentSession): void;
  timeReasoning(
    key: string,
    event: AgentSessionEvent,
    session: AgentSession,
    now: number,
    file: (entryId: string, blocks: ThinkingTiming[]) => void,
  ): void;
  fileSubagentReasoning(subagentId: string, entryId: string, blocks: ThinkingTiming[]): void;
  withThinkingTiming(key: string, event: AgentSessionEvent, payload: Record<string, unknown>): void;
};

/** The delegated-run loop, split out of `PiProcessManager` so the host file can stay about sessions. */
export class SubagentTurnRunner {
  #host: SubagentRunHost;
  #runtime: ModelRuntime | null;
  #models: ModelRegistry | null;
  #cwd: string;
  #paths: FastVibePaths;
  #subagentManager: SubagentManager;
  #subagentControls: Map<string, SubagentControl>;
  #subagentSessions: Map<string, AgentSession>;
  #subagentMessages: Map<string, ChatMessage[]>;
  #subagentReasoning: Map<string, Map<string, ThinkingTiming[]>>;
  #reasoningRun: Map<string, ReasoningBlocks>;
  #stoppedSubagents: Set<string>;

  constructor(host: SubagentRunHost) {
    this.#host = host;
    this.#runtime = host.runtime;
    this.#models = host.models;
    this.#cwd = host.cwd;
    this.#paths = host.paths;
    this.#subagentManager = host.subagentManager;
    this.#subagentControls = host.subagentControls;
    this.#subagentSessions = host.subagentSessions;
    this.#subagentMessages = host.subagentMessages;
    this.#subagentReasoning = host.subagentReasoning;
    this.#reasoningRun = host.reasoningRun;
    this.#stoppedSubagents = host.stoppedSubagents;
  }

  #emit(event: Record<string, unknown>): void {
    this.#host.emit(event);
  }

  #resolvePendingUi(conversationId?: string, owner?: string): void {
    this.#host.resolvePendingUi(conversationId, owner);
  }

  #extensionUi(conversationId: string, owner: string = conversationId): ExtensionUIContext {
    return this.#host.extensionUi(conversationId, owner);
  }

  #publishSubagentState(subagentId: string, conversationId: string, session: AgentSession): void {
    this.#host.publishSubagentState(subagentId, conversationId, session);
  }

  #timeReasoning(
    key: string,
    event: AgentSessionEvent,
    session: AgentSession,
    now: number,
    file: (entryId: string, blocks: ThinkingTiming[]) => void,
  ): void {
    this.#host.timeReasoning(key, event, session, now, file);
  }

  #fileSubagentReasoning(subagentId: string, entryId: string, blocks: ThinkingTiming[]): void {
    this.#host.fileSubagentReasoning(subagentId, entryId, blocks);
  }

  #withThinkingTiming(key: string, event: AgentSessionEvent, payload: Record<string, unknown>): void {
    this.#host.withThinkingTiming(key, event, payload);
  }

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
    const { subagentId } = request;
    const lifecycle = (status: string, error?: string): void => {
      this.#emit({ type: "subagent_lifecycle", subagentId, conversationId, agent: request.agent, name: request.agent, status, detail: request.task, ...(error ? { error } : {}) });
    };
    const control = new SubagentControl(request.signal, () => this.#resolvePendingUi(undefined, subagentId));
    this.#subagentControls.set(subagentId, control);
    let session: AgentSession | undefined;
    let unsubscribe: (() => void) | undefined;
    let thrown: unknown;
    let stopReason: string | undefined;
    let errorMessage: string | undefined;
    let messages: unknown[] = [];
    let summary = summarizeSubagentMessages([]);
    let usedModel: string | undefined;
    try {
      lifecycle("running");
      control.check();
      if (!this.#runtime || !this.#models) throw new Error("engine not ready");
      const cwd = request.cwd || this.#cwd;
      const settingsManager = SettingsManager.create(cwd, this.#paths.agentDir);
      const sandbox = builtinExtensionFile("permission-sandbox.ts");
      // A delegated run never loads the `output-language` extension (`noExtensions`), so
      // its system prompt carries the same AI 偏好语言 requirement directly — a subagent
      // report the user cannot read is a bug, not a preference.
      const appendSystemPrompt = [
        request.systemPrompt.trim(),
        currentAiLanguageDirective(),
        currentCustomSystemPrompt(),
      ].filter(
        (value): value is string => Boolean(value),
      );
      const loader = new DefaultResourceLoader({
        cwd,
        agentDir: this.#paths.agentDir,
        settingsManager,
        noExtensions: true,
        noThemes: true,
        noPromptTemplates: true,
        noSkills: true,
        ...(sandbox ? { additionalExtensionPaths: [sandbox] } : {}),
        ...(appendSystemPrompt.length > 0 ? { appendSystemPrompt } : {}),
      });
      await loader.reload();
      control.check();

      // A role's configured model wins when it is available and authenticated. An empty
      // role setting inherits the parent conversation's model, keeping delegation on the
      // gateway the user just proved works; the user's default model is the last resort
      // for a parent session that has no usable model of its own.
      const preferred = readDefaultModel(this.#paths);
      const configuredModel = this.#subagentManager.modelFor(request.agent, request.model, request.agentSource);
      const thinkingLevel = this.#subagentManager.thinkingLevelFor(request.agent, request.thinkingLevel, request.agentSource);
      const model = this.#resolveSubagentModel(
        configuredModel,
        request.fallbackModel ?? (preferred ? `${preferred.provider}/${preferred.id}` : undefined),
      );
      const tools =
        request.tools && request.tools.length > 0
          ? request.tools
          : ["read", "bash", "edit", "write", "grep", "find", "ls"];
      usedModel = model ? `${model.provider}/${model.id}` : undefined;
      const created = await createAgentSession({
        cwd,
        agentDir: this.#paths.agentDir,
        modelRuntime: this.#runtime,
        sessionManager: SessionManager.inMemory(cwd),
        settingsManager,
        resourceLoader: loader,
        tools,
        ...(model ? { model } : {}),
        ...(thinkingLevel ? { thinkingLevel } : {}),
      });
      session = created.session;
      control.bind(session);
      const activeSession = session;
      // Bind the parent's UI so the sandbox's `confirm` renders in the same
      // composer panel as a main-tool approval, and `hasUI` is true for the hook.
      await session.bindExtensions({ mode: "rpc", uiContext: this.#extensionUi(conversationId, subagentId) });
      this.#subagentSessions.set(subagentId, session);
      this.#publishSubagentState(subagentId, conversationId, activeSession);
      unsubscribe = activeSession.subscribe(guardSessionListener(`subagent ${subagentId}`, (event) => {
        // Time each thinking block as it streams. A delegated run's transcript has no
        // measured bounds of its own, so without this its thinking row could only ever
        // fall back to the span of the whole round-trip — and while that round-trip was
        // still running there was nothing to fall back to at all.
        const now = Date.now();
        this.#timeReasoning(subagentId, event, activeSession, now, (entryId, blocks) =>
          this.#fileSubagentReasoning(subagentId, entryId, blocks),
        );
        // The bounds belong on the *inner* event: the renderer re-applies that object
        // (`applySubagentStream` unwraps `event.event`), and `stampThinkingTiming`
        // reads them off whatever it was handed.
        const nested = slimStreamEvent(event as unknown as Record<string, unknown>);
        this.#withThinkingTiming(subagentId, event, nested);
        this.#emit({ type: "subagent_event", subagentId, conversationId, event: nested });
        // The context window moves at every turn boundary, exactly as it does on the
        // main thread, so the read-only composer's ring is refreshed from the same
        // point rather than only when the run ends.
        if (event.type === "turn_end" || event.type === "agent_start" || event.type === "agent_settled") {
          this.#publishSubagentState(subagentId, conversationId, activeSession);
        }
      }));
      control.check();
      await session.prompt(request.task);
    } catch (error) {
      thrown = error;
    }
    unsubscribe?.();
    try {
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
          mapEngineMessages(
            messages,
            (message) => subEntryIds.get(message),
            this.#subagentReasoning.get(subagentId),
            undefined,
            sessionCompletionTimes(session),
          ),
        );
        this.#publishSubagentState(subagentId, conversationId, session);
      }
    } catch (error) {
      thrown ??= error;
    } finally {
      this.#subagentReasoning.delete(subagentId);
    }
    // A run cut off mid-thought (aborted, torn down) never emits the `message_end` that
    // would have dropped this, and the key is the run id — nothing else will reuse it.
    this.#reasoningRun.delete(subagentId);
    stopReason = control.aborted ? "aborted" : thrown ? (isAbortOutcome(thrown) ? "aborted" : "error") : summary.stopReason;
    errorMessage = thrown ? (thrown instanceof Error ? thrown.message : String(thrown)) : summary.errorMessage;
    // A user stop and a parent abort both arrive as `aborted`, but only the first has a
    // waiting parent to tell, and it is the message the main agent reads back as the
    // tool result. Forced, not merely relabelled: the abort can surface here as a
    // thrown error (`thrown` above), and the tool result must still say the user
    // stopped it rather than name an engine failure.
    if (this.#stoppedSubagents.delete(subagentId)) {
      stopReason = "aborted";
      errorMessage = uiText("已被用户终止", "Stopped by the user");
    }
    const failed = stopReason === "error" || stopReason === "aborted";
    try {
      // Cache and state land before the terminal event: a pane reacting to it can
      // now read the complete transcript, never a half-finalised live session.
      lifecycle(stopReason === "aborted" ? "aborted" : failed ? "error" : "completed", errorMessage);
    } finally {
      control.dispose();
      this.#subagentControls.delete(subagentId);
      this.#subagentSessions.delete(subagentId);
      this.#resolvePendingUi(undefined, subagentId);
      session?.dispose();
    }

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

  run(conversationId: string, request: SubagentHostRequest): Promise<SubagentHostResponse> {
    return this.#runSubagent(conversationId, request);
  }
}
