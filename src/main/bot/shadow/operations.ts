// SPDX-License-Identifier: MIT
import { Later, ShadowEffects, type EffectContext, type EffectCommit, Uncertain } from "./effects.ts";
import type { EffectRecord, Operation, ShadowStore } from "./store.ts";

export interface OperationAdapter {
  execute(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "failed"; receipt?: unknown }>;
  inspect(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "not-applied" | "unknown"; receipt?: unknown }>;
}
export interface OperationContext extends EffectContext { source: string; instance: string; key: string }
export interface SourceOperation extends Operation { cancelRequested?: boolean }
type StoredOperation = SourceOperation;
type Payload = { operation: Operation; phase: "execute" | "reconcile" };
const keyOf = (op: Pick<Operation, "source" | "instance" | "key">): string => JSON.stringify([op.source, op.instance, op.key]);
const sameIntent = (a: Operation, b: Operation): boolean => a.id === b.id && keyOf(a) === keyOf(b)
  && JSON.stringify(a.payload) === JSON.stringify(b.payload);
const sameEffect = (a: EffectRecord, b: EffectRecord): boolean => a.seq === b.seq && a.generation === b.generation
  && a.claimToken === b.claimToken && a.claimedGeneration === b.claimedGeneration && a.status === b.status;

/** Unknown writes are never executed again without positive not-applied evidence. */
export class ShadowOperations {
  private readonly store: ShadowStore;
  private readonly effects: ShadowEffects;
  private readonly adapter: OperationAdapter;
  private readonly now: () => number;
  private readonly paused: () => boolean;

  constructor(store: ShadowStore, effects: ShadowEffects, adapter: OperationAdapter,
    options: { now?: () => number; paused?: boolean | (() => boolean) } = {}) {
    this.store = store;
    this.effects = effects;
    this.adapter = adapter;
    this.now = options.now ?? Date.now;
    const paused = options.paused ?? false;
    this.paused = typeof paused === "function" ? paused : () => paused;
    effects.handle("source-operation", context => this.execute(context), { limit: () => this.paused() ? 0 : 1 });
    effects.handle("source-reconcile", context => this.inspect(context), { limit: 1, quiet: true });
  }

  plan(intent: Omit<Operation, "status" | "revision">): Operation {
    return this.store.atomic(() => {
      // Store owns immutable intent validation; enqueue is part of the same commit.
      const operation = this.store.operations.plan(intent);
      if (operation.status === "planned") this.enqueue("execute", operation);
      return operation;
    });
  }

  /** Reopening schedules reads only; it cannot reissue an uncertain write. */
  recover(): void {
    this.store.atomic(() => {
      this.store.effects.expire(this.now());
      for (const row of this.store.db.all<{ data: string }>("SELECT data FROM dsh_operations WHERE status IN ('planned','uncertain')")) {
        const operation = this.checkpointClaim(JSON.parse(row.data) as StoredOperation);
        if (operation.status === "uncertain") this.enqueue("reconcile", operation);
      }
    });
  }

  retry(source: string, instance: string, key: string): Operation {
    return this.store.atomic(() => {
      const operation = this.require(source, instance, key);
      if (operation.status !== "failed") throw new Error("只有 failed 操作可以重试；未知结果必须先对账");
      this.transition(operation, "planned");
      const planned = this.require(source, instance, key);
      this.enqueue("execute", planned);
      return planned;
    });
  }

  cancel(source: string, instance: string, key: string): SourceOperation {
    return this.store.atomic(() => {
      this.store.effects.expire(this.now());
      const current = this.checkpointClaim(this.require(source, instance, key));
      if (current.status === "planned" || current.status === "failed") {
        this.transition(current, "cancelled");
        this.store.effects.cancelPending("source-operation", keyOf(current));
      } else if (current.status === "uncertain" && !current.cancelRequested) {
        // Cancellation is an orthogonal request, not evidence of an absent external write.
        // Keep revision unchanged so a live execution can still report its actual result.
        const changed = this.store.db.run("UPDATE dsh_operations SET data=? WHERE id=? AND status='uncertain' AND revision=?",
          JSON.stringify({ ...current, cancelRequested: true }), current.id, current.revision).changes;
        if (!changed) throw new Error("操作取消请求 CAS 失败");
        this.enqueue("reconcile", { ...current, cancelRequested: true } as StoredOperation);
      }
      return this.require(source, instance, key);
    });
  }

  get(source: string, instance: string, key: string): SourceOperation | undefined { return this.store.operations.get(source, instance, key); }

  private require(source: string, instance: string, key: string): StoredOperation {
    const operation = this.get(source, instance, key);
    if (!operation) throw new Error("操作不存在");
    return operation;
  }

  /** A committed claim can outlive the process before execute persists its checkpoint. */
  private checkpointClaim(operation: StoredOperation): StoredOperation {
    if (operation.status !== "planned") return operation;
    const source = this.store.effects.get("source-operation", keyOf(operation));
    if (source?.status !== "uncertain") return operation;
    const attempt = this.effects.attempt(source);
    const previous = attempt?.payload as Payload | undefined;
    if (!attempt || attempt.seq !== source.seq || attempt.generation !== source.generation
      || attempt.claimToken !== source.claimToken || attempt.claimedGeneration !== source.claimedGeneration
      || source.claimedGeneration !== source.generation || previous?.phase !== "execute"
      || !sameIntent(previous.operation, operation) || previous.operation.revision !== operation.revision) {
      // An unrelated/older attempt cannot authorize either retry or cancellation.
      throw new Uncertain("planned 操作缺少对应未知 claim 的 attempt 证据");
    }
    this.transition(operation, "uncertain");
    return this.require(operation.source, operation.instance, operation.key);
  }

  private enqueue(phase: Payload["phase"], operation: Operation): void {
    const kind = phase === "execute" ? "source-operation" : "source-reconcile";
    const existing = this.store.effects.get(kind, keyOf(operation));
    const payload: Payload = { operation, phase };
    // A replay must not invalidate a live claim or repeatedly postpone an unknown read.
    const prior = existing?.payload as Payload | undefined;
    if (existing && ["pending", "running", "uncertain"].includes(existing.status)
      && prior?.phase === phase && sameIntent(prior.operation, operation) && prior.operation.revision === operation.revision) {
      // Inspection is read-only, so its abandoned lease may be explicitly retried.
      if (phase === "reconcile" && existing.status === "uncertain") this.effects.reconcile(existing, "retry");
      return;
    }
    this.store.effects.enqueue(kind, keyOf(operation), payload, this.now());
    this.store.afterCommit(() => this.effects.kick());
  }

  private payload(context: EffectContext, phase: Payload["phase"]): Operation {
    const snapshot = this.effects.attempt(context.claim);
    const payload = snapshot?.payload as Payload | undefined;
    if (!snapshot || !sameEffect(snapshot, context.claim) || payload?.phase !== phase
      || keyOf(payload.operation) !== context.claim.key) throw new Later("无有效的 immutable operation attempt");
    return payload.operation;
  }

  private owned(claim: EffectRecord): boolean {
    const live = this.store.effects.get(claim.kind, claim.key);
    return !!live && live.status === "running" && sameEffect(live, claim) && live.generation === live.claimedGeneration
      && live.leaseOwner === claim.leaseOwner && (live.leaseUntil ?? 0) > this.now();
  }

  private context(operation: Operation, context: EffectContext): OperationContext {
    return { ...context, source: operation.source, instance: operation.instance, key: operation.key };
  }

  private transition(expected: Operation, next: Operation["status"], receipt?: unknown): void {
    if (!this.store.operations.transition(expected, next, receipt)) throw new Uncertain("操作 revision CAS 失败");
  }

  private settle(claim: EffectRecord): void {
    if (!this.store.effects.settle(claim, "done", this.now())) throw new Uncertain("操作提交时 Effect 租约失效");
  }

  private async execute(context: EffectContext): Promise<EffectCommit> {
    const expected = this.payload(context, "execute");
    const operation = this.store.atomic(() => {
      if (!this.owned(context.claim) || context.signal.aborted) throw new Later("Effect claim 已失效");
      if (this.paused()) throw new Later("操作已暂停");
      const current = this.get(expected.source, expected.instance, expected.key);
      if (!current || !sameIntent(current, expected) || current.status !== "planned" || current.revision !== expected.revision) return;
      this.transition(current, "uncertain");
      // This transaction is durable before the adapter can observe any external call.
      return this.require(current.source, current.instance, current.key);
    });
    if (!operation) return () => false;
    let result: Awaited<ReturnType<OperationAdapter["execute"]>>;
    try {
      result = await this.adapter.execute(structuredClone(operation), this.context(operation, context));
      if (result.status !== "confirmed" && result.status !== "failed") throw new Error("adapter.execute 返回未知状态");
    } catch (error) { throw new Uncertain(`外部操作结果未知: ${String(error)}`); }
    return claim => {
      try {
        if (!this.owned(claim)) throw new Uncertain("执行 owner 已失效");
        const current = this.require(operation.source, operation.instance, operation.key);
        if (!sameIntent(current, operation) || current.status !== "uncertain" || current.revision !== operation.revision) return false;
        this.transition(current, result.status, result.receipt);
        if (result.status === "failed" && current.cancelRequested) {
          this.transition(this.require(current.source, current.instance, current.key), "cancelled");
        }
        // Commit both facts here; SQL ABORT or an expired clock rolls both back.
        this.settle(claim);
        return true;
      } catch (error) { throw new Uncertain(`外部操作提交失败: ${String(error)}`); }
    };
  }

  private async inspect(context: EffectContext): Promise<EffectCommit> {
    const expected = this.payload(context, "reconcile");
    const captured = this.store.atomic(() => {
      if (!this.owned(context.claim) || context.signal.aborted) throw new Later("对账 claim 已失效");
      this.store.effects.expire(this.now());
      const operation = this.get(expected.source, expected.instance, expected.key);
      if (!operation || operation.status !== "uncertain" || !sameIntent(operation, expected) || operation.revision !== expected.revision) return;
      const source = this.store.effects.get("source-operation", keyOf(operation));
      if (source?.status === "running") throw new Later("source-operation 有效租约内不能对账");
      const attempt = source && this.effects.attempt(source);
      const previous = attempt?.payload as Payload | undefined;
      if (!source || source.status !== "uncertain" || !previous || !sameIntent(previous.operation, operation)
        || previous.operation.revision + 1 !== operation.revision) throw new Later("缺少对应未知写入的 attempt 证据");
      return { operation, source };
    });
    if (!captured) return () => false;
    const { operation, source } = captured;
    const result = await this.adapter.inspect(structuredClone(operation), this.context(operation, context));
    if (result.status === "unknown") throw new Later("外部结果仍未知");
    if (result.status !== "confirmed" && result.status !== "not-applied") throw new Later("无效的对账结果");
    return claim => {
      if (!this.owned(claim)) throw new Uncertain("对账 owner 已失效");
      const current = this.require(operation.source, operation.instance, operation.key);
      const live = this.store.effects.get("source-operation", keyOf(operation));
      if (!sameIntent(current, operation) || current.status !== "uncertain" || current.revision !== operation.revision
        || !live || !sameEffect(live, source)) return false;
      if (result.status === "confirmed") {
        this.transition(current, "confirmed", result.receipt);
        if (!this.effects.reconcile(source, "done")) throw new Later("源 Effect 对账 CAS 失败");
      } else {
        this.transition(current, "failed", result.receipt);
        const failed = this.require(current.source, current.instance, current.key);
        if (current.cancelRequested) {
          this.transition(failed, "cancelled");
          if (!this.effects.reconcile(source, "cancelled")) throw new Later("源 Effect 取消 CAS 失败");
        } else {
          this.transition(failed, "planned");
          this.enqueue("execute", this.require(current.source, current.instance, current.key));
          const updated = this.store.effects.get("source-operation", keyOf(current))!;
          if (!this.effects.reconcile(updated, "retry")) throw new Later("源 Effect 重试 CAS 失败");
        }
      }
      this.settle(claim);
      return true;
    };
  }
}
