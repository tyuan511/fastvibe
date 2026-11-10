// SPDX-License-Identifier: MIT
// Explicit M11 SDK executor. No production Runtime, settings or credential discovery.
import { createHash } from "node:crypto";
import { mkdirSync, realpathSync } from "node:fs";
import type { AgentSession, ModelRuntime, ExtensionFactory } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { liveTicket, type Assignment, type Ticket } from "../core/model.ts";
import { ownedEffect } from "./claims.ts";
import { DeliveryRejected, type ShadowAdapters } from "./driver.ts";
import { Later, type EffectContext } from "./effects.ts";
import type { ShadowEngine, WorkerToken } from "./engine.ts";
import { ExecutionDirectories, assertExecutionPath, type PrepareRecipe } from "./execution-directory.ts";
import { PiLedger } from "./pi-ledger.ts";
import { ManagedPiReviewer, type PiReviewInput, type PiReviewRecord } from "./pi-reviewer.ts";
import { ScratchPiSession } from "./pi-session.ts";
import { WorkspaceFiles } from "./pi-workspace.ts";
import type { StopControl } from "./ports.ts";
import { WorkerSlots, type SlotReservation } from "./worker-slots.ts";
import type { ShadowStore } from "./store.ts";

export interface PiExecutorRecord {
  binding: WorkerToken; sessionKey: string; state: "opened" | "uncertain" | "stopped";
  pid: number; revision: number; quiet?: boolean;
}
export interface PiExecutorOptions {
  store: ShadowStore; root: string; allowedRoot?: string; engine: () => ShadowEngine; enabled: () => boolean;
  modelRuntime: ModelRuntime; model: NonNullable<AgentSession["model"]>;
  maxWorkers: () => number; now?: () => number; recipe?: PrepareRecipe;
  /** Explicit full-assignment profile: activate the accepted origin after launch commits. */
  initialAssignment?: boolean;
  reviewer?: {
    modelRuntime: ModelRuntime; model: NonNullable<AgentSession["model"]>;
    /** Trusted host snapshot, including the complete diff and versioned files. */
    input: (binding: WorkerToken, artifactId: string) => PiReviewInput;
    current: (binding: WorkerToken) => { headSha: string; baseSha: string };
    /** Host-only Effect planner; never receives credentials from the model. */
    onCompleted?: (binding: WorkerToken, record: PiReviewRecord) => unknown;
  };
}
interface Handle { binding: WorkerToken; sdk: ScratchPiSession; files: WorkspaceFiles; slot?: SlotReservation; stopping: boolean; reviewers: Set<ManagedPiReviewer>; quiescing?: Promise<void> }
const same = (a: WorkerToken, b: WorkerToken): boolean => a.ticketId === b.ticketId && a.assignmentId === b.assignmentId && a.generation === b.generation && a.claimToken === b.claimToken;
const hash = (value: unknown): string => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const key = (id: string): string => `pi:executor:${id}`;
const dead = (pid: number): boolean => { try { process.kill(pid, 0); return false; } catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; } };

/** Durable inbox activation is deliberately separate from the delivery adapter's return. */
export class PiExecutor {
  readonly directories: ExecutionDirectories;
  readonly slots: WorkerSlots;
  private readonly options: PiExecutorOptions;
  private readonly handles = new Map<string, Handle>();
  private readonly opening = new Map<string, Promise<Handle>>();
  private readonly launches = new Map<string, { binding: WorkerToken; controller: AbortController; done: Promise<void> }>();
  private readonly turns = new Map<string, Promise<void>>();
  private readonly preparingSlots = new Map<string, SlotReservation>();
  private readonly clock: () => number;
  private readonly timer: ReturnType<typeof setInterval>;
  private closing = false;
  private scanning?: Promise<void>;
  constructor(options: PiExecutorOptions) {
    assertExecutionPath(options.root, options.allowedRoot, options.store);
    mkdirSync(options.root, { recursive: true, mode: 0o700 });
    this.options = { ...options, root: realpathSync(options.root) }; this.clock = options.now ?? Date.now;
    this.directories = new ExecutionDirectories(options.store, this.options.root, { now: this.clock, allowedRoot: options.allowedRoot });
    this.slots = new WorkerSlots(options.store, { max: options.maxWorkers, now: this.clock });
    this.timer = setInterval(() => {
      for (const [ticketId, slot] of this.preparingSlots) {
        try { this.preparingSlots.set(ticketId, this.slots.renew(slot)); } catch { this.markUncertain(slot.binding); }
      }
      for (const handle of this.handles.values()) if (handle.slot) {
        try { handle.slot = this.slots.renew(handle.slot); } catch { this.markUncertain(handle.binding); void this.quiesce(handle).catch(() => {}); }
      }
    }, 20_000); this.timer.unref();
  }
  record(ticketId: string): PiExecutorRecord | undefined { return this.options.store.get<PiExecutorRecord>(key(ticketId)); }
  private save(binding: WorkerToken, state: PiExecutorRecord["state"], quiet?: boolean): void {
    this.options.store.atomic(() => { const previous = this.record(binding.ticketId); this.options.store.set(key(binding.ticketId), { binding, sessionKey: `worker-${binding.ticketId}`, state, quiet: quiet ?? (state === "opened" ? false : previous?.quiet ?? false), pid: state === "opened" ? process.pid : previous?.pid ?? process.pid, revision: (previous?.revision ?? 0) + 1 } satisfies PiExecutorRecord); });
  }
  private markUncertain(binding: WorkerToken): void {
    const current = this.record(binding.ticketId); if (current && same(current.binding, binding) && current.state !== "stopped") this.save(binding, "uncertain");
  }
  private current(binding: WorkerToken): boolean {
    const current = this.options.engine().currentBinding(binding.ticketId);
    return !this.closing && this.options.enabled() && !!current && same(current, binding);
  }
  private check(binding: WorkerToken, resource = true): void {
    const handle = this.handles.get(binding.ticketId);
    if (!this.current(binding) || this.record(binding.ticketId)?.state !== "opened" || handle?.stopping || (resource && (!handle?.slot || !this.slots.valid(handle.slot)))) throw new Error("SDK Worker binding or resource is stopped, paused or stale");
  }
  private claim(context: EffectContext): void {
    const owned = ownedEffect(this.options.store, context.claim, this.clock());
    if (context.signal.aborted || this.closing || !this.options.enabled() || !owned) throw new Later("SDK executor claim is no longer active");
    if (owned.kind === "launch") {
      const payload = owned.payload as { ticketId: string; assignmentId: string };
      const ticket = this.options.store.tickets.get(payload.ticketId), assignment = ticket?.assignments.at(-1);
      if (!ticket || !liveTicket(ticket) || assignment?.id !== payload.assignmentId || assignment.state !== "pending") throw new Later("SDK launch Assignment is no longer pending and authorized");
    }
  }
  private async open(binding: WorkerToken): Promise<Handle> {
    const existing = this.handles.get(binding.ticketId);
    if (existing) { if (!same(existing.binding, binding)) throw new Error("Previous SDK binding must be stopped before a new launch"); return existing; }
    const opening = this.opening.get(binding.ticketId); if (opening) { const handle = await opening; if (!same(handle.binding, binding)) throw new Error("SDK opening binding changed"); return handle; }
    const run = this.openSession(binding); this.opening.set(binding.ticketId, run);
    try { return await run; } finally { if (this.opening.get(binding.ticketId) === run) this.opening.delete(binding.ticketId); }
  }
  private async openSession(binding: WorkerToken): Promise<Handle> {
    const directory = this.directories.get(binding.ticketId);
    if (directory?.state !== "ready") throw new Error("SDK Worker requires a prepared execution directory");
    let initialized = false;
    const files = new WorkspaceFiles(directory.cwd, () => { if (initialized) this.check(binding); });
    initialized = true;
    const handle: Handle = { binding: structuredClone(binding), sdk: undefined!, files, stopping: false, reviewers: new Set() };
    const reviewExtension: ExtensionFactory = pi => {
      if (!this.options.reviewer) return;
      pi.registerTool({ name: "request_review", label: "Request managed review", description: "Ask an independent read-only reviewer to inspect the host's fixed head/base and complete diff. Returns an artifact, not a GitHub write receipt.",
        parameters: Type.Object({ artifactId: Type.String({ minLength: 1, maxLength: 200 }) }, { additionalProperties: false }),
        execute: async (_id, input, signal) => {
          this.check(binding);
          const review = await this.review(handle, input.artifactId, signal);
          this.check(binding);
          const delivery = review.status === "completed" ? this.options.reviewer?.onCompleted?.(structuredClone(binding), review) : undefined;
          return { content: [{ type: "text", text: JSON.stringify({ review, ...(delivery === undefined ? {} : { delivery }) }) }], details: { artifactId: input.artifactId, status: review.status } };
        } });
    };
    const sdk = await ScratchPiSession.open({ store: this.options.store, root: this.options.root, allowedRoot: this.options.allowedRoot, binding,
      modelRuntime: this.options.modelRuntime, model: this.options.model,
      extensions: [files.extension(), reviewExtension], activeTools: ["vivi_report", "read_file", "write_file", "edit_file", "list_files", ...(this.options.reviewer ? ["request_review"] : [])],
      validate: () => this.check(binding),
      context: () => ({ ticketId: binding.ticketId, assignmentId: binding.assignmentId, role: "github-worker", instructions: "Work within the host-provided mandate. Use request_review for independent review. ready means ready for followed work, not merged or completed. External delivery receipts are separate facts. Never claim tests ran without host execution evidence." }),
      onRead: (token, inputIds) => { if (!this.options.engine().worker.read(token, inputIds)) throw new Error("SDK read has no committed domain delivery"); },
      onReport: (token, report) => !!this.options.engine().worker.report(token, report),
    });
    handle.sdk = sdk;
    if (this.closing) { await sdk.dispose(); throw new Error("SDK executor stopped while opening"); }
    this.handles.set(binding.ticketId, handle); return handle;
  }
  private async review(handle: Handle, artifactId: string, signal?: AbortSignal): Promise<PiReviewRecord> {
    const options = this.options.reviewer!; this.check(handle.binding);
    const input = options.input(structuredClone(handle.binding), artifactId);
    if (input.artifactId !== artifactId) throw new Error("Host review artifact identity changed");
    const reviewer = await ManagedPiReviewer.open({ store: this.options.store, root: this.options.root, binding: handle.binding,
      modelRuntime: options.modelRuntime, model: options.model, isCurrent: () => { try { this.check(handle.binding); return !handle.stopping; } catch { return false; } }, snapshot: () => options.current(handle.binding),
      readFile: async (file, readSignal) => { if (readSignal?.aborted) throw new Error("Review read aborted"); const content = handle.files.read(file.path); return { content, version: hash(content) }; } });
    handle.reviewers.add(reviewer);
    let stopping: Promise<void> | undefined;
    const abort = () => { stopping ??= reviewer.stop(); void stopping.catch(() => {}); };
    signal?.addEventListener("abort", abort, { once: true });
    try { if (signal?.aborted) abort(); this.check(handle.binding); return await reviewer.review(input); }
    finally { signal?.removeEventListener("abort", abort); await stopping; await reviewer.dispose(); handle.reviewers.delete(reviewer); }
  }
  private readonly launchAdapter: NonNullable<ShadowAdapters["launch"]> = async (_ticket: Ticket, _assignment: Assignment, binding: WorkerToken, context: EffectContext) => {
      this.claim(context);
      const previous = this.handles.get(binding.ticketId);
      if (previous && !same(previous.binding, binding)) { await this.quiesce(previous); this.claim(context); }
      let slot: SlotReservation;
      try { slot = this.slots.reserve(binding.ticketId, "launch", binding); } catch { throw new Later("SDK worker capacity is occupied or requires reconciliation"); }
      this.preparingSlots.set(binding.ticketId, slot);
      try {
        await this.directories.prepare(binding.ticketId, { recipe: this.options.recipe, signal: context.signal }); this.claim(context);
        slot = this.preparingSlots.get(binding.ticketId)!;
        if (!slot || !this.slots.valid(slot)) throw new Later("SDK preparing slot expired");
        const handle = await this.open(binding); handle.slot = this.preparingSlots.get(binding.ticketId)!; this.preparingSlots.delete(binding.ticketId); this.claim(context);
        if (!handle.slot || !this.slots.valid(handle.slot)) throw new Later("SDK opening slot expired");
        // A newly authorized Assignment can resume its stable role Session; startup sweep cannot.
        if (handle.sdk.ledger.session(handle.sdk.sessionKey)!.paused) await handle.sdk.resume();
        this.claim(context);
        this.save(binding, "opened");
      } catch (error) {
        slot = this.preparingSlots.get(binding.ticketId) ?? slot; this.preparingSlots.delete(binding.ticketId);
        const handle = this.handles.get(binding.ticketId);
        if (handle && same(handle.binding, binding)) await this.quiesce(handle);
        else if (!this.slots.release(slot)) {
          // prepare has really returned and no SDK was opened. Its expired local
          // reservation is quiet, while directory/Effect uncertainty stays intact.
          this.slots.used(); const current = this.slots.get(binding.ticketId);
          if (current?.phase === "uncertain" && same(current.binding, binding) && current.lease.owner === slot.lease.owner && current.lease.generation === slot.lease.generation) this.slots.reconcile(current, { quiet: true });
        }
        throw error;
      }
    };
  private beginLaunch(ticket: Ticket, assignment: Assignment, binding: WorkerToken, context: EffectContext): Promise<void> {
    const current = this.launches.get(binding.ticketId);
    if (current) { if (!same(current.binding, binding)) return Promise.reject(new Later("Previous SDK launch is still stopping")); return current.done; }
    const task = { binding: structuredClone(binding), controller: new AbortController(), done: Promise.resolve() };
    this.launches.set(binding.ticketId, task);
    task.done = Promise.resolve().then(() => this.launchAdapter(ticket, assignment, binding, { ...context, signal: AbortSignal.any([context.signal, task.controller.signal]) }))
      .finally(() => { if (this.launches.get(binding.ticketId) === task) this.launches.delete(binding.ticketId); });
    return task.done;
  }
  readonly adapters: Pick<ShadowAdapters, "launch" | "delivery" | "stop"> = {
    launch: (ticket, assignment, binding, context) => this.beginLaunch(ticket, assignment, binding, context),
    delivery: async (ticket: Ticket, _assignment: Assignment, inputIds: string[], binding: WorkerToken, context: EffectContext) => {
      this.claim(context); this.check(binding, false);
      const record = this.record(binding.ticketId);
      if (!record || record.state !== "opened" || !same(record.binding, binding)) throw new DeliveryRejected("SDK Worker is unavailable; inspect its persistent state");
      const handle = await this.open(binding); this.claim(context);
      if (!handle.slot) { try { handle.slot = this.slots.reserve(binding.ticketId, "wake", binding); } catch { throw new Later("SDK delivery awaits worker capacity"); } }
      this.check(binding);
      const requestId = `delivery-${hash([binding, inputIds])}`;
      const previous = handle.sdk.get(requestId);
      if (previous) { if (!same(previous.binding, binding) || hash(previous.inputIds) !== hash(inputIds)) throw new DeliveryRejected("SDK delivery identity drift"); return; }
      const inputs = inputIds.map(id => {
        const input = ticket.inputs.find(item => item.id === id); if (!input) throw new DeliveryRejected("Missing SDK Ticket input");
        const trigger = "triggerId" in input ? this.options.store.triggers.get(input.triggerId) : undefined;
        return { input, ...(trigger ? { trigger } : {}) };
      });
      handle.sdk.prepare({ requestId, inputIds, mode: "followUp", text: JSON.stringify({ ticket: { id: ticket.id, title: ticket.title, mandate: ticket.mandate, execution: ticket.execution }, inputs }) });
      // No prompt here: ShadowEngine.completeDelivery must commit first.
    },
    stop: async (control: StopControl) => {
      const launching = this.launches.get(control.ticketId);
      if (launching && launching.binding.assignmentId === control.assignmentId && (!control.binding || same(control.binding, launching.binding))) { launching.controller.abort(); await launching.done.catch(() => undefined); }
      const pending = this.opening.get(control.ticketId); if (pending) await pending.catch(() => undefined);
      const handle = this.handles.get(control.ticketId);
      if (handle && handle.binding.assignmentId === control.assignmentId && (!control.binding || same(control.binding, handle.binding))) await this.quiesce(handle);
      const record = this.record(control.ticketId);
      if (record && record.binding.assignmentId === control.assignmentId && (!control.binding || same(control.binding, record.binding))) this.save(record.binding, "stopped");
    },
  };
  /** Scan persisted inboxes after domain commits. Repeated/concurrent scans never redispatch a JSONL entry. */
  sweep(): Promise<void> {
    if (this.scanning) return this.scanning;
    const run = this.scan(); this.scanning = run;
    void run.then(() => { if (this.scanning === run) this.scanning = undefined; }, () => { if (this.scanning === run) this.scanning = undefined; }); return run;
  }
  private async scan(): Promise<void> {
    if (this.closing || !this.options.enabled()) return;
    const rows = this.options.store.db.all<{ data: string }>("SELECT data FROM vivi_kv WHERE key LIKE 'pi:executor:%'");
    for (const row of rows) {
      const record = JSON.parse(row.data) as PiExecutorRecord;
      if (record.state !== "opened" || !this.current(record.binding)) continue;
      if (!this.handles.has(record.binding.ticketId)) {
        if (this.slots.get(record.binding.ticketId)) { this.markUncertain(record.binding); continue; }
        ScratchPiSession.reconcileSaved(this.options.store, this.options.root, record.binding, this.options.allowedRoot);
        if (this.interrupted(record.binding)) { this.markUncertain(record.binding); continue; }
      }
      const handle = await this.open(record.binding);
      if (this.options.initialAssignment) {
        const requestId = `assignment-${hash(handle.binding)}`;
        if (!handle.sdk.get(requestId)) {
          if (!handle.slot) { try { handle.slot = this.slots.reserve(handle.binding.ticketId, "wake", handle.binding); } catch { continue; } }
          this.check(handle.binding);
          const ticket = this.options.store.tickets.get(handle.binding.ticketId);
          if (!ticket || !liveTicket(ticket)) continue;
          const origins = ticket.origin.triggerIds.map(id => this.options.store.triggers.get(id));
          if (!origins.length || origins.some(trigger => !trigger)) throw new Error("Initial Assignment has no durable origin");
          handle.sdk.prepare({ requestId, inputIds: [], mode: "followUp", text: JSON.stringify({
            kind: "initial-assignment", ticket: { id: ticket.id, title: ticket.title, mandate: ticket.mandate, execution: ticket.execution },
            assignmentId: handle.binding.assignmentId, origins,
            instructions: "Implement the accepted origin requirements using the workspace tools. Record a structured vivi_report when ready for host verification. Do not claim tests were run unless the host provided evidence. Git delivery and followed-thread completion are separate host steps.",
          }) });
        }
      }
      for (const receipt of handle.sdk.ledger.list(handle.sdk.sessionKey)) {
        if (!this.current(handle.binding) || handle.stopping || !same(receipt.binding, handle.binding) || receipt.entryId || ["handled", "rejected", "stopped"].includes(receipt.status)) continue;
        const ticket = this.options.store.tickets.get(handle.binding.ticketId);
        if (!ticket || !liveTicket(ticket) || receipt.inputIds.some(id => ticket.undelivered.includes(id) || !ticket.inputs.some(input => input.id === id && (input.kind !== "trigger" || input.deliveredTo === handle.binding.assignmentId)))) continue;
        if (!handle.slot) { try { handle.slot = this.slots.reserve(handle.binding.ticketId, "wake", handle.binding); } catch { continue; } }
        if (!this.slots.valid(handle.slot)) { this.markUncertain(handle.binding); continue; }
        handle.slot = this.slots.phase(handle.slot, "running");
        try {
          const result = await handle.sdk.activate(receipt.requestId);
          if (this.turns.has(receipt.requestId)) continue;
          const turn = result.completion.then(() => {}, () => { this.markUncertain(handle.binding); }).finally(async () => {
            try {
              await handle.sdk.session.waitForIdle();
              this.idleReport(handle, receipt.requestId);
              if (handle.slot && !handle.stopping) { handle.slot = this.slots.phase(handle.slot, "settling"); if (this.slots.release(handle.slot)) handle.slot = undefined; }
            } finally { this.turns.delete(receipt.requestId); }
          });
          this.turns.set(receipt.requestId, turn); void turn.catch(() => this.markUncertain(handle.binding));
        } catch { this.markUncertain(handle.binding); await this.quiesce(handle); }
      }
    }
  }
  private idleReport(handle: Handle, requestId: string): void {
    if (handle.stopping || !this.current(handle.binding)) return;
    this.check(handle.binding, !!handle.slot);
    const receipt = handle.sdk.get(requestId), read = receipt?.reads.filter(item => same(item.binding, handle.binding)).at(-1);
    const report = receipt?.reports.filter(item => same(item.binding, handle.binding) && (item.turnId === read?.turnId || item.readTurnId === read?.turnId)).at(-1)?.report;
    const last = handle.sdk.session.agent.state.messages.filter(message => message.role === "assistant").at(-1);
    const failed = last?.role === "assistant" && ["error", "aborted"].includes(last.stopReason);
    const idleKey = `pi:executor-idle:${hash([handle.binding, read?.turnId ?? requestId])}`;
    this.options.store.atomic(() => {
      this.check(handle.binding, !!handle.slot);
      if (this.options.store.get(idleKey)) return;
      if (!report || report.state === "progress") {
        if (failed) this.options.engine().worker.report(handle.binding, { state: "failed", summary: "SDK Worker run failed. Inspect the persistent input and external operation receipts before retrying." });
        else if (read) this.options.engine().worker.report(handle.binding, { state: "waiting", summary: "Worker ended without a final structured status report. Request its status before treating the assignment as complete." });
        else this.markUncertain(handle.binding);
      }
      this.options.engine().worker.turnEnded(handle.binding);
      this.options.store.set(idleKey, true);
    });
  }
  private interrupted(binding: WorkerToken): boolean {
    return new PiLedger(this.options.store).list(`worker-${binding.ticketId}`).some(receipt => receipt.entryId
      && same(receipt.entryBinding ?? receipt.binding, binding) && !["settled", "handled", "rejected", "stopped"].includes(receipt.status));
  }
  /** Explicit recovery after inspection; never resumes an interrupted provider run automatically. */
  reconcile(ticketId: string, options: { quiet: true }): void {
    const record = this.record(ticketId), slot = this.slots.get(ticketId);
    const owner = record && this.options.store.get<{ pid: number } | null>(`pi:owner:${record.sessionKey}`);
    if (options.quiet !== true || !record || record.state === "stopped" || !this.current(record.binding) || this.handles.has(ticketId) || this.opening.has(ticketId) || this.launches.has(ticketId) || (!dead(record.pid) && !(record.pid === process.pid && record.quiet)) || (owner && !dead(owner.pid))) throw new Error("SDK recovery requires a dead previous process or confirmed local disposal and no live session");
    if (slot) { this.slots.used(); const current = this.slots.get(ticketId)!; if (current.phase !== "uncertain" || !this.slots.reconcile(current, { quiet: true })) throw new Error("SDK slot requires expiry and exact quiet reconciliation"); }
    ScratchPiSession.reconcileSaved(this.options.store, this.options.root, record.binding, this.options.allowedRoot);
    const interrupted = this.interrupted(record.binding);
    this.save(record.binding, interrupted ? "uncertain" : "opened", true);
    if (interrupted) this.options.engine().worker.interrupted(record.binding);
  }
  async idle(): Promise<void> { if (this.scanning) await this.scanning; await Promise.all([...this.turns.values()]); }
  private quiesce(handle: Handle): Promise<void> {
    if (handle.quiescing) return handle.quiescing;
    handle.stopping = true;
    return handle.quiescing = this.drainHandle(handle);
  }
  private async drainHandle(handle: Handle): Promise<void> {
    await Promise.all([handle.sdk.stop(), ...[...handle.reviewers].map(reviewer => reviewer.stop())]);
    await handle.sdk.dispose();
    const record = this.record(handle.binding.ticketId);
    if (record && same(record.binding, handle.binding)) this.save(handle.binding, record.state, true);
    const released = !handle.slot || this.slots.release(handle.slot);
    if (this.handles.get(handle.binding.ticketId) === handle) this.handles.delete(handle.binding.ticketId);
    if (!released) { this.markUncertain(handle.binding); throw new Error("SDK resource stopped but slot ownership requires reconciliation"); }
    handle.slot = undefined;
  }
  async stop(): Promise<void> {
    if (this.closing) { await this.idle(); return; }
    this.closing = true; clearInterval(this.timer);
    for (const task of this.launches.values()) task.controller.abort();
    await Promise.all([...this.launches.values()].map(task => task.done.catch(() => undefined)));
    await Promise.all([...this.opening.values()].map(run => run.catch(() => undefined)));
    await Promise.all([...this.handles.values()].map(handle => this.quiesce(handle))); await this.idle();
  }
}
