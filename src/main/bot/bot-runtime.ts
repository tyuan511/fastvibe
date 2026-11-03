import { randomUUID } from "node:crypto";
import type { BotAttention, BotChanged, BotChatMessage, BotConversationMeta, BotExecutionOutcome, BotHost, BotInput, BotReportRequest, BotResult, BotSubmitRequest, BotActivity, WorkSnapshot } from "../../shared/bot.ts";
import { extractPromptAttachments, stripPromptMetadata } from "../../shared/attachment-metadata.ts";
import type { ChatAttachment, PromptImage } from "../../shared/types.ts";
import { VIVI_BOT_ID } from "../../shared/bot.ts";
import { BotStore } from "./bot-store.ts";

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
  }
  activity(): BotActivity {
    const waiting = this.store.attentions().some((item) => item.status === "pending");
    const first = this.#active.values().next().value as Active | undefined;
    return { running: this.#active.size > 0 || this.store.inputs().some((input) => input.status === "queued"), waiting, conversationId: first?.meta.conversationId };
  }
  async getWorkSnapshot(): Promise<WorkSnapshot> {
    return { revision: this.store.revision, routerConversationId: this.store.routerConversationId, conversations: this.store.conversations(), attention: this.store.attentions(), results: this.store.results(), deliveries: this.store.deliveries(), messages: this.store.chatMessages(), error: this.#error };
  }

  async createWork(input: { requestId: string; title: string; text: string }): Promise<BotConversationMeta> {
    const title = textOf(input.title, "标题", 160);
    const text = textOf(input.text, "工作要求");
    const key = `work:${input.requestId}`;
    const existingInput = this.store.input(input.requestId);
    const existing = this.store.conversationByKey(key);
    if (existingInput && existing) { if (existingInput.text !== text) throw new Error("相同请求标识不能提交不同内容"); return existing; }
    const project = this.host.resolveProject();
    const created = await this.host.createConversation({ kind: "worker", key });
    const conversationId = typeof created === "string" ? created : created.conversationId;
    const now = Date.now();
    const meta: BotConversationMeta = { conversationId, role: "worker", owner: VIVI_BOT_ID, creationKey: key, epoch: 0, paused: false, createdAt: now, updatedAt: now, title, project };
    this.#change(() => { this.store.putConversation(meta); this.store.putInput({ id: input.requestId, conversationId: meta.conversationId, epoch: 0, source: "router", text, status: "queued", createdAt: now }); });
    this.#kick();
    return meta;
  }

  async submit(input: BotSubmitRequest): Promise<WorkSnapshot> { return this.#submit(input, "user"); }
  async routeMessage(input: BotSubmitRequest): Promise<WorkSnapshot> { return this.#submit(input, "router"); }
  async #submit(input: BotSubmitRequest, source: "user" | "router"): Promise<WorkSnapshot> {
    const requestId = textOf(input.requestId, "请求标识", 200);
    const images = imagesOf(input.images);
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
      if (prior.text !== text || prior.conversationId !== meta.conversationId || JSON.stringify(prior.images ?? []) !== JSON.stringify(images ?? [])) throw new Error("相同请求标识不能提交不同内容");
      return this.getWorkSnapshot();
    }
    if (meta.paused && meta.role !== "router") throw new Error("会话已暂停，请先继续");
    const now = Math.max(Date.now(), (this.store.chatMessages().at(-1)?.createdAt ?? 0) + 1);
    this.#change(() => {
      if (meta!.paused) this.store.putConversation({ ...meta!, paused: false, updatedAt: now });
      this.store.putInput({ id: requestId, conversationId: meta!.conversationId, epoch: meta!.epoch, source, text, images, status: "queued", createdAt: now });
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

  async reply(input: { conversationId: string; text: string }): Promise<BotChatMessage> {
    const meta = this.#meta(input.conversationId);
    if (meta.role !== "router") throw new Error("只有 Router 可以向 Vivi 聊天发送消息");
    const createdAt = Math.max(Date.now(), (this.store.chatMessages().at(-1)?.createdAt ?? 0) + 1);
    const message: BotChatMessage = { id: `chat:assistant:${randomUUID()}`, conversationId: meta.conversationId, role: "assistant", text: textOf(input.text, "回复", 16000), inputId: this.#active.get(meta.conversationId)?.inputId, createdAt };
    this.#change(() => this.store.putChatMessage(message));
    this.#emitMessage(message);
    return message;
  }

  async report(input: BotReportRequest): Promise<BotResult> {
    const meta = this.#meta(input.conversationId);
    const summary = textOf(input.summary, "结果摘要", 16000);
    const status = input.outcome ?? "idle";
    if (!["idle", "ready", "blocked", "failed", "uncertain"].includes(status)) throw new Error("未知的结果状态");
    const result: BotResult = { id: `result:${randomUUID()}`, conversationId: meta.conversationId, inputId: input.requestId, epoch: meta.epoch, status, summary, evidence: input.evidence ?? [], artifacts: input.artifacts ?? [], createdAt: Date.now() };
    this.#change(() => this.store.putResult(result));
    if (meta.role === "worker" && status !== "idle") {
      const router = this.store.routerConversationId;
      if (router) {
        const delivery = { id: `delivery:${result.id}`, conversationId: meta.conversationId, targetConversationId: router, status: "pending" as const, text: `[Worker result ${result.status}] ${summary}`, resultId: result.id, createdAt: Date.now() };
        this.#change(() => this.store.putDelivery(delivery));
      }
    }
    return result;
  }

  async ask(input: { conversationId: string; requestId?: string; question: string }): Promise<BotAttention> {
    const meta = this.#meta(input.conversationId);
    const attention: BotAttention = { id: `attention:${randomUUID()}`, conversationId: meta.conversationId, inputId: input.requestId, epoch: meta.epoch, question: textOf(input.question, "问题", 4000), status: "pending", createdAt: Date.now() };
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
    this.#change(() => {
      this.store.putConversation({ ...meta, paused: false, epoch: meta.epoch + 1, updatedAt: Date.now() });
      const next = this.#meta(meta.conversationId);
      this.store.putInput({ id: `resume:${next.conversationId}:${next.epoch}`, conversationId: next.conversationId, epoch: next.epoch, source: "resume", text: "Continue the unfinished work from the current conversation.", status: "queued", createdAt: Date.now() });
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
      role: meta?.role ?? "worker", conversationId, active: Boolean(meta && !meta.paused), phase: meta && !meta.paused ? "running" : "inactive",
      ...(meta?.role === "router" ? { input: input ? { requestId: input.id } : undefined, conversations: this.store.conversations() } : {}),
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
      const input = this.store.inputs(meta.conversationId).find((item) => item.status === "queued" && item.epoch === meta.epoch);
      if (!input) continue;
      this.#change(() => this.store.putInput({ ...input, status: "running" }));
      const controller = new AbortController();
      const active: Active = { meta, inputId: input.id, controller, promise: Promise.resolve() };
      this.#active.set(meta.conversationId, active);
      active.promise = this.#execute(active, input).finally(() => { this.#active.delete(meta.conversationId); this.#emit(); this.#kick(); });
    }
  }
  async #execute(active: Active, payload: BotInput): Promise<void> {
    let outcome: BotExecutionOutcome;
    try { outcome = await this.host.execute({ conversationId: active.meta.conversationId, requestId: active.inputId, text: payload.text, images: payload.images, epoch: active.meta.epoch, signal: active.controller.signal }); }
    catch (error) { outcome = { status: active.controller.signal.aborted ? "interrupted" : "failed", text: "", error: error instanceof Error ? error.message : String(error) }; }
    const current = this.store.conversation(active.meta.conversationId);
    const input = this.store.input(active.inputId);
    if (!current || !input || current.epoch !== active.meta.epoch || input.status === "canceled") return;
    const delivery = this.store.delivery(active.inputId);
    this.#change(() => {
      this.store.putInput({ ...input, status: outcome.status === "completed" ? "completed" : outcome.status === "interrupted" ? "uncertain" : "failed", error: outcome.error });
      if (outcome.status !== "completed") this.store.putResult({ id: `result:${active.inputId}`, conversationId: active.meta.conversationId, inputId: active.inputId, epoch: active.meta.epoch, status: outcome.status === "interrupted" ? "uncertain" : "failed", summary: outcome.error, createdAt: Date.now() });
      if (delivery && outcome.status === "completed") this.store.updateDelivery({ ...delivery, status: "delivered" });
      if (delivery && outcome.status !== "completed") this.store.updateDelivery({ ...delivery, status: "failed" });
    });
    if (outcome.status === "completed") this.#error = undefined;
    if (outcome.status !== "completed") this.#error = outcome.error ?? "Vivi 会话执行未完成";
    if (delivery && outcome.status === "completed") this.#emitDelivery({ ...delivery, status: "delivered" });
    if (outcome.status === "completed" && outcome.text.trim()) {
      if (active.meta.role === "router") {
        if (!this.store.hasChatMessage(active.inputId, "assistant")) await this.reply({ conversationId: active.meta.conversationId, text: outcome.text });
      } else {
        // A Worker without a structured report still gets an internal result for Router.
        await this.report({ conversationId: active.meta.conversationId, requestId: active.inputId, summary: outcome.text, outcome: "idle" });
      }
    }
  }
}
