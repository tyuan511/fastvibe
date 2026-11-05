// SPDX-License-Identifier: MIT
// Durable scheduling adapted from deepseek-ai/dsh-superagent-prototype
// at 8c32a9dc5d72c033816c6a8110b37f40cf94fba4; see ../core/NOTICE.md and LICENSE.
import { createHash, randomUUID } from "node:crypto";
import type { EffectKind, EffectRecord, ShadowStore } from "./store.ts";

/** A known precondition prevents execution; retry without counting a failure. */
export class Later extends Error {}
/** The external result is unknown; only explicit reconciliation may resume it. */
export class Uncertain extends Error {}
export const FAILURES_BEFORE_ERROR = 3;
export type EffectCommit = (claim: EffectRecord) => boolean | void;
export interface EffectContext { claim: EffectRecord; signal: AbortSignal; requestId: string }
class DomainRejected extends Error {}
export interface EffectOptions {
  limit?: number | (() => number);
  retry?: readonly [number, number];
  ordered?: boolean;
  quiet?: boolean;
}
export interface EffectHealth {
  state: "ready" | "error"; detail: string; at: string; waiting: number; failures: number; uncertain: number; since?: number;
}
type Handler = {
  run: (context: EffectContext) => Promise<EffectCommit | void>;
  limit: () => number; retry: readonly [number, number]; ordered: boolean; quiet: boolean;
};
type Task = { claim: EffectRecord; controller: AbortController; done: Promise<void> };
type Failure = { count: number; error: string };
const identity = (row: EffectRecord): unknown[] => [row.kind, row.key, row.seq, row.generation];
const attemptKey = (row: EffectRecord): string => `shadow:effect:attempt:${JSON.stringify([...identity({ ...row, generation: row.claimedGeneration ?? row.generation }), row.claimToken])}`;
const failureKey = (row: EffectRecord): string => `shadow:effect:failure:${JSON.stringify(identity(row))}`;
/** Stable across lease owners and retries, different for every payload generation. */
export const effectRequestId = (row: EffectRecord): string => `shadow-effect:${createHash("sha256").update(JSON.stringify(identity(row))).digest("hex")}`;
const sameAttempt = (current: EffectRecord, claim: EffectRecord): boolean => current.seq === claim.seq
  && current.claimToken === claim.claimToken && current.claimedGeneration === claim.generation;

/** Isolated persistent dispatcher. Handlers perform IO first, then return synchronous fact commits. */
export class ShadowEffects {
  private readonly store: ShadowStore;
  private readonly now: () => number;
  private readonly owner: string;
  private readonly leaseMs: number;
  private readonly handlers = new Map<EffectKind, Handler>();
  private readonly tasks = new Set<Task>();
  private readonly dispatchErrors = new Map<EffectKind, string>();
  private started = false;
  private stopped = false;
  private scheduled = false;

  constructor(store: ShadowStore, options: { now?: () => number; owner?: string; leaseMs?: number } = {}) {
    this.store = store;
    this.now = options.now ?? Date.now;
    this.owner = options.owner ?? randomUUID();
    this.leaseMs = options.leaseMs ?? 30_000;
    if (!this.owner || !Number.isSafeInteger(this.leaseMs) || this.leaseMs <= 0) throw new Error("Invalid effect lease");
  }
  handle(kind: EffectKind, run: Handler["run"], options: EffectOptions = {}): void {
    if (this.handlers.has(kind)) throw new Error(`Handler already registered: ${kind}`);
    const limit = options.limit ?? 1;
    const retry = options.retry ?? [2000, 60_000];
    if (!retry.every(value => Number.isSafeInteger(value) && value > 0) || retry[1] < retry[0]) throw new Error("Invalid retry delays");
    if (typeof limit === "number" && (!Number.isSafeInteger(limit) || limit < 0)) throw new Error("Invalid effect limit");
    this.handlers.set(kind, { run, limit: typeof limit === "number" ? () => limit : limit,
      retry, ordered: options.ordered ?? false, quiet: options.quiet ?? false });
    this.kick();
  }
  start(): void { this.started = true; this.stopped = false; this.pulse(); }
  kick(): void {
    if (this.scheduled || !this.started || this.stopped) return;
    this.scheduled = true;
    queueMicrotask(() => { this.scheduled = false; this.dispatch(); });
  }
  pulse(): void {
    this.store.atomic(() => { this.store.effects.expire(this.now()); });
    this.kick();
  }
  async idle(kind?: EffectKind): Promise<void> {
    for (;;) {
      this.dispatch();
      const tasks = [...this.tasks].filter(task => kind === undefined || task.claim.kind === kind);
      if (!tasks.length) return;
      await Promise.all(tasks.map(task => task.done));
    }
  }
  async drain(options: { abort?: boolean } = {}): Promise<void> {
    this.stopped = true;
    if (options.abort) for (const task of this.tasks) task.controller.abort();
    await Promise.all([...this.tasks].map(task => task.done));
  }
  /** Ordinary failures of the live generation; Later neither increments nor resets them. */
  failures(kind: EffectKind, key: string): number {
    return this.store.atomic(() => {
      const row = this.store.effects.get(kind, key);
      if (!row || row.status === "done" || row.status === "cancelled") return 0;
      return this.store.get<Failure>(failureKey(row))?.count ?? 0;
    });
  }
  health(kind: EffectKind): EffectHealth {
    return this.store.atomic(() => {
      const rows = this.rows(kind);
      let failures = 0, uncertain = 0, since: number | undefined, lastError = "";
      for (const row of rows) {
        since = since === undefined ? row.since : Math.min(since, row.since);
        if (row.status === "uncertain") uncertain++;
        const failure = this.store.get<Failure>(failureKey(row));
        if (failure && failure.count >= failures) { failures = failure.count; lastError = failure.error; }
      }
      const dispatchError = this.dispatchErrors.get(kind);
      const failing = !!dispatchError || uncertain > 0 || (!this.handlers.get(kind)?.quiet && failures >= FAILURES_BEFORE_ERROR);
      const unknown = uncertain ? `; ${uncertain} unknown, reconciliation required` : "";
      const error = dispatchError ?? lastError;
      return { state: failing ? "error" : "ready",
        detail: `${rows.length} waiting${unknown}${since === undefined ? "" : `; since ${since}`}${error ? `; ${error}` : ""}`,
        at: new Date(this.now()).toISOString(), waiting: rows.length, failures, uncertain, ...(since === undefined ? {} : { since }) };
    });
  }
  /** Immutable claimed payload survives updates to the live row and process restarts. */
  attempt(expected: EffectRecord): EffectRecord | undefined {
    return this.store.atomic(() => this.store.get<EffectRecord>(attemptKey(expected)));
  }
  reconcile(expected: EffectRecord, outcome: "retry" | "done" | "cancelled"): boolean {
    if (!["retry", "done", "cancelled"].includes(outcome)) throw new Error("Invalid reconciliation outcome");
    return this.store.atomic(() => {
      const current = this.store.effects.get(expected.kind, expected.key);
      if (expected.status !== "uncertain" || !current || current.status !== "uncertain" || current.seq !== expected.seq
        || current.generation !== expected.generation || current.claimToken !== expected.claimToken
        || current.claimedGeneration !== expected.claimedGeneration || !this.attempt(current)) return false;
      const changed = this.store.effects.reconcile(current, outcome, this.now());
      if (changed) this.store.afterCommit(() => this.kick());
      return changed;
    });
  }
  private rows(kind: EffectKind): EffectRecord[] {
    return this.store.db.all<{ key: string }>("SELECT key FROM dsh_effects WHERE kind=? AND status IN ('pending','running','uncertain') ORDER BY seq", kind)
      .map(row => this.store.effects.get(kind, row.key)!);
  }
  private claim(kind: EffectKind, handler: Handler): EffectRecord | undefined {
    return this.store.atomic(() => {
      const now = this.now();
      this.store.effects.expire(now);
      const rows = this.rows(kind);
      const row = handler.ordered ? rows[0] : rows.find(item => item.status === "pending" && item.due <= now);
      if (!row || row.status !== "pending" || row.due > now) return;
      const limit = handler.limit();
      if (!this.started || this.stopped) return;
      if (!Number.isSafeInteger(limit) || limit < 0) throw new Error("Invalid effect limit");
      if (rows.filter(row => row.status === "running").length >= (handler.ordered ? Math.min(1, limit) : limit)) return;
      const claim = this.store.effects.claim(kind, row.key, this.owner, now, this.leaseMs);
      if (claim) this.store.set(attemptKey(claim), claim);
      return claim;
    });
  }
  private dispatch(): void {
    if (!this.started || this.stopped) return;
    for (const [kind, handler] of this.handlers) {
      try {
        for (;;) {
          if (!this.started || this.stopped) return;
          const claim = this.claim(kind, handler);
          if (!claim) break;
          if (!this.started || this.stopped) {
            // A claim's afterCommit callbacks may shut us down before launch. Release only
            // this still-valid attempt; an expired lease remains unknown for reconciliation.
            this.store.atomic(() => {
              const now = this.now();
              this.store.effects.expire(now);
              const current = this.store.effects.get(claim.kind, claim.key);
              if (current?.status === "running" && sameAttempt(current, claim) && current.leaseOwner === claim.leaseOwner) {
                this.store.effects.settle(claim, "pending", now);
              }
            });
            return;
          }
          this.launch(claim, handler);
        }
        this.dispatchErrors.delete(kind);
      } catch (error) { this.dispatchErrors.set(kind, String(error)); }
    }
  }
  private launch(claim: EffectRecord, handler: Handler): void {
    const controller = new AbortController();
    const task: Task = { claim, controller, done: Promise.resolve() };
    // Register first; a synchronous throw or shutdown must still see this attempt.
    this.tasks.add(task);
    task.done = this.execute(task, handler).catch(error => { this.dispatchErrors.set(claim.kind, String(error)); })
      .finally(() => { this.tasks.delete(task); this.kick(); });
  }
  private async execute(task: Task, handler: Handler): Promise<void> {
    const { claim, controller } = task;
    let abort!: () => void;
    const aborted = new Promise<never>((_, reject) => {
      abort = () => reject(new Uncertain("Dispatcher aborted before result was known"));
      controller.signal.addEventListener("abort", abort, { once: true });
    });
    // Keep the underlying IO alive in the task until it really settles, even after abort wins.
    const running = Promise.resolve().then(() => {
      if (controller.signal.aborted) throw new Uncertain("Dispatcher aborted before handler started");
      return handler.run({ claim: structuredClone(claim), signal: controller.signal, requestId: effectRequestId(claim) });
    });
    let ioSucceeded = false;
    try {
      const commit = await Promise.race([running, aborted]);
      ioSucceeded = true;
      this.store.atomic(() => {
        const current = this.owned(claim);
        if (!current) return;
        if (current.generation !== claim.generation) {
          this.store.effects.settle(claim, "done", this.now());
          return;
        }
        let result: boolean | void;
        try {
          // The domain callback gets its own savepoint. A false result must discard every
          // fact, enqueue and afterCommit action it produced before the outer effect settles.
          result = this.store.atomic(() => {
            const value = commit?.(structuredClone(claim));
            if (value !== undefined && typeof value !== "boolean") throw new Error("Effect commit must be synchronous and return boolean or void");
            if (value === false) throw new DomainRejected();
            return value;
          });
        } catch (error) {
          if (!(error instanceof DomainRejected)) throw error;
          result = false;
        }
        // Engine complete* may already have settled the exact claim inside the callback savepoint.
        const after = this.store.effects.get(claim.kind, claim.key);
        if (after?.status !== "done") {
          if (!this.owned(claim)) throw new Uncertain("Effect ownership changed during commit");
          if (!this.store.effects.settle(claim, result === false ? "cancelled" : "done", this.now())) {
            throw new Uncertain("Effect settlement lost ownership");
          }
        }
        // This check must be the transaction's last clock read. Engine settlement clears
        // lease fields, so fence against the immutable lease captured at claim time too.
        const settled = this.store.effects.get(claim.kind, claim.key);
        const validIdentity = settled && settled.seq === claim.seq && settled.generation === claim.generation
          && settled.claimToken === claim.claimToken && settled.claimedGeneration === undefined;
        if (!validIdentity || (settled.status !== "done" && settled.status !== "cancelled")
          || settled.leaseOwner !== undefined || settled.leaseUntil !== undefined
          || claim.leaseUntil === undefined || claim.leaseUntil <= this.now() || controller.signal.aborted) {
          throw new Uncertain("Effect claim invalid at transaction completion");
        }
      });
    } catch (error) {
      this.store.atomic(() => {
        const current = this.owned(claim);
        if (!current) return;
        if (ioSucceeded || error instanceof Uncertain || controller.signal.aborted) {
          this.store.effects.settle(claim, "uncertain", this.now(), this.now(), String(error).slice(0, 1000));
          return;
        }
        if (current.generation !== claim.generation) {
          this.store.effects.settle(claim, "done", this.now());
          return;
        }
        let count = this.store.get<Failure>(failureKey(claim))?.count ?? 0;
        const later = error instanceof Later;
        const detail = later ? "" : String(error).slice(0, 1000);
        if (!later) this.store.set(failureKey(claim), { count: ++count, error: detail } satisfies Failure);
        const delay = later ? handler.retry[0] : Math.min(handler.retry[1], handler.retry[0] * 2 ** Math.min(count - 1, 30));
        this.store.effects.settle(claim, "pending", this.now(), this.now() + delay, detail);
      });
    } finally {
      // No handler may outlive drain() and use a store the caller has already closed.
      await running.catch(() => {});
      controller.signal.removeEventListener("abort", abort);
    }
  }
  private owned(claim: EffectRecord): EffectRecord | undefined {
    const now = this.now();
    this.store.effects.expire(now);
    const row = this.store.effects.get(claim.kind, claim.key);
    return row && row.status === "running" && sameAttempt(row, claim) && row.leaseOwner === claim.leaseOwner
      && row.leaseUntil !== undefined && row.leaseUntil > now ? row : undefined;
  }
}
