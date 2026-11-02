import { randomUUID } from "node:crypto";
import type { BotAttention, BotChanged, BotConversationMeta, BotExecutionOutcome, BotHost, BotReportRequest, BotResult, BotSubmitRequest, BotActivity, WorkSnapshot } from "../../shared/bot.ts";
import { VIVI_BOT_ID } from "../../shared/bot.ts";
import { BotStore } from "./bot-store.ts";

export type BotContext = import("../../shared/bot.ts").BotContext;

const textOf = (value: unknown, label: string, max = 64000): string => {
  if (typeof value !== "string" || !value.trim() || value.length > max) throw new Error(`${label}不能为空，且长度不能超过 ${max}`);
  return value.trim();
};


type Active = { meta: BotConversationMeta; inputId: string; controller: AbortController; promise: Promise<void> };

/** Conversation-centric Vivi coordinator. Task/Run/Attempt are intentionally absent. */
export class BotRuntime {
  #active = new Map<string, Active>();
  #enabled = false;
  #scheduled = false;
  #recovered = false;
  #error: string | undefined;
  constructor(readonly store: BotStore, readonly host: BotHost) {}

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
    return { revision: this.store.revision, routerConversationId: this.store.routerConversationId, conversations: this.store.conversations(), attention: this.store.attentions(), results: this.store.results(), deliveries: this.store.deliveries(), error: this.#error };
  }

  async createWork(input: { requestId: string; title: string; text: string; project?: string }): Promise<BotConversationMeta> {
    const title = textOf(input.title, "标题", 160);
    const text = textOf(input.text, "工作要求");
    const key = `work:${input.requestId}`;
    const existingInput = this.store.input(input.requestId);
    const existing = this.store.conversationByKey(key);
    if (existingInput && existing) { if (existingInput.text !== text) throw new Error("相同请求标识不能提交不同内容"); return existing; }
    const project = this.host.resolveProject(input.project);
    const created = await this.host.createConversation({ kind: "worker", key, project });
    const conversationId = typeof created === "string" ? created : created.conversationId;
    const now = Date.now();
    const meta: BotConversationMeta = { conversationId, role: "worker", owner: VIVI_BOT_ID, creationKey: key, epoch: 0, paused: false, createdAt: now, updatedAt: now, title, project };
    this.#change(() => { this.store.putConversation(meta); this.store.putInput({ id: input.requestId, conversationId: meta.conversationId, epoch: 0, source: "user", text, status: "queued", createdAt: now }); });
    this.#kick();
    return meta;
  }

  async submit(input: BotSubmitRequest): Promise<WorkSnapshot> {
    const requestId = textOf(input.requestId, "请求标识", 200);
    const text = textOf(input.text, "消息");
    let meta = input.conversationId ? this.#meta(input.conversationId) : undefined;
    if (!meta) {
      const routerId = this.store.routerConversationId;
      if (routerId) meta = this.#meta(routerId);
      else {
        const created = await this.host.createConversation({ kind: "router", key: "router:vivi", project: this.host.resolveProject(input.project) });
        const conversationId = typeof created === "string" ? created : created.conversationId;
        const now = Date.now();
        meta = { conversationId, role: "router", owner: VIVI_BOT_ID, creationKey: "router:vivi", epoch: 0, paused: false, createdAt: now, updatedAt: now };
        this.#change(() => { this.store.setRouterConversationId(meta!.conversationId); this.store.putConversation(meta!); });
      }
    }
    const prior = this.store.input(requestId);
    if (prior) { if (prior.text !== text || prior.conversationId !== meta.conversationId) throw new Error("相同请求标识不能提交不同内容"); return this.getWorkSnapshot(); }
    if (meta.paused) throw new Error("会话已暂停，请先继续");
    this.#change(() => this.store.putInput({ id: requestId, conversationId: meta!.conversationId, epoch: meta!.epoch, source: "user", text, status: "queued", createdAt: Date.now() }));
    this.#kick();
    return this.getWorkSnapshot();
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
    });
    this.#kick();
    return this.getWorkSnapshot();
  }

  async stopConversation(input: { conversationId: string; callerConversationId?: string }): Promise<WorkSnapshot> {
    const meta = this.#meta(input.conversationId);
    this.#change(() => { this.store.putConversation({ ...meta, epoch: meta.epoch + 1, paused: true, updatedAt: Date.now() }); for (const item of this.store.inputs(meta.conversationId)) if (item.status === "queued") this.store.putInput({ ...item, status: "canceled" }); });
    const active = this.#active.get(meta.conversationId);
    active?.controller.abort();
    if (active && input.callerConversationId !== meta.conversationId) await this.host.abort(meta.conversationId);
    return this.getWorkSnapshot();
  }
  async continueConversation(input: { conversationId: string }): Promise<WorkSnapshot> {
    const meta = this.#meta(input.conversationId);
    this.#change(() => this.store.putConversation({ ...meta, paused: false, epoch: meta.epoch + 1, updatedAt: Date.now() }));
    this.#kick();
    return this.getWorkSnapshot();
  }
  async stopAll(): Promise<WorkSnapshot> { await Promise.all(this.store.conversations().map((item) => this.stopConversation({ conversationId: item.conversationId }))); return this.getWorkSnapshot(); }

  /** Migration adapter only. New callers must use conversation methods above. */
  contextFor(conversationId: string): import("../../shared/bot.ts").BotContext { const meta = this.store.conversation(conversationId); return { role: meta?.role ?? "worker", conversationId, active: Boolean(meta && !meta.paused), phase: meta && !meta.paused ? "running" : "inactive" }; }
  createTask(_input: import("../../shared/bot.ts").BotCreateTask): never { throw new Error("旧 Task API 已移除，请使用 createWork"); }
  reportTask(_conversationId: string, _report: import("../../shared/bot.ts").BotReport): never { throw new Error("旧 Task API 已移除，请使用 report"); }
  askTask(_conversationId: string, _question: string): never { throw new Error("旧 Task API 已移除，请使用 ask"); }
  /** Compatibility aliases are deliberately non-functional until integration switches. */
  getSnapshot(): Promise<WorkSnapshot> { return this.getWorkSnapshot(); }
  getTask(_taskId: string, _attemptId?: string): never { throw new Error("旧 Task API 已移除，请通过 engine snapshot 读取会话内容"); }
  stopTask(_taskId: string, _callerConversationId?: string): never { throw new Error("旧 Task API 已移除，请使用 stopConversation"); }
  retryTask(_taskId: string): never { throw new Error("旧 Task API 已移除，请使用 continueConversation"); }
  retryRun(_runId: string): never { throw new Error("旧 Run API 已移除，请使用 continueConversation"); }

  #meta(id: string): BotConversationMeta { const value = this.store.conversation(id); if (!value) throw new Error("找不到 Vivi 会话"); return value; }
  #change(fn: () => void): void { this.store.transaction(() => { fn(); this.store.bumpRevision(); }); this.#emit(); }
  #emit(): void { try { this.host.changed({ revision: this.store.revision, activity: this.activity() }); } catch (error) { this.#error = error instanceof Error ? error.message : String(error); } }
  #kick(): void { if (!this.#enabled || this.#scheduled) return; this.#scheduled = true; queueMicrotask(() => { this.#scheduled = false; this.#pump(); }); }
  #pump(): void {
    if (!this.#enabled) return;
    for (const meta of this.store.conversations()) {
      if (meta.paused || this.#active.has(meta.conversationId)) continue;
      const input = this.store.inputs(meta.conversationId).find((item) => item.status === "queued" && item.epoch === meta.epoch);
      if (!input) continue;
      this.#change(() => this.store.putInput({ ...input, status: "running" }));
      const controller = new AbortController();
      const active: Active = { meta, inputId: input.id, controller, promise: Promise.resolve() };
      this.#active.set(meta.conversationId, active);
      active.promise = this.#execute(active, input.text).finally(() => { this.#active.delete(meta.conversationId); this.#emit(); this.#kick(); });
    }
  }
  async #execute(active: Active, text: string): Promise<void> {
    let outcome: BotExecutionOutcome;
    try { outcome = await this.host.execute({ conversationId: active.meta.conversationId, requestId: active.inputId, text, epoch: active.meta.epoch, signal: active.controller.signal }); }
    catch (error) { outcome = { status: active.controller.signal.aborted ? "interrupted" : "failed", text: "", error: error instanceof Error ? error.message : String(error) }; }
    const current = this.store.conversation(active.meta.conversationId);
    const input = this.store.input(active.inputId);
    if (!current || !input || current.epoch !== active.meta.epoch || input.status === "canceled") return;
    this.#change(() => this.store.putInput({ ...input, status: outcome.status === "completed" ? "completed" : outcome.status === "interrupted" ? "uncertain" : "failed", error: outcome.error }));
    if (outcome.status !== "completed") this.#error = outcome.error ?? "Vivi 会话执行未完成";
    // A normal SDK stop without a structured report is idle/uncertain, never an automatic failure result.
    if (outcome.status === "completed" && outcome.text.trim()) await this.report({ conversationId: active.meta.conversationId, requestId: active.inputId, summary: outcome.text, outcome: "idle" });
  }
}
