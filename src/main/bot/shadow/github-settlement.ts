// SPDX-License-Identifier: MIT
import type { EngineForSources } from "../core/engine.ts";
import { threadKey, type ThreadRef, type Ticket } from "../core/model.ts";
import type { Policy } from "../core/ports.ts";
import { GithubOperationDryRun, type GithubOperationPayload, type GithubOperationPlan, type GithubOperationRequest } from "./github-operation.ts";
import { ShadowOperations } from "./operations.ts";
import type { ShadowSourceRegistry } from "./source-registry.ts";
import type { Operation, ShadowStore } from "./store.ts";

export interface GithubMergeSettlementEvidence {
  ticketId: string;
  closedAt: string;
  originIssue: number;
  pullThread: ThreadRef;
  mergeOperation: { source: string; instance: string; key: string };
  closeRequest: GithubOperationRequest;
}
export type GithubContinuationStatus = "pending" | "uncertain" | "failed" | "confirmed" | "cancelled";
export interface GithubIssueContinuation {
  version: 1;
  decisionId: string;
  sourceRevision: number;
  policyVersion: string;
  ended: NonNullable<Ticket["ended"]>;
  closedAt: string;
  ticketId: string;
  originIssue: number;
  pullThread: ThreadRef;
  mergeOperation: { source: string; instance: string; key: string };
  closeOperation: { source: string; instance: string; key: string; id: string };
  intent: GithubOperationRequest;
}
export interface GithubIssueContinuationView extends GithubIssueContinuation {
  status: GithubContinuationStatus;
  operation: Operation;
  plan: GithubOperationPlan;
}

const recordKey = (ticketId: string): string => `shadow:m11:github-issue-continuation:${ticketId}`;
const clone = <T>(value: T): T => structuredClone(value);
const same = (a: unknown, b: unknown): boolean => JSON.stringify(a) === JSON.stringify(b);
const object = (value: unknown): Record<string, unknown> | undefined => value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
function positive(value: unknown, name: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${name} 必须是正整数`);
  return Number(value);
}
function sha(value: unknown): string | undefined {
  return typeof value === "string" && /^[0-9a-f]{7,64}$/i.test(value) ? value.toLowerCase() : undefined;
}
function receiptSha(value: unknown): string | undefined {
  const v = object(value); if (!v) return undefined;
  for (const key of ["sha", "mergeSha", "mergeCommit", "merge_commit_sha"]) {
    const found = sha(v[key]); if (found) return found;
  }
  for (const key of ["receipt", "result", "data", "body"]) { const found = receiptSha(v[key]); if (found) return found; }
  return undefined;
}
function authShape(request: GithubOperationRequest): unknown {
  const a = request.authorization;
  return { source: a.source, instance: a.instance, repositoryId: a.repositoryId, ticketId: a.ticketId, mandateId: a.mandateId, generation: a.generation, assignmentId: a.assignmentId, bindingClaim: a.bindingClaim, allowed: [...a.allowed].sort() };
}

/** Durable GitHub merge -> Issue-close continuation. It owns no worker and performs no transport call. */
export class GithubIssueSettlement {
  private readonly store: ShadowStore;
  private readonly operations: ShadowOperations;
  private readonly policy: () => Policy;
  private readonly registry: ShadowSourceRegistry;
  constructor(store: ShadowStore, operations: ShadowOperations, options: { policy: () => Policy; registry: ShadowSourceRegistry }) {
    this.store = store; this.operations = operations; this.policy = options.policy; this.registry = options.registry;
  }

  register(input: GithubMergeSettlementEvidence): GithubIssueContinuationView {
    return this.store.atomic(() => {
      const ticket = this.store.tickets.get(input.ticketId);
      if (!ticket) throw new Error("Ticket 不存在");
      this.validate(ticket, input);
      const merge = this.store.operations.get(input.mergeOperation.source, input.mergeOperation.instance, input.mergeOperation.key);
      if (!merge || merge.status !== "confirmed") throw new Error("merge operation 尚未 confirmed");
      const mergeSha = receiptSha(merge.receipt);
      if (!mergeSha) throw new Error("merge operation receipt 缺少 merge SHA");
      if (String(input.closeRequest.params.mergeCommit).toLowerCase() !== mergeSha) throw new Error("closeRequest mergeCommit 与 merge SHA 不匹配");
      const policy = this.policy();
      if (policy.paused || !policy.revalidate(ticket.mandate)) throw new Error("当前 Policy 不再允许该 continuation");
      const source = this.registry.instance(input.closeRequest.source);
      if (!source?.enabled || source.status !== "enabled") throw new Error("Source 未启用");

      const planner = new GithubOperationDryRun(this.store, this.registry, input.closeRequest.source, input.closeRequest.instance);
      const planned = planner.plan(input.closeRequest);
      const existing = this.store.get<GithubIssueContinuation>(recordKey(ticket.id));
      const record: GithubIssueContinuation = { version: 1, decisionId: ticket.decisionId, sourceRevision: source.revision,
        policyVersion: existing?.policyVersion ?? policy.version, ended: clone(ticket.ended!), closedAt: input.closedAt, ticketId: ticket.id, originIssue: input.originIssue, pullThread: clone(input.pullThread),
        mergeOperation: clone(input.mergeOperation), closeOperation: { source: planned.source, instance: planned.instance, key: planned.key, id: planned.id }, intent: clone(input.closeRequest) };
      if (existing && !same(existing, record)) throw new Error("同一 Ticket 的 continuation intent 已漂移");
      // Insert once under the transaction; there is no mutable status or overwrite path.
      if (!existing) this.store.db.run("INSERT INTO dsh_kv(key,data) VALUES(?,?)", recordKey(ticket.id), JSON.stringify(record));
      const operation = this.operations.plan({ id: planned.id, source: planned.source, instance: planned.instance, key: planned.key, payload: planned.payload });
      return this.view(record, operation);
    });
  }

  /** Call immediately before external close writes. Reconciliation remains read-only.
   * issue-close is reserved host authority retained in the confirmed merge's allowed list;
   * a normal worker operation grant cannot grant this continuation.
   */
  authorize(operation: Operation): void {
    this.store.atomic(() => {
      const payload = operation.payload as GithubOperationPayload;
      const record = this.store.get<GithubIssueContinuation>(recordKey(payload?.authorization?.ticketId ?? ""));
      if (!record) throw new Error("continuation 不存在");
      const current = this.operations.get(record.closeOperation.source, record.closeOperation.instance, record.closeOperation.key);
      if (!current || current.id !== record.closeOperation.id || operation.id !== current.id || operation.source !== current.source
        || operation.instance !== current.instance || operation.key !== current.key || operation.revision !== current.revision
        || current.status !== operation.status || !["planned", "uncertain"].includes(current.status) || current.cancelRequested
        || !same(current.payload, operation.payload)) throw new Error("continuation operation 已失效或已取消");
      const ticket = this.store.tickets.get(record.ticketId);
      if (!ticket || ticket.decisionId !== record.decisionId || !same(ticket.ended, record.ended)) throw new Error("Ticket 不再属于同次 merged 结果");
      this.validate(ticket, { ...record, closeRequest: record.intent });
      const merge = this.operations.get(record.mergeOperation.source, record.mergeOperation.instance, record.mergeOperation.key);
      if (receiptSha(merge?.receipt) !== sha(record.intent.params.mergeCommit)) throw new Error("merge receipt SHA 已变化");
      const source = this.registry.instance(current.source);
      if (!source?.enabled || source.status !== "enabled" || source.revision !== record.sourceRevision) throw new Error("Source revision 已变化或未启用");
      const policy = this.policy();
      if (policy.paused || policy.version !== record.policyVersion || !policy.revalidate(ticket.mandate)) throw new Error("当前 Policy 拒绝 continuation");
      const planned = new GithubOperationDryRun(this.store, this.registry, current.source, current.instance).plan(record.intent);
      if (planned.id !== current.id || !same(planned.payload, current.payload)) throw new Error("continuation intent 不匹配");
    });
  }

  get(ticketId: string): GithubIssueContinuationView | undefined {
    const record = this.store.get<GithubIssueContinuation>(recordKey(ticketId));
    if (!record) return undefined;
    const operation = this.store.operations.get(record.closeOperation.source, record.closeOperation.instance, record.closeOperation.key);
    if (!operation || operation.id !== record.closeOperation.id) throw new Error("continuation operation 身份漂移");
    return this.view(record, operation);
  }

  cancel(ticketId: string): GithubIssueContinuationView {
    const record = this.store.get<GithubIssueContinuation>(recordKey(ticketId));
    if (!record) throw new Error("continuation 不存在");
    this.operations.cancel(record.closeOperation.source, record.closeOperation.instance, record.closeOperation.key);
    return this.get(ticketId)!;
  }

  /** Caller invokes this inside its existing outer store.atomic transaction. */
  closeMergedThread(sources: EngineForSources, ref: ThreadRef, evidence: GithubMergeSettlementEvidence): GithubIssueContinuationView {
    return this.store.atomic(() => {
      if (threadKey(ref) !== threadKey(evidence.pullThread)) throw new Error("closure ref 不匹配");
      sources.threadClosed(ref, "merged", evidence.closedAt);
      return this.register(evidence);
    });
  }

  private view(record: GithubIssueContinuation, operation: Operation): GithubIssueContinuationView {
    const plan = { ...operation, payload: operation.payload as GithubOperationPayload } as GithubOperationPlan;
    const status: GithubContinuationStatus = operation.status === "planned" ? "pending" : operation.status;
    return { ...clone(record), status, operation: clone(operation), plan: clone(plan) };
  }
  private origin(ticket: Ticket): { source: string; instance: string; repositoryId: string; number: number } {
    const trigger = this.store.triggers.get(ticket.origin.triggerId);
    if (!trigger) throw new Error("origin Trigger 不存在");
    const meta = trigger.meta;
    const number = positive(meta.number, "origin issue number");
    if (!this.registry.kind(trigger.source) || meta.kind !== "issue" || meta.isPr === true || typeof meta.instance !== "string" || !meta.instance || meta.repositoryId === undefined) throw new Error("origin Trigger 不是真实 GitHub Issue");
    return { source: trigger.source, instance: String(meta.instance), repositoryId: String(meta.repositoryId), number };
  }
  private pullNumber(ref: ThreadRef, origin: { source: string; instance: string; repositoryId: string }): number {
    const prefix = `github:${encodeURIComponent(origin.source)}:${encodeURIComponent(origin.instance)}:${encodeURIComponent(origin.repositoryId)}:thread:`;
    if (!ref.id.startsWith(prefix)) throw new Error("pull thread 仓库或 instance 不匹配");
    return positive(Number(ref.id.slice(prefix.length)), "pull number");
  }
  private validate(ticket: Ticket, input: GithubMergeSettlementEvidence): void {
    if (!ticket.ended || ticket.ended.outcome !== "merged" || ticket.ended.by === "human") throw new Error("Ticket 必须以非 human 的 merged 结果结束");
    const decision = this.store.decisions.get(ticket.decisionId);
    if (decision?.kind !== "accept" || decision.ticketId !== ticket.id || !same(decision.mandate, ticket.mandate)
      || !decision.triggerIds.includes(ticket.origin.triggerId)) throw new Error("Ticket Decision/Mandate 身份不匹配");
    positive(input.originIssue, "originIssue");
    const origin = this.origin(ticket);
    if (origin.number !== input.originIssue || input.pullThread.source !== origin.source) throw new Error("origin Issue 或 Source 不匹配");
    const follow = ticket.follows?.find(item => item.thread === threadKey(input.pullThread));
    if (!follow?.closed || follow.closed.outcome !== "merged") throw new Error("pull Follow 未以 merged 关闭");
    if (!Number.isFinite(Date.parse(input.closedAt)) || new Date(input.closedAt).toISOString() !== follow.closed.at) throw new Error("Follow closure 时间与 evidence 不匹配");
    const merge = this.store.operations.get(input.mergeOperation.source, input.mergeOperation.instance, input.mergeOperation.key);
    if (!merge || merge.status !== "confirmed") throw new Error("merge operation 未确认");
    const payload = merge.payload as GithubOperationPayload;
    if (payload?.kind !== "merge" || payload.authorization.ticketId !== ticket.id || payload.authorization.mandateId !== ticket.decisionId
      || !payload.authorization.allowed.includes("merge") || !payload.authorization.allowed.includes("issue-close")
      || payload.expected.method !== "PUT" || !payload.expected.path
      || payload.authorization.stopped || merge.source !== origin.source || merge.instance !== origin.instance
      || !same(authShape(input.closeRequest), authShape({ ...input.closeRequest, authorization: payload.authorization }))
      || payload.expected.path !== `/repos/${origin.repositoryId}/pulls/${this.pullNumber(input.pullThread, origin)}/merge`
      || payload.authorization.source !== origin.source || payload.authorization.instance !== origin.instance || String(payload.authorization.repositoryId) !== origin.repositoryId) throw new Error("merge operation 授权身份不匹配");
    const request = input.closeRequest;
    positive(request.preconditions.issueVersion, "continuation issueVersion");
    if (request.kind !== "issue-close" || request.source !== origin.source || request.instance !== origin.instance || String(request.repositoryId) !== origin.repositoryId
      || positive(request.object.issueNumber, "close issueNumber") !== origin.number || request.authorization.ticketId !== ticket.id || request.authorization.mandateId !== ticket.decisionId
      || request.authorization.source !== origin.source || request.authorization.instance !== origin.instance || String(request.authorization.repositoryId) !== origin.repositoryId) throw new Error("closeRequest 身份或 Issue 不匹配");
    if (request.authorization.stopped) throw new Error("closeRequest 不能来自 stopped 授权");
  }
}

export function closeMergedThread(settlement: GithubIssueSettlement, sources: EngineForSources, ref: ThreadRef, evidence: GithubMergeSettlementEvidence): GithubIssueContinuationView {
  return settlement.closeMergedThread(sources, ref, evidence);
}

export const githubIssueContinuationKey = recordKey;
