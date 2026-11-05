// SPDX-License-Identifier: MIT
// Composition and relay rules adapted from deepseek-ai/dsh-superagent-prototype
// at 8c32a9dc5d72c033816c6a8110b37f40cf94fba4; see ../core/NOTICE.md and LICENSE.
import { Engine, type EngineForMainSession, type EngineForPeople, type EngineForSources, type WorkerReport } from "../core/engine.ts";
import { key } from "../core/ids.ts";
import { followupOwners, liveTicket, runningAssignment, type PolicyEffect, type Ticket } from "../core/model.ts";
import type { DomainEvent, Policy, SourceScope } from "../core/ports.ts";
import type { ReplyRequest } from "../core/replies.ts";
import { ticketStage } from "../core/stage.ts";
import { createShadowPorts, type AssessmentPayload, type DeliveryPayload, type LaunchPayload } from "./ports.ts";
import type { EffectRecord, ShadowStore } from "./store.ts";

/** A captured fake executor binding, not a Pi Session receipt or a model authorization. */
export interface WorkerToken { ticketId: string; assignmentId: string; generation: number; claimToken: number }
export interface ShadowEngineOptions {
  policy: () => Policy;
  scope: SourceScope;
  now?: () => number;
  onEvent?: (event: DomainEvent) => void;
  wake?: () => void;
}
type MainCommands = Pick<EngineForMainSession, "candidate" | "decide" | "attach" | "reply" | "requestStatus" | "note">;
const bindingKey = (ticketId: string): string => `shadow:worker:${ticketId}`;
const sameToken = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId
  && a.generation === b.generation && a.claimToken === b.claimToken;
const brief = (ticket: Ticket) => ({ id: ticket.id, title: ticket.title, ...ticketStage(ticket), ...(ticket.ended ? { ended: ticket.ended } : {}) });

/**
 * M3 composition root: synchronous commands and durable intents only. The fake completion
 * methods are called explicitly by tests; there is no scheduler, SDK, filesystem prepare or network.
 * The raw Core remains private so worker callbacks cannot bypass their captured binding.
 */
export class ShadowEngine {
  private readonly core: Engine;
  private readonly store: ShadowStore;
  private readonly options: ShadowEngineOptions;
  private readonly clock: () => number;
  private quiet = 0;
  readonly sources: EngineForSources;
  readonly main: MainCommands;
  readonly people: EngineForPeople;

  constructor(store: ShadowStore, options: ShadowEngineOptions) {
    this.store = store;
    this.options = options;
    this.clock = options.now ?? Date.now;
    const ports = createShadowPorts(store, () => this.now(), options.wake);
    this.core = new Engine({ repo: store, policy: options.policy, scope: options.scope, ...ports,
      now: () => new Date(this.now()).toISOString(), emit: event => this.emit(event) });
    this.sources = {
      receive: trigger => this.core.receive(trigger),
      bindThread: (id, thread, own) => this.core.bindThread(id, thread, own),
      threadClosed: (thread, outcome, at) => this.core.threadClosed(thread, outcome, at),
    };
    this.main = {
      candidate: id => this.core.candidate(id),
      decide: (id, outcome) => this.quietly(() => this.core.decide(id, outcome)),
      attach: (id, trigger, note) => this.quietly(() => this.core.attach(id, trigger, note)),
      reply: request => this.quietly(() => this.core.reply(request)),
      requestStatus: id => this.quietly(() => this.core.requestStatus(id)),
      note: (id, text) => this.quietly(() => this.core.note(id, text)),
    };
    this.people = {
      stopTicket: (id, reason) => this.core.stopTicket(id, reason),
      retryTicket: id => this.core.retryTicket(id),
      reevaluate: id => this.core.reevaluate(id),
      unsubscribe: thread => this.core.unsubscribe(thread),
      dismiss: id => this.core.dismiss(id),
    };
  }
  private now(): number {
    const at = this.clock();
    if (!Number.isSafeInteger(at) || !Number.isFinite(new Date(at).getTime())) throw new Error("Shadow 时钟必须返回有效的整数毫秒");
    return at;
  }
  private quietly<T>(work: () => T): T { this.quiet++; try { return work(); } finally { this.quiet--; } }
  evaluateDue(): void { this.core.evaluateDue(); }
  policyChanged(from: string, to: string, effects: ReadonlyMap<string, PolicyEffect> = new Map()): void { this.core.policyChanged(from, to, effects); }

  /** A fake assessor received this exact candidate; this is not a model decision. */
  completeAssessment(claim: EffectRecord): boolean {
    return this.finish(claim, "assessment", current => {
      const payload = current.payload as AssessmentPayload;
      const candidate = this.core.candidate(payload.triggerId);
      if (!candidate || candidate.evalId !== payload.evalId || current.key !== candidate.evalId) return undefined;
      this.core.candidateDelivered(candidate.evalId);
      return true;
    }) ?? false;
  }
  /** Bind a fake worker only after the exact launch attempt and pending Assignment are rechecked. */
  completeLaunch(claim: EffectRecord): WorkerToken | undefined {
    return this.finish(claim, "launch", current => {
      const payload = current.payload as LaunchPayload;
      const ticket = this.store.tickets.get(payload.ticketId);
      const assignment = ticket?.assignments.at(-1);
      if (!ticket || !liveTicket(ticket) || !assignment || assignment.id !== payload.assignmentId || assignment.state !== "pending" || current.key !== assignment.id) return undefined;
      const token: WorkerToken = { ticketId: ticket.id, assignmentId: assignment.id, generation: current.generation, claimToken: current.claimToken };
      this.store.set(bindingKey(ticket.id), token);
      this.core.assignmentStarted(ticket.id, assignment.id);
      return token;
    });
  }
  /** Fake delivery and reading remain distinct; completion writes deliveredTo/readAt:null only. */
  completeDelivery(claim: EffectRecord, token: WorkerToken): boolean {
    return this.finish(claim, "delivery", current => {
      const payload = current.payload as DeliveryPayload;
      if (current.key !== token.ticketId || payload.ticketId !== token.ticketId || payload.assignmentId !== token.assignmentId || !this.currentWorker(token)) return undefined;
      const ticket = this.store.tickets.get(token.ticketId)!;
      if (!Array.isArray(payload.inputIds) || payload.inputIds.some(id => !ticket.undelivered.includes(id))) return undefined;
      this.core.inputsDelivered(token.ticketId, token.assignmentId, payload.inputIds);
      return true;
    }) ?? false;
  }
  /** A pre-launch error is a report on its pending Assignment, not an inferred completed launch. */
  failLaunch(claim: EffectRecord, error: string): boolean {
    return this.finish(claim, "launch", current => {
      const payload = current.payload as LaunchPayload;
      const ticket = this.store.tickets.get(payload.ticketId);
      const assignment = ticket?.assignments.at(-1);
      if (!ticket || !liveTicket(ticket) || assignment?.id !== payload.assignmentId || assignment.state !== "pending" || current.key !== assignment.id) return undefined;
      const report: WorkerReport = { state: "failed", summary: error };
      const updated = this.core.report(ticket.id, report);
      this.reportRelay(updated, report);
      return true;
    }) ?? false;
  }
  /** Only a fake message receipt: no Source send or main-Session prompt is executed. */
  completeMessage(claim: EffectRecord): boolean {
    if (!["reply", "notice", "relay"].includes(claim.kind)) return false;
    return this.finish(claim, claim.kind, current => {
      if (current.kind === "reply" && !this.store.receipts.settle(current.key, "sent")) return undefined;
      return true;
    }) ?? false;
  }

  readonly worker = {
    report: (token: WorkerToken, report: WorkerReport): Ticket | undefined => this.withWorker(token, () => {
      const ticket = this.core.report(token.ticketId, report);
      this.reportRelay(ticket, report);
      return ticket;
    }),
    read: (token: WorkerToken, inputIds: string[]): boolean => this.withWorker(token, ticket => {
      const inputs = inputIds.map(id => ticket.inputs.find(input => input.id === id));
      if (inputs.some(input => !input || (input.kind === "trigger" && input.deliveredTo !== token.assignmentId)
        || ticket.undelivered.includes(input.id))) return false;
      this.core.inputsRead(token.ticketId, inputIds);
      return true;
    }) ?? false,
    turnEnded: (token: WorkerToken): boolean => this.withWorker(token, () => { this.core.turnEnded(token.ticketId, token.assignmentId); return true; }) ?? false,
    deliveryFailed: (token: WorkerToken, error: string, claim: EffectRecord): boolean => this.finish(claim, "delivery", current => {
      const payload = current.payload as DeliveryPayload;
      if (current.key !== token.ticketId || payload.ticketId !== token.ticketId || payload.assignmentId !== token.assignmentId || !this.currentWorker(token)) return undefined;
      this.core.deliveryFailed(token.ticketId, token.assignmentId, error);
      return true;
    }) ?? false,
    interrupted: (token: WorkerToken): boolean => this.withWorker(token, () => { this.core.assignmentInterrupted(token.ticketId, token.assignmentId); return true; }) ?? false,
    reply: (token: WorkerToken, request: ReplyRequest) => this.withWorker(token, () => {
      if (request.ticketId && request.ticketId !== token.ticketId) throw new Error("Worker 不能代替另一个 Ticket 回复");
      return this.core.reply({ ...request, ticketId: token.ticketId });
    }),
    handback: (token: WorkerToken, triggerId: string, reason: string): boolean => this.withWorker(token, () => this.core.handback(token.ticketId, triggerId, reason)) ?? false,
    followForContext: (token: WorkerToken, thread: Parameters<Engine["followForContext"]>[1]): boolean => this.withWorker(token, () => this.core.followForContext(token.ticketId, thread)) ?? false,
    markUnrelated: (token: WorkerToken, thread: string, reason: string): boolean => this.withWorker(token, () => { this.core.markUnrelated(token.ticketId, thread, reason); return true; }) ?? false,
  };
  private currentWorker(token: WorkerToken): Ticket | undefined {
    const binding = this.store.get<WorkerToken>(bindingKey(token.ticketId));
    if (!binding || !sameToken(binding, token)) return undefined;
    const ticket = this.store.tickets.get(token.ticketId);
    return ticket && liveTicket(ticket) && runningAssignment(ticket)?.id === token.assignmentId ? ticket : undefined;
  }
  private withWorker<T>(token: WorkerToken, work: (ticket: Ticket) => T): T | undefined {
    return this.store.atomic(() => {
      const ticket = this.currentWorker(token);
      return ticket ? work(ticket) : undefined;
    });
  }

  /** Check the DB claim, never caller-supplied payload; fact mutation and settlement share its transaction. */
  private finish<T>(claim: EffectRecord, kind: EffectRecord["kind"], work: (current: EffectRecord) => T | undefined): T | undefined {
    return this.store.atomic(() => {
      if (claim.kind !== kind) return undefined;
      const current = this.store.effects.get(kind, claim.key);
      const now = this.now();
      if (!current || current.status !== "running" || current.claimToken !== claim.claimToken || current.leaseOwner !== claim.leaseOwner
        || current.claimedGeneration !== claim.generation || current.leaseUntil! <= now) return undefined;
      if (current.generation !== claim.generation) {
        this.store.effects.settle(claim, "done", this.now());
        return undefined;
      }
      const result = work(current);
      if (result === undefined) return undefined;
      if (!this.store.effects.settle(claim, "done", this.now())) throw new Error("Effect 完成时所有权已变化");
      return result;
    });
  }
  private enqueue(kind: "notice" | "relay", id: string, payload: unknown): void {
    const previous = this.store.effects.get(kind, id);
    if (previous && JSON.stringify(previous.payload) === JSON.stringify(payload)) return;
    this.store.effects.enqueue(kind, id, payload, this.now());
    if (this.options.wake) this.store.afterCommit(this.options.wake);
  }
  private emit(event: DomainEvent): void {
    if (!this.quiet) {
      if (event.type === "ticket.ended" || event.type === "trigger.requeued" || event.type === "thread.unsubscribed") {
        const id = event.type === "thread.unsubscribed" && event.data.by === "person" ? `subscription:${event.data.threadKey}`
          : key("domain-notice", event.type, event.at, JSON.stringify(event.data));
        this.enqueue("notice", id, { value: event, summary: event.type });
      }
      if (event.type === "trigger.received" || event.type === "ticket.resumed" || event.type === "trigger.followup") {
        const triggerId = event.data.triggerId;
        const trigger = this.store.triggers.get(triggerId);
        const owners = trigger && followupOwners(trigger, this.store);
        const tickets = owners?.flatMap(id => { const ticket = this.store.tickets.get(id); return ticket && liveTicket(ticket) ? [brief(ticket)] : []; }) ?? [];
        if (trigger?.human && tickets.length) this.enqueue("relay", `followup:${triggerId}`, { text: JSON.stringify({ kind: "follow_up", trigger_id: triggerId, text: trigger.text,
          delivered_to: tickets, note: "Its worker decides; the main Session may only stop the work the person asks to stop." }) });
      }
    }
    if (this.options.onEvent) {
      const committed = structuredClone(event);
      this.store.afterCommit(() => this.options.onEvent!(committed));
    }
  }
  private reportRelay(ticket: Ticket, report: WorkerReport): void {
    const question = report.question ? ticket.attention : undefined;
    if (!question && report.state === "progress" && !report.answers) return;
    const summary = report.summary.length > 600 ? { summary: report.summary.slice(0, 600), chars: report.summary.length } : { summary: report.summary };
    const id = question ? `attention:${ticket.id}:${question.id}` : `report:${key("worker-result", ticket.id, ticket.updatedAt, report.summary)}`;
    this.enqueue("relay", id, { text: JSON.stringify({ kind: question ? "worker_attention" : "worker_report", ticket: brief(ticket),
      trigger_id: ticket.origin.triggerId, state: report.state, ...(report.answers ? { answer_to: report.answers } : {}), ...summary, read: `ticket/${ticket.id}/result` }) });
  }
}
