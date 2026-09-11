import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { appendFileSync } from "node:fs";
import { unlink } from "node:fs/promises";
import { homedir } from "node:os";
import { shell } from "electron";
import type {
  ChatMessage,
  Conversation,
  ConversationDeleteResult,
  ConversationOpenResult,
  FastVibeModel,
  OmpSessionState,
  OmpStatus,
  ProjectAddResult,
  ProviderConfig,
  ProviderModel,
  SessionStats,
  SlashCommand,
  SubagentInfo,
  ThinkingLevel,
  WorkspaceSnapshot,
} from "@shared/types";
import { ConversationCatalog } from "./conversation-catalog";
import { lookupBuiltinModel, toValidEfforts } from "./model-catalog";
import { findOmpBinary } from "./find-binary";
import { mapEngineMessages } from "./map-messages";
import { getFastVibePaths, ompSpawnEnv, type FastVibePaths } from "./paths";
import {
  addProvider as addProviderConfig,
  applyProviders,
  fetchProviderModels,
  listProviderConfigs,
  loadProviderKeys,
  providerKeyEnv,
  readProviders,
  refreshProviderModels,
  removeProvider as removeProviderConfig,
  saveFastVibe as saveFastVibeConfig,
  setProviderKey,
  updateProvider as updateProviderConfig,
  usableProviders,
} from "./providers";
import { OmpRpcClient } from "./rpc-client";

const STOP_TIMEOUT_MS = 4_000;

export class OmpProcessManager {
  #paths: FastVibePaths;
  #catalog: ConversationCatalog;
  #proc: ChildProcessWithoutNullStreams | null = null;
  #rpc: OmpRpcClient | null = null;
  #status: OmpStatus = { state: "idle" };
  #cwd = homedir();
  #statusListeners = new Set<(status: OmpStatus) => void>();
  #eventListeners = new Set<(event: Record<string, unknown>) => void>();
  #unsubRpc: (() => void) | null = null;

  constructor() {
    this.#paths = getFastVibePaths();
    this.#catalog = new ConversationCatalog(this.#paths.conversationsFile, this.#paths.ompScratch);
    const active = this.#catalog.activeId ? this.#catalog.get(this.#catalog.activeId) : undefined;
    if (active?.cwd) this.#cwd = active.cwd;
  }

  listWorkspace(): WorkspaceSnapshot {
    return this.#catalog.snapshot();
  }

  get status(): OmpStatus {
    return this.#status;
  }

  get cwd(): string {
    return this.#cwd;
  }

  get rpc(): OmpRpcClient | null {
    return this.#rpc;
  }

  onStatus(listener: (status: OmpStatus) => void): () => void {
    this.#statusListeners.add(listener);
    return () => this.#statusListeners.delete(listener);
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.#eventListeners.add(listener);
    return () => this.#eventListeners.delete(listener);
  }

  async start(cwd = this.#cwd): Promise<OmpStatus> {
    if (this.#status.state === "ready" && this.#cwd === cwd && this.#rpc) {
      return this.#status;
    }

    await this.stop();
    this.#cwd = cwd;
    this.#setStatus({ state: "starting", cwd });

    const binary = await findOmpBinary();
    if (!binary) {
      const status: OmpStatus = {
        state: "missing",
      };
      this.#setStatus(status);
      return status;
    }

    const keys = await loadProviderKeys(this.#paths);
    const usable = usableProviders(this.#paths, keys);
    if (usable.length === 0) {
      const status: OmpStatus = { state: "needsAuth", binary, cwd };
      this.#setStatus(status);
      return status;
    }

    applyProviders(this.#paths);
    const env = ompSpawnEnv(process.env, this.#paths, keys);
    const proc = spawn(binary, ["--mode", "rpc", "--allow-home", "--cwd", cwd], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.#proc = proc;
    let stderrBuf = "";

    proc.on("error", (error) => {
      if (this.#proc !== proc) return;
      this.#cleanup();
      this.#setStatus({
        state: "error",
        binary,
        cwd,
        message: error.message,
      });
    });

    proc.stderr.setEncoding("utf8");
    proc.stderr.on("data", (chunk: string) => {
      stderrBuf += chunk;
      try {
        appendFileSync(this.#paths.ompStderrLog, chunk);
      } catch {
        // ignore log write failures
      }
    });

    proc.on("exit", (code, signal) => {
      if (this.#proc !== proc) return;
      this.#cleanup();
      if (this.#status.state !== "starting" && this.#status.state !== "ready") return;
      if (stderrBuf.includes("No models available")) {
        this.#setStatus({ state: "error", binary, cwd, message: "模型配置无效，请稍后重试。" });
        return;
      }
      this.#setStatus({
        state: "error",
        binary,
        cwd,
        message: `exited code=${code ?? "null"} signal=${signal ?? "null"}`,
      });
    });

    const rpc = new OmpRpcClient(proc);
    this.#rpc = rpc;
    this.#unsubRpc = rpc.onEvent((event) => {
      for (const listener of this.#eventListeners) listener(event);
    });

    try {
      await rpc.negotiate();
      void rpc
        .request({ type: "set_subagent_subscription", level: "events" })
        .catch(() => undefined);
      this.#setStatus({ state: "ready", binary, cwd });
      return this.#status;
    } catch (error) {
      if (this.#status.state === "needsAuth") return this.#status;
      await this.stop();
      const noModels = stderrBuf.includes("No models available");
      const status: OmpStatus = {
        state: "error",
        binary,
        cwd,
        message: noModels
          ? "模型配置无效，请稍后重试。"
          : error instanceof Error
            ? error.message
            : String(error),
      };
      this.#setStatus(status);
      return status;
    }
  }

  async stop(): Promise<void> {
    const proc = this.#proc;
    const rpc = this.#rpc;
    this.#cleanup();
    if (!proc) {
      if (this.#status.state === "starting" || this.#status.state === "ready") {
        this.#setStatus({ state: "idle" });
      }
      return;
    }

    rpc?.dispose();

    await new Promise<void>((resolve) => {
      const done = (): void => {
        clearTimeout(timer);
        proc.off("exit", onExit);
        resolve();
      };
      const onExit = (): void => done();
      proc.once("exit", onExit);

      if (proc.stdin.writable) {
        proc.stdin.end();
      }

      const timer = setTimeout(() => {
        if (!proc.killed) proc.kill("SIGTERM");
        setTimeout(() => {
          if (!proc.killed) proc.kill("SIGKILL");
          done();
        }, 1500);
      }, STOP_TIMEOUT_MS);
    });

    if (this.#status.state === "starting" || this.#status.state === "ready") {
      this.#setStatus({ state: "idle" });
    }
  }

  async prompt(
    message: string,
    options?: { streamingBehavior?: "steer" | "followUp"; images?: Array<{ type: "image"; data: string; mimeType: string }> },
  ): Promise<void> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({
      type: "prompt",
      message,
      ...(options?.streamingBehavior ? { streamingBehavior: options.streamingBehavior } : {}),
      ...(options?.images?.length ? { images: options.images } : {}),
    });
    if (!response.success) {
      throw new Error(response.error ?? "prompt failed");
    }
  }

  async steer(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({
      type: "steer",
      message,
      ...(images?.length ? { images } : {}),
    });
    if (!response.success) {
      throw new Error(response.error ?? "steer failed");
    }
  }

  async followUp(
    message: string,
    images?: Array<{ type: "image"; data: string; mimeType: string }>,
  ): Promise<void> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({
      type: "follow_up",
      message,
      ...(images?.length ? { images } : {}),
    });
    if (!response.success) {
      throw new Error(response.error ?? "follow_up failed");
    }
  }

  async abort(): Promise<void> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "abort" });
    if (!response.success) {
      throw new Error(response.error ?? "abort failed");
    }
  }

  async clearQueue(): Promise<{ steering: string[]; followUp: string[] }> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "clear_queue" });
    if (!response.success) {
      throw new Error(response.error ?? "clear_queue failed");
    }
    const data = isRecord(response.data) ? response.data : {};
    return {
      steering: Array.isArray(data.steering) ? data.steering.map(String) : [],
      followUp: Array.isArray(data.followUp)
        ? data.followUp.map(String)
        : Array.isArray(data.follow_up)
          ? data.follow_up.map(String)
          : [],
    };
  }

  async branch(entryId: string): Promise<ChatMessage[]> {
    const rpc = this.#requireRpc();
    let response = await rpc.request({ type: "branch", entryId });
    if (!response.success) {
      response = await rpc.request({ type: "fork", entryId });
    }
    if (!response.success) {
      throw new Error(response.error ?? "branch failed");
    }
    return this.loadMessages();
  }

  async getSessionStats(): Promise<SessionStats> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "get_session_stats" });
    if (!response.success) return {};
    const data = isRecord(response.data) ? response.data : {};
    const tokens = isRecord(data.tokens) ? data.tokens : undefined;
    return {
      tokens: tokens
        ? {
            input: typeof tokens.input === "number" ? tokens.input : undefined,
            output: typeof tokens.output === "number" ? tokens.output : undefined,
            total: typeof tokens.total === "number" ? tokens.total : undefined,
          }
        : undefined,
      cost: typeof data.cost === "number" ? data.cost : undefined,
      toolCalls: typeof data.toolCalls === "number" ? data.toolCalls : undefined,
    };
  }

  async compact(customInstructions?: string): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request(
      {
        type: "compact",
        ...(customInstructions ? { customInstructions } : {}),
      },
      180_000,
    );
    if (!response.success) {
      throw new Error(response.error ?? "compact failed");
    }
    return this.getState();
  }

  async getCommands(): Promise<SlashCommand[]> {
    const rpc = this.#requireRpc();
    const primary = await rpc.request({ type: "get_available_commands" });
    const fallback = primary.success ? primary : await rpc.request({ type: "get_commands" });
    if (!fallback.success) return [];
    const data = fallback.data;
    const raw = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.commands)
        ? data.commands
        : [];
    return raw.flatMap((entry) => {
      if (!isRecord(entry) || typeof entry.name !== "string") return [];
      return [
        {
          name: entry.name,
          description: typeof entry.description === "string" ? entry.description : undefined,
          source: typeof entry.source === "string" ? entry.source : undefined,
          aliases: Array.isArray(entry.aliases)
            ? entry.aliases.filter((item): item is string => typeof item === "string")
            : undefined,
        },
      ];
    });
  }

  async getSubagentMessages(subagentId: string): Promise<ChatMessage[]> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "get_subagent_messages", subagentId });
    if (!response.success) return [];
    const data = response.data;
    const raw = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.messages)
        ? data.messages
        : [];
    return mapEngineMessages(raw);
  }

  async getSubagents(): Promise<SubagentInfo[]> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "get_subagents" });
    if (!response.success) return [];
    const data = response.data;
    const raw = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.subagents)
        ? data.subagents
        : isRecord(data) && Array.isArray(data.agents)
          ? data.agents
          : [];
    return raw.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const id = String(entry.id ?? entry.subagentId ?? "");
      if (!id) return [];
      return [
        {
          id,
          name: typeof entry.name === "string" ? entry.name : typeof entry.label === "string" ? entry.label : undefined,
          status: typeof entry.status === "string" ? entry.status : undefined,
          detail: typeof entry.detail === "string" ? entry.detail : typeof entry.progress === "string" ? entry.progress : undefined,
        },
      ];
    });
  }

  respondPermission(payload: {
    id: string;
    confirmed?: boolean;
    value?: string;
    cancelled?: boolean;
  }): void {
    const rpc = this.#rpc;
    if (!rpc) return;
    rpc.send({
      type: "extension_ui_response",
      id: payload.id,
      ...(payload.cancelled ? { cancelled: true } : {}),
      ...(typeof payload.confirmed === "boolean" ? { confirmed: payload.confirmed } : {}),
      ...(typeof payload.value === "string" ? { value: payload.value } : {}),
    });
  }

  async newSession(): Promise<void> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "new_session" });
    if (!response.success) {
      throw new Error(response.error ?? "new_session failed");
    }
  }

  async createConversation(project?: string): Promise<ConversationOpenResult> {
    // Allocate the conversation first: an unbound one needs its scratch dir as the engine cwd.
    const created = this.#catalog.create(project);
    if (created.cwd !== this.#cwd) {
      await this.start(created.cwd);
    }
    if (this.#status.state === "ready") {
      try {
        await this.abort();
      } catch {
        // ignore
      }
      await this.newSession();
    }
    const state = this.#status.state === "ready" ? await this.getState() : null;
    const conversation =
      this.#catalog.update(created.id, {
        sessionFile: state?.sessionFile,
        sessionId: state?.sessionId,
      }) ?? created;
    return this.#opened(conversation, [], state);
  }

  async openConversation(id: string): Promise<ConversationOpenResult> {
    const conversation = this.#catalog.get(id);
    if (!conversation) {
      throw new Error("conversation not found");
    }
    this.#catalog.setActive(id);
    if (conversation.cwd && conversation.cwd !== this.#cwd) {
      await this.start(conversation.cwd);
    }
    if (this.#status.state === "ready" && conversation.sessionFile) {
      try {
        await this.abort();
      } catch {
        // ignore
      }
      const rpc = this.#requireRpc();
      const response = await rpc.request({
        type: "switch_session",
        sessionPath: conversation.sessionFile,
      });
      if (!response.success) {
        throw new Error(response.error ?? "switch_session failed");
      }
    }
    const state = this.#status.state === "ready" ? await this.getState() : null;
    const messages = this.#status.state === "ready" ? await this.loadMessages() : [];
    return this.#opened(conversation, messages, state);
  }

  renameConversation(id: string, title: string): WorkspaceSnapshot {
    const trimmed = title.trim();
    if (trimmed) {
      this.#catalog.update(id, { title: trimmed });
      if (this.#catalog.activeId === id && this.#status.state === "ready") {
        void this.#requireRpc()
          .request({ type: "set_session_name", name: trimmed })
          .catch(() => undefined);
      }
    }
    return this.#catalog.snapshot();
  }

  async deleteConversation(id: string): Promise<ConversationDeleteResult> {
    const wasActive = this.#catalog.activeId === id;
    const removed = this.#catalog.remove(id);
    if (removed?.sessionFile) {
      await unlink(removed.sessionFile).catch(() => undefined);
    }
    return {
      ...this.#catalog.snapshot(),
      nextId: wasActive ? (this.#catalog.activeId ?? null) : null,
    };
  }

  /** Bind (or clear) a conversation's project. Unbound conversations use a scratch workspace. */
  async setConversationProject(id: string, project: string | null): Promise<WorkspaceSnapshot> {
    const before = this.#catalog.get(id);
    const updated = this.#catalog.setProject(id, project ?? undefined);
    const isActive = this.#catalog.activeId === id;
    if (isActive && updated && updated.cwd !== before?.cwd) {
      await this.start(updated.cwd);
    }
    return this.#catalog.snapshot();
  }

  recordPrompt(id: string, text: string): WorkspaceSnapshot {
    const preview = text.trim().slice(0, 80);
    const current = this.#catalog.get(id);
    const title =
      current?.title && current.title !== "新会话" && current.title !== "新任务"
        ? current.title
        : preview.slice(0, 24) || "新会话";
    this.#catalog.update(id, { title, preview });
    if (this.#status.state === "ready" && title !== "新会话") {
      void this.#requireRpc()
        .request({ type: "set_session_name", name: title })
        .catch(() => undefined);
    }
    return this.#catalog.snapshot();
  }

  addProject(cwd: string): ProjectAddResult {
    const project = this.#catalog.ensureProject(cwd);
    if (!project) throw new Error("invalid project");
    return { ...this.#catalog.snapshot(), project };
  }

  renameProject(cwd: string, name: string): WorkspaceSnapshot {
    this.#catalog.renameProject(cwd, name);
    return this.#catalog.snapshot();
  }

  async removeProject(cwd: string): Promise<ConversationDeleteResult> {
    const wasActive = this.#catalog.get(this.#catalog.activeId ?? "")?.project === cwd;
    const removed = this.#catalog.removeProject(cwd);
    await Promise.all(
      removed.map((item) =>
        item.sessionFile ? unlink(item.sessionFile).catch(() => undefined) : Promise.resolve(),
      ),
    );
    return {
      ...this.#catalog.snapshot(),
      nextId: wasActive ? (this.#catalog.activeId ?? null) : null,
    };
  }

  async loadMessages(): Promise<ChatMessage[]> {
    const rpc = this.#requireRpc();
    const paged = await rpc.request({ type: "get_messages_page", limit: 256 });
    if (paged.success && isRecord(paged.data) && Array.isArray(paged.data.messages)) {
      return mapEngineMessages(paged.data.messages);
    }
    const all = await rpc.request({ type: "get_messages" });
    if (!all.success) return [];
    const data = all.data;
    const raw = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.messages)
        ? data.messages
        : [];
    return mapEngineMessages(raw);
  }

  async getAvailableModels(): Promise<FastVibeModel[]> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "get_available_models" });
    if (!response.success) {
      throw new Error(response.error ?? "get_available_models failed");
    }
    const data = response.data;
    const raw = Array.isArray(data)
      ? data
      : isRecord(data) && Array.isArray(data.models)
        ? data.models
        : [];
    return raw.flatMap((entry) => {
      if (!isRecord(entry)) return [];
      const provider = String(entry.provider ?? "fastvibe");
      const id = String(entry.id ?? "");
      if (!id) return [];
      const builtin = lookupBuiltinModel(id);
      const thinkingLevels: ThinkingLevel[] | undefined = builtin?.thinkingLevels
        ? builtin.thinkingLevels
        : isRecord(entry.thinking) && Array.isArray(entry.thinking.efforts)
          ? toValidEfforts(
              entry.thinking.efforts.filter((level): level is string => typeof level === "string"),
            ).filter((level): level is ThinkingLevel =>
              ["minimal", "low", "medium", "high", "xhigh", "max"].includes(level),
            )
          : undefined;
      return [
        {
          provider,
          id,
          name: String(entry.name ?? id),
          thinkingLevels: thinkingLevels && thinkingLevels.length > 0 ? thinkingLevels : undefined,
        },
      ];
    });
  }

  async setModel(provider: string, modelId: string): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "set_model", provider, modelId });
    if (!response.success) {
      throw new Error(response.error ?? "set_model failed");
    }
    return this.getState();
  }

  async setInterruptMode(mode: "immediate" | "wait"): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "set_interrupt_mode", mode });
    if (!response.success) {
      throw new Error(response.error ?? "set_interrupt_mode failed");
    }
    return this.getState();
  }

  async setSteeringMode(mode: "all" | "one-at-a-time"): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "set_steering_mode", mode });
    if (!response.success) throw new Error(response.error ?? "set_steering_mode failed");
    return this.getState();
  }

  async setFollowUpMode(mode: "all" | "one-at-a-time"): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "set_follow_up_mode", mode });
    if (!response.success) throw new Error(response.error ?? "set_follow_up_mode failed");
    return this.getState();
  }

  async exportHtml(): Promise<string | undefined> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "export_html" });
    if (!response.success) throw new Error(response.error ?? "export_html failed");
    const data = isRecord(response.data) ? response.data : {};
    return typeof data.path === "string" ? data.path : undefined;
  }

  async setAutoCompaction(enabled: boolean): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "set_auto_compaction", enabled });
    if (!response.success) {
      throw new Error(response.error ?? "set_auto_compaction failed");
    }
    return this.getState();
  }

  async setThinkingLevel(level: string): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "set_thinking_level", level });
    if (!response.success) {
      throw new Error(response.error ?? "set_thinking_level failed");
    }
    return this.getState();
  }

  async getState(): Promise<OmpSessionState> {
    const rpc = this.#requireRpc();
    const response = await rpc.request({ type: "get_state" });
    if (!response.success) {
      throw new Error(response.error ?? "get_state failed");
    }
    const data = (response.data ?? {}) as Record<string, unknown>;
    const model = isRecord(data.model)
      ? {
          provider: String(data.model.provider ?? ""),
          id: String(data.model.id ?? ""),
        }
      : undefined;
    const usage = isRecord(data.contextUsage) ? data.contextUsage : undefined;
    return {
      model: model?.provider && model.id ? model : undefined,
      thinkingLevel: typeof data.thinkingLevel === "string" ? data.thinkingLevel : undefined,
      isStreaming: Boolean(data.isStreaming),
      isCompacting: Boolean(data.isCompacting),
      sessionFile: typeof data.sessionFile === "string" ? data.sessionFile : undefined,
      sessionId: typeof data.sessionId === "string" ? data.sessionId : undefined,
      sessionName: typeof data.sessionName === "string" ? data.sessionName : undefined,
      messageCount: typeof data.messageCount === "number" ? data.messageCount : undefined,
      queuedMessageCount: typeof data.queuedMessageCount === "number" ? data.queuedMessageCount : undefined,
      autoCompactionEnabled: typeof data.autoCompactionEnabled === "boolean" ? data.autoCompactionEnabled : undefined,
      steeringMode: typeof data.steeringMode === "string" ? data.steeringMode : undefined,
      followUpMode: typeof data.followUpMode === "string" ? data.followUpMode : undefined,
      interruptMode: typeof data.interruptMode === "string" ? data.interruptMode : undefined,
      contextUsage: usage
        ? {
            tokens: typeof usage.tokens === "number" ? usage.tokens : null,
            contextWindow: typeof usage.contextWindow === "number" ? usage.contextWindow : 0,
            percent: typeof usage.percent === "number" ? usage.percent : null,
          }
        : undefined,
      todoPhases: parseTodoPhases(data.todoPhases),
    };
  }

  async listProviders(): Promise<ProviderConfig[]> {
    const keys = await loadProviderKeys(this.#paths);
    return listProviderConfigs(this.#paths, keys);
  }

  async fetchModels(baseUrl: string, apiKey: string): Promise<ProviderModel[]> {
    return fetchProviderModels(baseUrl, apiKey);
  }

  async refreshProviderModels(id: string): Promise<ProviderModel[]> {
    return refreshProviderModels(this.#paths, id);
  }

  async saveFastVibe(apiKey: string, models: ProviderModel[]): Promise<ProviderConfig[]> {
    await saveFastVibeConfig(this.#paths, apiKey, models);
    await this.reloadProviders();
    return this.listProviders();
  }

  async addProvider(
    draft: { name: string; baseUrl: string; apiKey: string },
    models: ProviderModel[],
  ): Promise<ProviderConfig[]> {
    await addProviderConfig(this.#paths, draft, models);
    await this.reloadProviders();
    return this.listProviders();
  }

  async updateProvider(
    id: string,
    patch: { name?: string; baseUrl?: string; models?: ProviderModel[]; apiKey?: string },
  ): Promise<ProviderConfig[]> {
    updateProviderConfig(this.#paths, id, {
      name: patch.name,
      baseUrl: patch.baseUrl ? patch.baseUrl.trim().replace(/\/+$/, "") : undefined,
      models: patch.models,
    });
    if (typeof patch.apiKey === "string") {
      const env = providerKeyEnv(this.#paths, id);
      if (env) await setProviderKey(this.#paths, env, patch.apiKey);
    }
    await this.reloadProviders();
    return this.listProviders();
  }

  async removeProvider(id: string): Promise<ProviderConfig[]> {
    removeProviderConfig(this.#paths, id);
    await this.reloadProviders();
    return this.listProviders();
  }

  /** Re-render models.yml and restart the engine so it picks up the new model set. */
  async reloadProviders(): Promise<OmpStatus> {
    const keys = await loadProviderKeys(this.#paths);
    if (usableProviders(this.#paths, keys).length === 0) {
      await this.stop();
      this.#setStatus({ state: "needsAuth" });
      return this.#status;
    }
    await this.stop();
    return this.start(this.#cwd);
  }

  async handleExtensionUi(event: Record<string, unknown>): Promise<void> {
    if (event.type !== "extension_ui_request") return;
    const method = String(event.method ?? "");
    if (method === "open_url") {
      const url = String(event.url ?? event.href ?? "");
      if (url.startsWith("http://") || url.startsWith("https://")) {
        await shell.openExternal(url);
      }
      return;
    }
    if (method === "confirm" || method === "select" || method === "input" || method === "editor") {
      return;
    }
  }

  #opened(
    conversation: Conversation,
    messages: ChatMessage[],
    state: OmpSessionState | null,
  ): ConversationOpenResult {
    this.#catalog.setActive(conversation.id);
    return {
      ...this.#catalog.snapshot(),
      conversation,
      messages,
      state,
      status: this.#status,
    };
  }

  #requireRpc(): OmpRpcClient {
    if (!this.#rpc || this.#status.state !== "ready") {
      throw new Error("engine not ready");
    }
    return this.#rpc;
  }

  #cleanup(): void {
    this.#unsubRpc?.();
    this.#unsubRpc = null;
    this.#rpc?.dispose();
    this.#rpc = null;
    this.#proc = null;
  }

  #setStatus(status: OmpStatus): void {
    this.#status = status;
    for (const listener of this.#statusListeners) listener(status);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTodoPhases(value: unknown): OmpSessionState["todoPhases"] {
  if (!Array.isArray(value)) return undefined;
  const phases = value.flatMap((phase) => {
    if (!isRecord(phase)) return [];
    const tasks = Array.isArray(phase.tasks)
      ? phase.tasks.flatMap((task) => {
          if (!isRecord(task) || typeof task.content !== "string") return [];
          return [
            {
              id: String(task.id ?? task.content),
              content: task.content,
              status: String(task.status ?? "pending"),
            },
          ];
        })
      : [];
    return [
      {
        id: String(phase.id ?? phase.name ?? "todos"),
        name: String(phase.name ?? "任务"),
        tasks,
      },
    ];
  });
  return phases.length > 0 ? phases : undefined;
}
