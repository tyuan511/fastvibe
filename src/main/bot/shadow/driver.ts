// SPDX-License-Identifier: MIT
// Isolated composition adapted from deepseek-ai/dsh-superagent-prototype; see ../core/NOTICE.md.
import { liveTicket, type Assignment, type Ticket } from "../core/model.ts";
import type { Candidate } from "../core/ports.ts";
import { ownedEffect } from "./claims.ts";
import { ShadowEffects, Later, type EffectContext } from "./effects.ts";
import { ShadowEngine, type ShadowEngineOptions, type WorkerToken } from "./engine.ts";
import { ShadowOperations, type OperationAdapter } from "./operations.ts";
import { ShadowOutbox, type ShadowMessageSource } from "./outbox.ts";
import { ShadowPasses } from "./passes.ts";
import { type AssessmentPayload, type ControlPayload, type DeliveryPayload, type LaunchPayload, type ReleaseControl, type StopControl } from "./ports.ts";
import type { EffectRecord, ShadowStore } from "./store.ts";

/** A positive pre-execution rejection, not an unknown remote outcome. */
export class LaunchRejected extends Error {}
export class DeliveryRejected extends Error {}
export interface ShadowAdapters {
  assessment?(candidate: Candidate, context: EffectContext): Promise<void>;
  launch?(ticket: Ticket, assignment: Assignment, token: WorkerToken, context: EffectContext): Promise<void>;
  delivery?(ticket: Ticket, assignment: Assignment, inputIds: string[], token: WorkerToken, context: EffectContext): Promise<void>;
  relay?(payload: { text: string }, context: EffectContext): Promise<void>;
  notice?(payload: { value: unknown; summary: string }, context: EffectContext): Promise<void>;
  stop?(control: StopControl, context: EffectContext): Promise<void>;
  release?(control: ReleaseControl, context: EffectContext): Promise<void>;
  source?: ShadowMessageSource;
  operations?: OperationAdapter;
}
export interface ShadowDriverOptions extends Omit<ShadowEngineOptions, "wake"> {
  configured?: () => boolean;
  intervalMs?: number | false;
  leaseMs?: number;
  owner?: string;
  limits?: Partial<Record<"assessment" | "launch" | "delivery", number | (() => number)>>;
  beforePass?: () => void | Promise<void>;
}
const pausedKey = "shadow:driver:paused";
const unavailable = async (): Promise<never> => { throw new Later("No explicit shadow adapter is configured"); };

/** M5 laboratory: no production registration, SDK host, Source registry or implicit transport. */
export class ShadowDriver {
  readonly engine: ShadowEngine;
  readonly effects: ShadowEffects;
  readonly outbox: ShadowOutbox;
  readonly operations?: ShadowOperations;
  readonly passes: ShadowPasses;
  private readonly store: ShadowStore;
  private readonly options: ShadowDriverOptions;
  private readonly adapters: ShadowAdapters;
  private readonly clock: () => number;
  private started = false;
  private closing = false;
  private stopped = false;
  private stopping?: Promise<void>;

  constructor(store: ShadowStore, options: ShadowDriverOptions, adapters: ShadowAdapters) {
    this.store = store; this.options = options; this.adapters = adapters; this.clock = options.now ?? Date.now;
    this.effects = new ShadowEffects(store, { now: this.clock, owner: options.owner, leaseMs: options.leaseMs });
    this.engine = new ShadowEngine(store, { ...options,
      policy: () => ({ ...options.policy(), paused: this.paused() }),
      wake: () => { this.effects.kick(); this.passes?.request(); },
    });
    this.outbox = new ShadowOutbox(store, this.effects, adapters.source ?? { enabled: () => false, allowed: () => false, send: unavailable },
      { now: this.clock, paused: () => !this.canProcess() });
    if (adapters.operations) {
      const operationAdapter = adapters.operations;
      this.operations = new ShadowOperations(store, this.effects, {
        execute: (operation, context) => operationAdapter.execute(operation, context),
        inspect: (operation, context) => {
          if (!this.started || this.closing || !this.configured()) throw new Later("Shadow setup is incomplete or closing");
          return operationAdapter.inspect(operation, context);
        },
      }, { now: this.clock, paused: () => !this.canProcess() });
    }
    this.register();
    this.passes = new ShadowPasses({
      engine: { receive: trigger => this.engine.sources.receive(trigger), evaluateDue: () => this.engine.evaluateDue() },
      effects: this.effects, configured: () => this.started && this.configured(), closing: () => this.closing,
      recover: () => this.recover(), beforePass: options.beforePass,
    }, { now: this.clock, intervalMs: options.intervalMs });
  }
  private configured(): boolean { return this.options.configured?.() ?? true; }
  paused(): boolean { return this.store.get<boolean>(pausedKey) === true || this.options.policy().paused; }
  private canProcess(): boolean { return this.started && !this.closing && this.configured() && !this.paused(); }
  setPaused(value: boolean): void {
    if (this.closing || this.stopped) throw new Error("Shadow driver is stopping");
    this.store.atomic(() => { this.store.set(pausedKey, value); this.store.afterCommit(() => this.passes.request()); });
  }
  start(): void {
    if (this.stopped) throw new Error("Stopped shadow driver cannot restart; create a new owner");
    if (this.started) return;
    this.started = true;
    this.recover();
    this.effects.start();
    this.passes.start();
  }
  receive(trigger: Parameters<ShadowPasses["receive"]>[0]) { return this.passes.receive(trigger); }
  async idle(): Promise<void> { await this.passes.pump(); await this.passes.idle(); }
  stop(options: { abort?: boolean } = {}): Promise<void> {
    if (this.stopping) return this.stopping;
    this.closing = true; this.stopped = true;
    const pass = this.passes.stop();
    const effects = this.effects.drain(options);
    return this.stopping = Promise.all([pass, effects]).then(() => {});
  }
  /** Recovery only expires claims and queues missing control/read reconciliation work. */
  recover(): void {
    this.effects.pulse();
    this.store.atomic(() => {
      const controls = this.store.db.all<{ key: string; data: string }>("SELECT key,data FROM dsh_kv WHERE key LIKE 'shadow:stop:%' OR key LIKE 'shadow:release:%'");
      for (const row of controls) {
        const control = JSON.parse(row.data) as StopControl | ReleaseControl;
        if (control.status !== "pending" || this.store.effects.get("control", row.key)) continue;
        const payload: ControlPayload = "evalId" in control ? { type: "release", controlKey: row.key, control }
          : { type: "stop", controlKey: row.key, control };
        this.store.effects.enqueue("control", row.key, payload, this.clock());
      }
      this.operations?.recover();
    });
  }
  private active(context: EffectContext): EffectRecord | undefined {
    if (context.claim.kind === "control" ? !this.started || this.closing : !this.canProcess()) throw new Later("Shadow processing is paused or not configured");
    return ownedEffect(this.store, context.claim, this.clock());
  }
  private limit(kind: "assessment" | "launch" | "delivery", fallback: number): () => number {
    return () => {
      if (!this.canProcess()) return 0;
      const value = this.options.limits?.[kind] ?? fallback;
      return typeof value === "function" ? value() : value;
    };
  }
  private register(): void {
    this.effects.handle("assessment", async context => {
      const current = this.active(context); if (!current) return () => false;
      const payload = current.payload as AssessmentPayload;
      const candidate = this.engine.main.candidate(payload.triggerId);
      if (!candidate || candidate.evalId !== payload.evalId || current.key !== payload.evalId) return () => false;
      await (this.adapters.assessment ?? unavailable)(structuredClone(candidate), context);
      return claim => this.engine.completeAssessment(claim);
    }, { limit: this.limit("assessment", 4) });
    this.effects.handle("launch", async context => {
      const current = this.active(context); if (!current) return () => false;
      const payload = current.payload as LaunchPayload;
      const ticket = this.store.tickets.get(payload.ticketId), assignment = ticket?.assignments.at(-1);
      if (!ticket || !liveTicket(ticket) || assignment?.id !== payload.assignmentId || assignment.state !== "pending" || current.key !== assignment.id) return () => false;
      const token: WorkerToken = { ticketId: ticket.id, assignmentId: assignment.id, generation: current.generation, claimToken: current.claimToken };
      try { await (this.adapters.launch ?? unavailable)(structuredClone(ticket), structuredClone(assignment), token, context); }
      catch (error) { if (error instanceof LaunchRejected) return claim => this.engine.failLaunch(claim, String(error)); throw error; }
      return claim => !!this.engine.completeLaunch(claim);
    }, { limit: this.limit("launch", 1), retry: [5000, 300_000] });
    this.effects.handle("delivery", async context => {
      const current = this.active(context); if (!current) return () => false;
      const payload = current.payload as DeliveryPayload;
      const ticket = this.store.tickets.get(payload.ticketId), assignment = ticket?.assignments.at(-1);
      const token = this.engine.currentBinding(payload.ticketId);
      if (!ticket || !liveTicket(ticket) || !token || token.assignmentId !== payload.assignmentId || assignment?.id !== token.assignmentId
        || current.key !== ticket.id || !payload.inputIds.length || payload.inputIds.some(id => !ticket.undelivered.includes(id))) return () => false;
      try { await (this.adapters.delivery ?? unavailable)(structuredClone(ticket), structuredClone(assignment), [...payload.inputIds], token, context); }
      catch (error) { if (error instanceof DeliveryRejected) return claim => this.engine.worker.deliveryFailed(token, String(error), claim); throw error; }
      return claim => this.engine.completeDelivery(claim, token);
    }, { limit: this.limit("delivery", 4), quiet: true });
    for (const kind of ["relay", "notice"] as const) {
      this.effects.handle(kind, async context => {
        const current = this.active(context); if (!current) return () => false;
        if (kind === "relay") await (this.adapters.relay ?? unavailable)(current.payload as { text: string }, context);
        else await (this.adapters.notice ?? unavailable)(current.payload as { value: unknown; summary: string }, context);
        return claim => this.engine.completeMessage(claim);
      }, { ordered: true, limit: () => this.canProcess() ? 1 : 0 });
    }
    this.effects.handle("control", async context => {
      const current = this.active(context); if (!current) return () => false;
      const payload = current.payload as ControlPayload;
      const control = this.store.get<StopControl | ReleaseControl>(payload.controlKey);
      if (!control || control.status !== "pending") return () => false;
      if (payload.type === "release") await (this.adapters.release ?? unavailable)(structuredClone(payload.control), context);
      else await (this.adapters.stop ?? unavailable)(structuredClone(payload.control), context);
      return () => { this.store.set(payload.controlKey, { ...control, status: "done" }); return true; };
    }, { limit: () => this.started && !this.closing ? 4 : 0 });
  }
}
