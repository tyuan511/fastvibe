import { randomUUID } from "node:crypto";
import type { BotCreateWorkRequest, BotAttention, BotChanged, BotChatMessage, BotConversationMeta, BotExecutionOutcome, BotHost, BotInput, BotProgressRequest, BotReportRequest, BotResult, BotSubmitRequest, BotActivity, BotProgress, WorkSnapshot } from "../../shared/bot.ts";
import { extractPromptAttachments, stripPromptMetadata } from "../../shared/attachment-metadata.ts";
import type { ChatAttachment, PromptImage } from "../../shared/types.ts";
import { VIVI_BOT_ID } from "../../shared/bot.ts";
import { BotStore } from "./bot-store.ts";
import { uiText } from "../engine/ui-text.ts";
import { deriveBotProgress } from "./bot-progress.ts";
import { botMemoryRefs } from "./memory/sources.ts";

export type BotContext = import("../../shared/bot.ts").BotContext;

const textOf = (value: unknown, label: string, max = 64000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}不能为空，且长度不能超过 ${max}`);
  return value.trim();
};

const imagesOf = (images: unknown): PromptImage[] | undefined => {
  if (images === undefined) return undefined;
  if (!Array.isArray(images)) throw new Error("图片附件格式无效");
  return images.map((image) => {
    if (!image || image.type !== "image" || typeof image.data !== "string" || !image.data || typeof image.mimeType !== "string" || !image.mimeType.startsWith("image/")) throw new Error("图片附件格式无效");
    return { type: "image", data: image.data, mimeType: image.mimeType };
  });
};

function imageExtension(mimeType: string): string {
  const subtype = mimeType.slice("image/".length).split("+", 1)[0].toLowerCase();
  return subtype === "jpeg" ? "jpg" : subtype || "png";
}

function displayAttachments(requestId: string, text: string, images: PromptImage[] | undefined): ChatAttachment[] | undefined {
  const attachments = extractPromptAttachments(text);
  for (const [index, image] of (images ?? []).entries()) {
    attachments.push({
      id: `image:${requestId}:${index}`,
      kind: "image",
      name: `image-${index + 1}.${imageExtension(image.mimeType)}`,
      mimeType: image.mimeType,
      dataUrl: `data:${image.mimeType};base64,${image.data}`,
    });
  }
  return attachments.length ? attachments : undefined;
}

type Active = { meta: BotConversationMeta; inputId: string; controller: AbortController; promise: Promise<void> };

/** Conversation-centric Vivi coordinator. Task/Run/Attempt are intentionally absent. */
export class BotRuntime {
  #active = new Map<string, Active>();
  #enabled = false;
  #scheduled = false;
  #recovered = false;
  #error: string | undefined;
  readonly store: BotStore;
  readonly host: BotHost;
  constructor(store: BotStore, host: BotHost) { this.store = store; this.host = host; }

  start(): void {
    if (!this.#recovered) { this.store.recover(); this.#recovered = true; }
    this.#enabled = true;
    this.#emit();
    this.#kick();
  }
  async stop(): Promise<void> {
    this.#enabled = false;
    const active = [...this.#active.values()];
    for (const job of active) job.controller.abort();
    await Promise.allSettled(active.map((job) => this.host.abort(job.meta.conversationId)));
    await Promise.allSettled(active.map((job) => job.promise));
    this.#active.clear();
    this.#recovered = false;
  }
  activity(): BotActivity {
    const waiting = this.store.attentions().some((item) => item.status === "pending");
    const first = this.#active.values().next().value as Active | undefined;
    // The input becomes running before the active job is registered. Keep that
    // transition busy too, otherwise the last queued input broadcasts idle.
    return { running: this.#active.size > 0 || this.store.inputs().some((input) => input.status === "queued" || input.status === "running"), waiting, conversationId: first?.meta.conversationId };
  }
  /** Called only after the SDK has persisted a new assistant message. */
  conversationUpdated(conversationId: string): void {
    if (this.store.conversation(conversationId)?.role !== "worker") return;
    this.#change(() => {});
  }

  async getWorkSnapshot(): Promise<WorkSnapshot> {
    const conversations = this.store.conversations();
    const inputs = this.store.inputs();
    const attention = this.store.attentions();
    const results = this.store.results();
    // Durable facts and their revision belong to one synchronous read. Preview
    // loading may yield; never re-read a newer receipt/feed under this revision.
    const snapshot: WorkSnapshot = { revision: this.store.revision, routerConversationId: this.store.routerConversationId, conversations, attention, results, deliveries: this.store.deliveries(), messages: this.store.chatMessages(), progress: conversations.map((conversation) => deriveBotProgress(conversation, inputs, attention, results)), error: this.#error };
    if (this.host.conversationPreviews) {
      try { snapshot.conversationPreviews = await this.host.conversationPreviews(conversations.filter((conversation) => conversation.role === "worker").map((conversation) => conversation.conversationId)); }
      catch { /* Reply previews must not make an otherwise readable snapshot fail. */ }
    }
    return snapshot;
  }

  async progress(input: BotProgressRequest): Promise<WorkSnapshot> {
    const meta = this.#meta(input.conversationId);
    const active = this.#active.get(meta.conversationId);
    const requestId = input.requestId ?? active?.inputId;
    const current = requestId ? this.store.input(requestId) : undefined;
    if (!active || !current || active.inputId !== current.id || current.status !== "running" || current.epoch !== meta.epoch || (input.epoch !== undefined && input.epoch !== current.epoch) || meta.paused || active.controller.signal.aborted) return this.getWorkSnapshot();
    if (!["understanding", "planning", "working", "summarizing"].includes(input.phase)) throw new Error("Unknown Vivi progress phase");
    const text = textOf(input.text, "进度说明", 4000);
    const old = current.progress;
    if (old?.phase === input.phase && old.text === text && (!input.milestone || old.milestone)) return this.getWorkSnapshot();
    const now = Date.now();
    const rootInputId = current.rootInputId ?? current.id;
    const priorMilestones = this.store.chatMessages().filter((message) => message.kind === "progress" && message.inputId === rootInputId);
    const duplicate = priorMilestones.some((message) => message.text === text);
    const throttled = priorMilestones.some((message) => now - message.createdAt < 2_000);
    this.#change(() => {
      this.store.putInput({ ...current, rootInputId, progress: { phase: input.phase, text, ...(input.milestone ? { milestone: true } : {}), updatedAt: now } });
      if (input.milestone && !duplicate && priorMilestones.length < 3 && !throttled) {
        this.store.putChatMessage({ id: `chat:progress:${current.id}:${now}`, conversationId: meta.conversationId, role: "assistant", text, inputId: rootInputId, createdAt: now, kind: "progress", title: "Vivi" });
      }
    });
    return this.getWorkSnapshot();
  }

  async createWork(input: BotCreateWorkRequest): Promise<BotConversationMeta> {
    const title = textOf(input.title, "标题", 160);
    const text = textOf(input.text, "工作要求");
    if (input.project !== undefined && input.workspace !== undefined) throw new Error("项目工作区与 Vivi 总工作区不能同时指定");
    if (input.workspace !== undefined && input.workspace !== "vivi") throw new Error("未知的 Vivi 工作区");
    const memoryRefs = botMemoryRefs(input.memoryRefs);
    const key = `work:${input.requestId}`;
    const existingInput = this.store.input(input.requestId);
    const existing = this.store.conversationByKey(key);
    if (existingInput && existing) {
      // An omitted project on replay keeps the original binding. Explicitly asking
      // for another workspace under the same creation key is a different request.
      if (existingInput.text !== text || JSON.stringify(existingInput.memoryRefs ?? []) !== JSON.stringify(memoryRefs ?? []) || ((input.project !== undefined || input.workspace !== undefined) && this.host.resolveProject(input.project, input.workspace === "vivi" ? undefined : key) !== existing.project)) throw new Error("相同请求标识不能提交不同内容");
      return existing;
    }
    const project = this.host.resolveProject(input.project, input.workspace === "vivi" ? undefined : key);
    const created = await this.host.createConversation({ kind: "worker", key, project: input.project, workspace: input.workspace });
    const conversationId = typeof created === "string" ? created : created.conversationId;
    const now = Date.now();
    const meta: BotConversationMeta = { conversationId, role: "worker", owner: VIVI_BOT_ID, creationKey: key, epoch: 0, paused: false, createdAt: now, updatedAt: now, title, project };
    this.#change(() => { this.store.putConversation(meta); this.store.putInput({ id: input.requestId, conversationId: meta.conversationId, epoch: 0, source: "router", text, memoryRefs, status: "queued", createdAt: now, rootInputId: this.#routerInput()?.rootInputId ?? this.#routerInput()?.id }); });
    this.#kick();
    return meta;
  }

  async submit(input: BotSubmitRequest): Promise<WorkSnapshot> { return this.#submit(input, "user"); }
  async routeMessage(input: BotSubmitRequest): Promise<WorkSnapshot> { return this.#submit(input, "router"); }
  async #submit(input: BotSubmitRequest, source: "user" | "router"): Promise<WorkSnapshot> {
    const requestId = textOf(input.requestId, "请求标识", 200);
    const images = imagesOf(input.images);
    const memoryRefs = botMemoryRefs(input.memoryRefs);
    const text = typeof input.text === "string" && !input.text.trim() && images?.length ? "" : textOf(input.text, "消息");
    let meta = input.conversationId ? this.#meta(input.conversationId) : undefined;
    if (!meta) {
      const routerId = this.store.routerConversationId;
      if (routerId) meta = this.#meta(routerId);
      else {
        this.host.resolveProject();
        const created = await this.host.createConversation({ kind: "router", key: "router:vivi" });
        const conversationId = typeof created === "string" ? created : created.conversationId;
        const now = Date.now();
        meta = { conversationId, role: "router", owner: VIVI_BOT_ID, creationKey: "router:vivi", epoch: 0, paused: false, createdAt: now, updatedAt: now };
        this.#change(() => { this.store.setRouterConversationId(meta!.conversationId); this.store.putConversation(meta!); });
      }
    }
    const prior = this.store.input(requestId);
    if (prior) {
      if (prior.text !== text || prior.conversationId !== meta.conversationId || JSON.stringify(prior.images ?? []) !== JSON.stringify(images ?? []) || JSON.stringify(prior.memoryRefs ?? []) !== JSON.stringify(memoryRefs ?? [])) throw new Error("相同请求标识不能提交不同内容");
      return this.getWorkSnapshot();
    }
    if (meta.paused && meta.role !== "router") throw new Error("会话已暂停，请先继续");
    const now = Math.max(Date.now(), (this.store.chatMessages().at(-1)?.createdAt ?? 0) + 1);
    this.#change(() => {
      if (meta!.paused) this.store.putConversation({ ...meta!, paused: false, updatedAt: now });
      this.store.putInput({ id: requestId, conversationId: meta!.conversationId, epoch: meta!.epoch, source, text, images, memoryRefs, status: "queued", createdAt: now, rootInputId: source === "router" ? (this.#routerInput()?.rootInputId ?? this.#routerInput()?.id) : requestId });
      if (source === "user") {
        this.store.putChatMessage({
          id: `chat:user:${requestId}`,
          conversationId: meta!.conversationId,
          role: "user",
          // Parse the original prompt before textOf trims the leading blank line
          // that anchors metadata-only file/paste submissions.
          text: stripPromptMetadata(input.text).trim(),
          attachments: displayAttachments(requestId, input.text, images),
          inputId: requestId,
          createdAt: now,
        });
      }
    });
    this.#kick();
    return this.getWorkSnapshot();
  }

  async reply(input: { conversationId: string; text: string; requestId?: string; epoch?: number }): Promise<BotChatMessage> {
    const meta = this.#meta(input.conversationId);
    if (meta.role !== "router") throw new Error("只有 Router 可以向 Vivi 聊天发送消息");
    const active = this.#active.get(meta.conversationId);
    const requestId = input.requestId ?? active?.inputId;
    const current = requestId ? this.store.input(requestId) : undefined;
    if (!active || !current || active.inputId !== current.id || current.status !== "running" || current.epoch !== meta.epoch || (input.epoch !== undefined && input.epoch !== current.epoch) || meta.paused || active.controller.signal.aborted) throw new Error("Vivi 当前回合已结束，不能发送这条回复");
    const createdAt = Math.max(Date.now(), (this.store.chatMessages().at(-1)?.createdAt ?? 0) + 1);
    const message: BotChatMessage = { id: `chat:assistant:${randomUUID()}`, conversationId: meta.conversationId, role: "assistant", text: textOf(input.text, "回复", 16000), inputId: current.id, createdAt, kind: "message" };
    this.#change(() => this.store.putChatMessage(message));
    this.#emitMessage(message);
    return message;
  }

  async report(input: BotReportRequest): Promise<BotResult> {
    const meta = this.#meta(input.conversationId);
    const request = input as BotReportRequest & { epoch?: number };
    const active = this.#active.get(meta.conversationId);
    const requestId = request.requestId ?? active?.inputId;
    const current = requestId ? this.store.input(requestId) : undefined;
    if (!active || !current || active.inputId !== current.id || current.status !== "running" || current.epoch !== meta.epoch || (request.epoch !== undefined && request.epoch !== current.epoch) || meta.paused || active.controller.signal.aborted) throw new Error("Vivi 当前回合已结束，不能提交结果");
    const existingResult = this.store.results(meta.conversationId).find((item) => item.inputId === current.id && item.epoch === current.epoch && item.status !== "idle");
    if (existingResult) return existingResult;
    const summary = textOf(input.summary, "结果摘要", 16000);
    const status = input.outcome ?? "idle";
    if (!["idle", "ready", "blocked", "failed", "uncertain"].includes(status)) throw new Error("未知的结果状态");
    const result: BotResult = { id: `result:${randomUUID()}`, conversationId: meta.conversationId, inputId: current.id, epoch: current.epoch, status, summary, evidence: input.evidence ?? [], artifacts: input.artifacts ?? [], createdAt: Date.now() };
    this.#saveResult(meta, current, result);
    return result;
  }

  #saveResult(meta: BotConversationMeta, current: BotInput, result: BotResult): void {
    this.#change(() => {
      this.store.putResult(result);
      const message: BotChatMessage = { id: `chat:result:${current.id}`, conversationId: meta.conversationId, role: "assistant", text: result.summary ?? "", inputId: current.id, createdAt: result.createdAt, kind: "result", title: meta.title ?? "Vivi", result };
      if (this.store.chatMessage(message.id)) this.store.updateChatMessage(message);
      else this.store.putChatMessage(message);
      const router = this.store.routerConversationId;
      if (meta.role === "worker" && result.status !== "idle" && router) {
        const evidence = result.evidence?.length ? `\nEvidence: ${result.evidence.join("; ")}` : "";
        const artifacts = result.artifacts?.length ? `\nArtifacts: ${result.artifacts.join("; ")}` : "";
        this.store.putDelivery({ id: `delivery:${result.id}`, conversationId: meta.conversationId, targetConversationId: router, status: "pending", text: `[Worker result ${result.status}] ${result.summary}${evidence}${artifacts}`, resultId: result.id, createdAt: Date.now() });
      }
    });
  }

  async ask(input: { conversationId: string; requestId?: string; question: string; epoch?: number }): Promise<BotAttention> {
    const meta = this.#meta(input.conversationId);
    const active = this.#active.get(meta.conversationId);
    const requestId = input.requestId ?? active?.inputId;
    const current = requestId ? this.store.input(requestId) : undefined;
    if (!active || !current || active.inputId !== current.id || current.status !== "running" || current.epoch !== meta.epoch || (input.epoch !== undefined && input.epoch !== current.epoch) || meta.paused || active.controller.signal.aborted) throw new Error("Vivi 当前回合已结束，不能提出问题");
    const attention: BotAttention = { id: `attention:${randomUUID()}`, conversationId: meta.conversationId, inputId: current.id, epoch: current.epoch, question: textOf(input.question, "问题", 4000), status: "pending", createdAt: Date.now() };
    this.#change(() => { this.store.putAttention(attention); this.store.putConversation({ ...meta, paused: true, updatedAt: Date.now() }); });
    return attention;
  }

  async answer(input: { attentionId?: string; questionId?: string; answer: string } | string, legacyAnswer?: string): Promise<WorkSnapshot> {
    if (typeof input === "string") input = { questionId: input, answer: legacyAnswer ?? "" };
    const attentionId = input.attentionId ?? input.questionId;
    if (!attentionId) throw new Error("缺少问题标识");
    const attention = this.store.attention(attentionId);
    if (!attention || attention.status !== "pending") throw new Error("这个问题已处理或过期");
    const meta = this.#meta(attention.conversationId);
    const answer = textOf(input.answer, "回答", 16000);
    this.#change(() => {
      this.store.putAttention({ ...attention, answer, status: "resolved" });
      const next = { ...meta, paused: false, epoch: meta.epoch + 1, updatedAt: Date.now() };
      this.store.putConversation(next);
      this.store.putInput({ id: `answer:${attention.id}`, conversationId: next.conversationId, epoch: next.epoch, source: "answer", text: answer, status: "queued", createdAt: Date.now() });
      this.store.putChatMessage({ id: `chat:user:answer:${attention.id}`, conversationId: next.conversationId, role: "user", text: answer, inputId: `answer:${attention.id}`, createdAt: Date.now() });
    });
    this.#kick();
    return this.getWorkSnapshot();
  }

  async stopConversation(input: { conversationId: string; callerConversationId?: string }): Promise<WorkSnapshot> {
    const meta = this.#meta(input.conversationId);
    this.#change(() => {
      this.store.putConversation({ ...meta, epoch: meta.epoch + 1, paused: true, updatedAt: Date.now() });
      for (const attention of this.store.attentions(meta.conversationId)) if (attention.status === "pending") this.store.putAttention({ ...attention, status: "withdrawn" });
      for (const delivery of this.store.deliveries()) if ((delivery.conversationId === meta.conversationId || delivery.targetConversationId === meta.conversationId) && (delivery.status === "pending" || delivery.status === "injected")) this.store.updateDelivery({ ...delivery, status: "failed" });
      for (const item of this.store.inputs(meta.conversationId)) {
        if (item.status === "queued") this.store.putInput({ ...item, status: "canceled" });
        else if (item.status === "running") this.store.putInput({ ...item, status: "uncertain", error: "会话已停止，请核对现场后继续" });
      }
    });
    const active = this.#active.get(meta.conversationId);
    active?.controller.abort();
    if (active && input.callerConversationId !== meta.conversationId) await this.host.abort(meta.conversationId);
    return this.getWorkSnapshot();
  }
  async continueConversation(input: { conversationId: string }): Promise<WorkSnapshot> {
    const meta = this.#meta(input.conversationId);
    if (!meta.paused && (this.#active.has(meta.conversationId) || this.store.inputs(meta.conversationId).some((item) => item.epoch === meta.epoch && item.status === "queued"))) return this.getWorkSnapshot();
    if (this.store.attentions(meta.conversationId).some((item) => item.status === "pending")) throw new Error(uiText("请先回答当前问题。", "Please answer the pending question first."));
    this.#change(() => {
      this.store.putConversation({ ...meta, paused: false, epoch: meta.epoch + 1, updatedAt: Date.now() });
      const next = this.#meta(meta.conversationId);
      const pendingReports = next.role === "router" ? this.store.deliveries().filter((delivery) => delivery.targetConversationId === next.conversationId && delivery.status === "injected") : [];
      const resumeText = pendingReports.length
        ? `Continue the unfinished work. Review these existing result updates and summarize them for the user; do not repeat completed work.\n${pendingReports.map((delivery) => delivery.text).join("\n\n")}`
        : "Continue the unfinished work from the current conversation.";
      this.store.putInput({ id: `resume:${next.conversationId}:${next.epoch}`, conversationId: next.conversationId, epoch: next.epoch, source: "resume", text: resumeText, ...(pendingReports.length ? { deliveryIds: pendingReports.map((delivery) => delivery.id) } : {}), status: "queued", createdAt: Date.now() });
    });
    this.#kick();
    return this.getWorkSnapshot();
  }
  async stopAll(): Promise<WorkSnapshot> { await Promise.all(this.store.conversations().map((item) => this.stopConversation({ conversationId: item.conversationId }))); return this.getWorkSnapshot(); }

  #routerInput(): BotInput | undefined {
    const routerId = this.store.routerConversationId;
    const active = routerId ? this.#active.get(routerId) : undefined;
    return active ? this.store.input(active.inputId) : undefined;
  }

  contextFor(conversationId: string): import("../../shared/bot.ts").BotContext {
    const meta = this.store.conversation(conversationId);
    const active = this.#active.get(conversationId);
    const input = active ? this.store.input(active.inputId) : undefined;
    return {
      role: meta?.role ?? "worker", conversationId, active: Boolean(active && input && input.status === "running" && meta && !meta.paused), phase: meta && meta.paused ? "waiting" : active && input?.status === "running" ? "running" : "inactive",
      input: input ? { requestId: input.id, epoch: input.epoch } : undefined,
      conversations: this.store.conversations(),
      progress: this.store.conversations().filter((item) => meta?.role === "router" || item.conversationId === conversationId).map((item) => deriveBotProgress(item, this.store.inputs(), this.store.attentions(), this.store.results())),
      results: meta?.role === "router" ? this.store.results() : this.store.results(conversationId),
      attention: this.store.attentions(meta?.role === "router" ? undefined : conversationId).filter((item) => item.status === "pending"),
    };
  }

  #emitDelivery(delivery: import("../../shared/bot.ts").BotDelivery): void { try { this.host.changed({ revision: this.store.revision, delivery: { id: delivery.id, conversationId: delivery.conversationId, text: delivery.text } }); } catch (error) { this.#error = error instanceof Error ? error.message : String(error); } }
  #emitMessage(message: BotChatMessage): void { try { this.host.changed({ revision: this.store.revision, message: { id: message.id, conversationId: message.conversationId, role: message.role, text: message.text } }); } catch (error) { this.#error = error instanceof Error ? error.message : String(error); } }

  #meta(id: string): BotConversationMeta { const value = this.store.conversation(id); if (!value) throw new Error("找不到 Vivi 会话"); return value; }
  #change(fn: () => void): void { this.store.transaction(() => { fn(); this.store.bumpRevision(); }); this.#emit(); }
  #emit(): void { try { this.host.changed({ revision: this.store.revision, activity: this.activity() }); } catch (error) { this.#error = error instanceof Error ? error.message : String(error); } }
  #kick(): void { if (!this.#enabled || this.#scheduled) return; this.#scheduled = true; queueMicrotask(() => { this.#scheduled = false; this.#pump(); }); }
  #pump(): void {
    if (!this.#enabled) return;
    const routerId = this.store.routerConversationId;
    if (routerId) {
      for (const delivery of this.store.deliveries("pending")) {
        const router = this.store.conversation(routerId);
        if (!router || router.paused || delivery.targetConversationId !== routerId) continue;
        if (!this.store.input(delivery.id)) {
          this.#change(() => {
            this.store.putInput({ id: delivery.id, conversationId: routerId, epoch: router.epoch, source: "report", text: delivery.text, status: "queued", createdAt: Date.now() });
            this.store.updateDelivery({ ...delivery, status: "injected" });
          });
        }
      }
    }
    for (const meta of this.store.conversations()) {
      if (meta.paused || this.#active.has(meta.conversationId)) continue;
      const input = this.store.inputs(meta.conversationId).filter((item) => item.status === "queued" && item.epoch === meta.epoch).sort((a, b) => Number(a.source === "report") - Number(b.source === "report") || a.createdAt - b.createdAt)[0];
      if (!input) continue;
      const phase = meta.role === "router" ? input.source === "report" ? "summarizing" : "understanding" : "working";
      const detail = phase === "summarizing"
        ? uiText("正在整理已有结果。", "Putting the available results together.")
        : phase === "understanding"
          ? uiText("正在理解你的要求。", "Understanding your request.")
          : uiText("正在处理这件事。", "Working on this request.");
      this.#change(() => this.store.putInput({ ...input, status: "running", startedAt: input.startedAt ?? Date.now(), progress: input.progress ?? { phase, text: detail, updatedAt: Date.now() } }));
      const controller = new AbortController();
      const active: Active = { meta, inputId: input.id, controller, promise: Promise.resolve() };
      this.#active.set(meta.conversationId, active);
      active.promise = this.#execute(active, input).catch((error) => {
        this.#error = error instanceof Error ? error.message : String(error);
        const receipt = this.store.input(input.id);
        if (receipt?.status === "running") this.#change(() => this.store.putInput({ ...receipt, status: "failed", completedAt: Date.now(), error: this.#error }));
      }).finally(() => {
        this.#active.delete(meta.conversationId);
        this.#change(() => {});
        try { this.host.settled?.(input.id); } catch (error) { console.warn("[vivi-memory] maintenance scheduling failed", error); }
        this.#kick();
      });
    }
  }
  async #execute(active: Active, payload: BotInput): Promise<void> {
    let outcome: BotExecutionOutcome;
    try { outcome = await this.host.execute({ conversationId: active.meta.conversationId, requestId: active.inputId, text: payload.text, images: payload.images, epoch: active.meta.epoch, signal: active.controller.signal }); }
    catch (error) { outcome = { status: active.controller.signal.aborted ? "interrupted" : "failed", text: "", error: error instanceof Error ? error.message : String(error) }; }
    if (active.controller.signal.aborted) outcome = { status: "interrupted", text: outcome.text, error: uiText("处理已中断，已有结果仍保留，可以继续。", "Work was interrupted; existing results are kept and can be continued.") };
    const current = this.store.conversation(active.meta.conversationId);
    const input = this.store.input(active.inputId);
    if (!current || !input || current.epoch !== active.meta.epoch || input.status === "canceled") return;
    const delivery = this.store.delivery(active.inputId);
    // Fallback persistence must happen while the receipt is still running. The public
    // reply/report methods deliberately reject stale calls after Stop; calling them
    // after the terminal input update would reject every ordinary SDK completion.
    if (active.meta.role === "router" && outcome.status === "completed" && outcome.text.trim() && !current.paused) {
      if (!this.store.hasChatMessage(active.inputId, "assistant", "message")) await this.reply({ conversationId: active.meta.conversationId, text: outcome.text, requestId: active.inputId, epoch: active.meta.epoch });
    }
    if ((active.meta.role === "worker" || outcome.status !== "completed") && !current.paused) {
      const previous = this.store.results(active.meta.conversationId).filter((result) => result.inputId === active.inputId && result.epoch === active.meta.epoch).at(-1);
      if (!previous || outcome.status !== "completed") {
        this.#saveResult(current, input, { id: previous?.id ?? `result:${input.id}`, conversationId: current.conversationId, inputId: input.id, epoch: current.epoch, status: outcome.status === "completed" ? "idle" : outcome.status === "interrupted" ? "uncertain" : "failed", summary: outcome.error ?? (outcome.text.trim() || uiText("执行结束，但没有确认完成的结果。", "Execution ended without a confirmed result.")), evidence: previous?.evidence, artifacts: previous?.artifacts, createdAt: Date.now() });
      }
    }
    // reply() yields after persistence. A Stop in that gap owns the receipt now.
    const settled = this.store.input(active.inputId);
    if (this.store.conversation(current.conversationId)?.epoch !== active.meta.epoch || settled?.status !== "running") return;
    const settledAt = Date.now();
    this.#change(() => {
      this.store.putInput({ ...settled, status: outcome.status === "completed" ? "completed" : outcome.status === "interrupted" ? "uncertain" : "failed", completedAt: settledAt, error: outcome.error });
      if (delivery && outcome.status === "completed") this.store.updateDelivery({ ...delivery, status: "delivered" });
      if (delivery && outcome.status !== "completed") this.store.updateDelivery({ ...delivery, status: "failed" });
      // Explicit resume consumes existing updates without creating another Worker or
      // reinjecting the old input. New arrivals are not part of this receipt.
      if (outcome.status === "completed") for (const id of settled.deliveryIds ?? []) {
        const resumed = this.store.delivery(id);
        if (resumed?.status === "injected" && resumed.targetConversationId === current.conversationId) this.store.updateDelivery({ ...resumed, status: "delivered" });
      }
    });
    if (outcome.status === "completed") this.#error = undefined;
    if (outcome.status !== "completed") this.#error = outcome.error ?? "Vivi 会话执行未完成";
    if (delivery && outcome.status === "completed") this.#emitDelivery({ ...delivery, status: "delivered" });
  }
}
