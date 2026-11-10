// SPDX-License-Identifier: MIT
/** Compatibility surface for an explicitly assembled DSH host. */
import { createHash } from "node:crypto";
import type {
  BotActivity, BotApi, BotAttention, BotChanged, BotContext, BotCreateWorkRequest,
  BotProgressRequest, BotProgress, BotReportRequest, BotResult, BotSubmitRequest,
  BotChatMessage, BotConversationMeta, BotDelivery, WorkSnapshot,
} from "../../../shared/bot.ts";
import { key as domainKey } from "../core/ids.ts";
import { latestAssignment, type Ticket } from "../core/model.ts";
import type { DomainEvent } from "../core/ports.ts";
import type { ViviDshRuntime, ViviDshSubmit } from "./vivi-dsh-runtime.ts";
import { effectRequestId, type EffectContext } from "./effects.ts";
import type { Receipt, ShadowStore } from "./store.ts";

const ROUTER = "dsh-router";
const STATE_KEY = "dsh:bot:projection:v1";
type Projection = {
  revision: number; chatGeneration: number; messages: BotChatMessage[];
  domain?: string;
};
type Accepted = { payload: ViviDshSubmit; ticketId: string };
export type DshRelayPayload = { text: string };
const clone = <T>(value: T): T => structuredClone(value);
const at = (value?: string): number => {
  const parsed = value ? Date.parse(value) : Number.NaN;
  return Number.isFinite(parsed) ? parsed : 0;
};
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");

export type DshBotRuntimeEvents = (listener: (event: DomainEvent) => void) => () => void;
/** Events forwarded from the composed driver into the facade's own projection. */
export type DshBotRuntime = (listener: (event: DomainEvent) => void) => () => void;

/**
 * What the facade needs from a composition root.
 *
 * Deliberately a port, not `ViviDshRuntime`: a production deployment may compose one driver and
 * one executor with several Sources (local chat plus GitHub), reaching them through
 * `GithubPiDeployment`, and that composition is not a `ViviDshRuntime`. The facade only needs
 * these seven operations, so it should not dictate which root supplies them.
 */
export interface DshBotHost {
  start(): void;
  stop(): Promise<void>;
  submit(input: ViviDshSubmit): string;
  ticket(ticketId: string): Ticket | undefined;
  tickets(): Ticket[];
  stopTicket(ticketId: string, reason?: string): Ticket;
  retryTicket(ticketId: string): Ticket;
  answerAttention(attentionId: string, text: string): Ticket;
}
export type DshBotFacadeOptions = { now?: () => number; subscribe?: DshBotRuntimeEvents };

export class DshBotFacade implements BotApi {
  private runtime?: DshBotHost;
  private readonly now: () => number;
  private readonly listeners = new Set<(event: BotChanged) => void>();
  private detachEvents?: () => void;

  private readonly store: ShadowStore;
  constructor(store: ShadowStore, runtime?: DshBotHost, options: DshBotFacadeOptions = {}) {
    this.store = store;
    this.runtime = runtime;
    this.now = options.now ?? Date.now;
    if (options.subscribe) this.detachEvents = options.subscribe(() => this.notifyDomainEvent());
  }
  attachRuntime(runtime: DshBotHost, subscribe?: DshBotRuntimeEvents): void {
    this.detachEvents?.();
    this.runtime = runtime;
    this.detachEvents = subscribe?.(() => this.notifyDomainEvent());
    this.notifyDomainEvent();
  }
  start(): void { this.requireRuntime().start(); }
  async stop(): Promise<void> { await this.runtime?.stop(); }
  private requireRuntime(): DshBotHost {
    if (!this.runtime) throw new Error("DSH Bot facade 尚未 attach 组合根");
    return this.runtime;
  }
  private state(): Projection {
    return this.store.get<Projection>(STATE_KEY) ?? { revision: 0, chatGeneration: 0, messages: [] };
  }
  private tickets(): Ticket[] { return this.runtime?.tickets() ?? this.store.tickets.list(); }
  private ticket(id: string): Ticket | undefined { return this.runtime?.ticket(id) ?? this.store.tickets.get(id); }
  private receipts(): Receipt[] {
    return this.store.db.all<{ data: string }>("SELECT data FROM dsh_outbox ORDER BY rowid").map(row => JSON.parse(row.data) as Receipt);
  }
  private domain(): string { return hash([this.tickets(), this.receipts()]); }
  private emit(extra: Partial<BotChanged> = {}): void {
    const event: BotChanged = { revision: this.state().revision, activity: this.activity(), ...extra };
    for (const listener of this.listeners) listener(event);
  }
  /** Must run inside store.atomic; callbacks publish only after the outer commit. */
  private save(state: Projection, extra?: Partial<BotChanged>): void {
    state.domain = this.domain();
    for (const ticket of this.tickets()) {
      if (ticket.attention) {
        const key = `dsh:bot:attention:${ticket.attention.id}`;
        if (this.store.get<number>(key) === undefined) this.store.set(key, at(latestAssignment(ticket)?.report?.at ?? ticket.updatedAt));
      }
    }
    state.revision += 1;
    this.store.set(STATE_KEY, state);
    this.store.afterCommit(() => this.emit(extra));
  }
  /** Hosts call this after committed domain events; it never publishes completion notifications. */
  notifyDomainEvent(): void {
    this.store.atomic(() => {
      const state = this.state();
      const domain = this.domain();
      if (state.domain === domain || (!state.domain && !this.tickets().length && !this.receipts().length)) return;
      this.save(state);
    });
  }
  private meta(ticket: Ticket): BotConversationMeta {
    return { conversationId: ticket.id, role: "worker", owner: "vivi", creationKey: `dsh-ticket:${ticket.id}`, epoch: 0,
      paused: ticket.ended?.outcome === "stopped", createdAt: at(ticket.createdAt), updatedAt: at(ticket.updatedAt), title: ticket.title };
  }
  private result(ticket: Ticket): BotResult | undefined {
    // A retry's new Assignment supersedes all historical reports.
    const assignment = latestAssignment(ticket);
    const report = assignment?.report;
    if (!report) return undefined;
    return { id: `dsh-result-${hash([ticket.id, assignment.id, report])}`, conversationId: ticket.id, epoch: 0,
      status: ticket.ended?.outcome === "stopped" ? "uncertain" : report.state === "ready" ? "ready" : report.state === "blocked" ? "blocked" : report.state === "failed" ? "failed" : report.state === "dropped" ? "idle" : "uncertain",
      summary: report.summary, createdAt: at(report.at) };
  }
  private progressFor(ticket: Ticket): BotProgress {
    const assignment = latestAssignment(ticket);
    const report = assignment?.report;
    const busySinceReport = !!assignment?.deliveredAt && (!report || assignment.deliveredAt >= report.at)
      && (!assignment.idleAt || assignment.deliveredAt > assignment.idleAt);
    let phase: BotProgress["phase"];
    if (ticket.ended?.outcome === "stopped") phase = "paused";
    else if (ticket.ended) phase = ticket.ended.outcome === "completed" ? "completed" : "interrupted";
    else if (ticket.attention) phase = "waiting";
    else if (assignment?.state === "pending") phase = "accepted";
    else if (busySinceReport) phase = "working";
    else if (report) phase = report.state === "ready" ? "completed" : report.state === "failed" ? "failed" : report.state === "waiting" || report.state === "blocked" ? "waiting" : report.state === "dropped" ? "idle" : assignment?.state === "running" && !assignment.idleAt ? "working" : "idle";
    else phase = assignment?.state === "running" ? assignment.idleAt ? "idle" : "working" : "idle";
    return { conversationId: ticket.id, role: "worker", title: ticket.title, phase, detail: report?.summary,
      startedAt: at(assignment?.startedAt ?? assignment?.createdAt ?? ticket.createdAt), updatedAt: at(ticket.updatedAt),
      queuedCount: ticket.undelivered.length, result: this.result(ticket) };
  }
  private attentionFor(ticket: Ticket): BotAttention[] {
    if (!ticket.attention) return [];
    // Attention has no timestamp field. Preserve its first observed report time across later reports/reopens.
    const key = `dsh:bot:attention:${ticket.attention.id}`;
    const createdAt = this.store.get<number>(key) ?? at(latestAssignment(ticket)?.report?.at ?? ticket.updatedAt);
    return [{ id: ticket.attention.id, conversationId: ticket.id, epoch: 0, question: ticket.attention.question, status: "pending", createdAt }];
  }
  async getWorkSnapshot(): Promise<WorkSnapshot> {
    return this.store.atomic(() => {
      const tickets = this.tickets();
      const state = this.state();
      const deliveries: BotDelivery[] = this.receipts().map(receipt => {
        const ticket = receipt.ticketId ? this.ticket(receipt.ticketId) : undefined;
        const effect = this.store.effects.get("reply", receipt.id);
        return { id: receipt.id, conversationId: receipt.ticketId ?? ROUTER, targetConversationId: receipt.ticketId ?? ROUTER,
          text: receipt.text, status: receipt.status === "sent" ? "delivered" : receipt.status === "dropped" ? "failed" : "pending",
          createdAt: effect?.since ?? at(ticket?.createdAt) };
      });
      return clone({ revision: state.revision, routerConversationId: ROUTER, conversations: tickets.map(ticket => this.meta(ticket)),
        attention: tickets.flatMap(ticket => this.attentionFor(ticket)), results: tickets.flatMap(ticket => { const result = this.result(ticket); return result ? [result] : []; }),
        deliveries, messages: state.messages, chatGeneration: state.chatGeneration, progress: tickets.map(ticket => this.progressFor(ticket)) });
    });
  }
  async clearChat(): Promise<WorkSnapshot> {
    this.store.atomic(() => { const state = this.state(); state.chatGeneration += 1; state.messages = []; this.save(state); });
    return this.getWorkSnapshot();
  }
  private accept(input: ViviDshSubmit): string {
    return this.store.atomic(() => {
      const key = `dsh:bot:accepted:${input.requestId}`;
      const prior = this.store.get<Accepted>(key);
      if (prior) {
        if (hash(prior.payload) !== hash(input)) throw new Error("同一 requestId 的 payload 不可改变");
        return prior.ticketId;
      }
      const ticketId = this.requireRuntime().submit(input);
      const state = this.state();
      const ticket = this.ticket(ticketId)!;
      this.store.set(key, { payload: input, ticketId } satisfies Accepted);
      state.messages.push({ id: `dsh-chat-${hash(input.requestId)}`, conversationId: ROUTER, inputId: input.requestId, role: "user", text: input.text,
        createdAt: at(ticket.createdAt), historyGeneration: state.chatGeneration, kind: "message", title: input.title });
      this.save(state);
      return ticketId;
    });
  }
  async submit(input: BotSubmitRequest): Promise<WorkSnapshot> {
    if (input.images?.length || input.conversationId !== undefined || input.memoryRefs?.length || "project" in input || "workspace" in input || (input.behavior !== undefined && input.behavior !== "followUp")) {
      throw new Error("DSH submit 尚不支持 images/conversationId/memoryRefs/behavior 的请求语义");
    }
    // No literal scope here: the runtime owns the deployment's intake scope, and a facade that
    // hardcoded "local" would silently override it and put work in the wrong repository.
    this.accept({ requestId: input.requestId, text: input.text });
    return this.getWorkSnapshot();
  }
  async createWork(input: BotCreateWorkRequest): Promise<BotConversationMeta> {
    if (input.project !== undefined || input.workspace !== undefined || input.memoryRefs?.length) throw new Error("DSH createWork 尚不支持 project/workspace/memoryRefs");
    const id = this.accept({ requestId: input.requestId, text: input.text, title: input.title });
    return this.meta(this.ticket(id)!);
  }
  async report(_input: BotReportRequest): Promise<BotResult> { throw new Error("DSH report 仅允许绑定当前 Assignment 的 SDK 报告入口；请通过 snapshot 读取报告"); }
  async ask(_input: Parameters<BotApi["ask"]>[0]): Promise<BotAttention> { throw new Error("DSH Bot facade 没有主 Session port，不能伪造 attention"); }
  async answer(input: Parameters<BotApi["answer"]>[0]): Promise<WorkSnapshot> {
    // The renderer's question card only knows the attention id; the question text and the asking
    // trigger come from the durable Ticket, so a stale card cannot answer a replaced question.
    this.requireRuntime().answerAttention(input.attentionId, input.answer);
    this.notifyDomainEvent();
    return this.getWorkSnapshot();
  }
  async stopConversation(input: Parameters<BotApi["stopConversation"]>[0]): Promise<WorkSnapshot> {
    if (input.callerConversationId !== undefined) throw new Error("DSH stop 不支持未经 binding 校验的扩展调用");
    this.requireRuntime().stopTicket(input.conversationId, "stopped by user"); this.notifyDomainEvent(); return this.getWorkSnapshot();
  }
  async continueConversation(input: Parameters<BotApi["continueConversation"]>[0]): Promise<WorkSnapshot> {
    if (input.inputId !== undefined) throw new Error("DSH retry 不支持指定旧 inputId");
    this.requireRuntime().retryTicket(input.conversationId); this.notifyDomainEvent(); return this.getWorkSnapshot();
  }
  async stopAll(): Promise<WorkSnapshot> {
    for (const ticket of this.tickets().filter(item => !item.ended)) this.requireRuntime().stopTicket(ticket.id, "stopped by user");
    this.notifyDomainEvent();
    return this.getWorkSnapshot();
  }
  activity(): BotActivity {
    const progress = this.tickets().map(ticket => this.progressFor(ticket));
    const running = progress.find(item => item.phase === "working" || item.phase === "accepted");
    return { running: !!running, waiting: progress.some(item => item.phase === "waiting"), ...(running ? { conversationId: running.conversationId } : {}) };
  }
  async getActivity(): Promise<BotActivity> { return this.activity(); }
  onChanged(listener: (event: BotChanged) => void): () => void { this.listeners.add(listener); return () => this.listeners.delete(listener); }
  onNavigate(_listener: Parameters<BotApi["onNavigate"]>[0]): () => void { return () => {}; }
  contextFor(conversationId: string): BotContext {
    const ticket = this.ticket(conversationId);
    const progress = ticket && this.progressFor(ticket);
    const result = ticket && this.result(ticket);
    return { role: conversationId === ROUTER ? "router" : "worker", conversationId, active: !!ticket && !ticket.ended,
      phase: progress?.phase === "waiting" ? "waiting" : result?.status === "ready" ? "reported" : ticket && !ticket.ended ? "running" : "inactive",
      conversations: this.tickets().map(item => this.meta(item)), progress: this.tickets().map(item => this.progressFor(item)),
      results: result ? [result] : [], attention: ticket ? this.store.atomic(() => this.attentionFor(ticket)) : [] };
  }
  async progress(_input: BotProgressRequest): Promise<WorkSnapshot> { throw new Error("DSH progress 需要 SDK binding/epoch 校验，旧扩展入口不可用"); }
  async reply(_input: { conversationId: string; text: string; requestId?: string; epoch?: number }): Promise<BotChatMessage> { throw new Error("DSH reply 需要主 Session binding/epoch 校验，旧扩展入口不可用"); }

  /** Explicit host relay adapter only. The durable claim, payload and request identity must all match. */
  async receiveRelay(payload: DshRelayPayload, context: EffectContext): Promise<void> {
    return this.store.atomic(() => {
      const { claim } = context;
      const current = this.store.effects.get("relay", claim.key);
      if (context.signal.aborted || claim.kind !== "relay" || !current || current.status !== "running" || current.seq !== claim.seq
        || current.generation !== claim.generation || current.claimedGeneration !== claim.generation || current.claimToken !== claim.claimToken
        || current.leaseOwner !== claim.leaseOwner || (current.leaseUntil ?? 0) <= this.now()
        || context.requestId !== effectRequestId(current) || hash(current.payload) !== hash(payload)) throw new Error("DSH relay effect 身份或 payload 无效");
      const key = `dsh:bot:relay:${context.requestId}`;
      if (this.store.get<boolean>(key)) return;
      const state = this.state();
      let text = payload.text;
      let completion: BotChanged["completion"];
      let envelope: { kind?: string; ticket?: { id?: string }; state?: string; summary?: string; trigger_id?: string } | undefined;
      try { envelope = JSON.parse(payload.text); } catch { /* Plain main-session relay text. */ }
      if (envelope?.kind === "worker_report" || envelope?.kind === "worker_attention") {
        const ticket = envelope.ticket?.id ? this.ticket(envelope.ticket.id) : undefined;
        const report = ticket && latestAssignment(ticket)?.report;
        if (!ticket || !report || envelope.state !== report.state || envelope.summary !== report.summary.slice(0, 600)
          || envelope.trigger_id !== ticket.origin.triggerId) throw new Error("DSH relay 不匹配当前真实 Worker report");
        const expectedKey = envelope.kind === "worker_attention" && ticket.attention
          ? `attention:${ticket.id}:${ticket.attention.id}`
          : `report:${domainKey("worker-result", ticket.id, report.at, report.summary)}`;
        if (claim.key !== expectedKey) throw new Error("DSH relay 不匹配当前 report effect binding");
        text = envelope.kind === "worker_attention" ? ticket.attention?.question ?? report.summary : report.summary;
        if (envelope.kind === "worker_report" && this.result(ticket)?.status === "ready") {
          completion = { id: context.requestId, conversationId: ticket.id, text };
        }
      }
      const message: BotChatMessage = { id: context.requestId, conversationId: ROUTER, role: "assistant", text,
        createdAt: current.since, historyGeneration: state.chatGeneration, kind: "message" };
      state.messages.push(message);
      this.store.set(key, true);
      // The committed chat row is this relay's actual local delivery. Notify only after commit.
      this.save(state, { message, ...(completion ? { completion } : {}) });
    });
  }
}

export const createDshBotFacade = (store: ShadowStore, runtime: ViviDshRuntime, options?: DshBotFacadeOptions): DshBotFacade => new DshBotFacade(store, runtime, options);
