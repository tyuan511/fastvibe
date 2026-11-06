// SPDX-License-Identifier: MIT
// M10 GitHub Source Operation dry-run. It creates immutable plans and receipts only.
import { createHash } from "node:crypto";
import type { ShadowSourceInstance, ShadowSourceRegistry } from "./source-registry.ts";
import type { Operation, ShadowStore } from "./store.ts";

export type GithubOperationKind = "branch" | "pull" | "review" | "merge" | "issue-close";
export type GithubEvidence = "confirmed" | "not-applied" | "unknown";

export interface GithubAuthorization {
  source: string;
  instance: string;
  repositoryId: string;
  ticketId: string;
  mandateId: string;
  generation: number;
  allowed: readonly GithubOperationKind[];
  stopped?: boolean;
}
export interface GithubOperationRequest {
  kind: GithubOperationKind;
  source: string;
  instance: string;
  repositoryId: string | number;
  object: { issueNumber?: number; pullNumber?: number; branch?: string };
  params: Record<string, unknown>;
  authorization: GithubAuthorization
  preconditions: {
    headSha?: string;
    baseSha?: string;
    currentState?: "open" | "closed" | "merged";
    requiredChecks?: readonly string[];
    checks?: Readonly<Record<string, "success" | "failure" | "pending">>;
    approvedBy?: readonly string[];
  };
}
export interface GithubOperationPlan extends Operation {
  payload: GithubOperationPayload;
}
export interface GithubOperationPayload {
  mode: "dry-run";
  kind: GithubOperationKind;
  params: Record<string, unknown>;
  paramsHash: string;
  idempotencyKey: string;
  authorization: GithubAuthorization
  preconditions: GithubOperationRequest["preconditions"];
  expected: { method: string; path: string; body: Record<string, unknown> };
}
export interface GithubOperationReceipt {
  mode: "dry-run";
  operationId: string;
  idempotencyKey: string;
  status: "confirmed" | "failed" | "cancelled" | "uncertain";
  evidence?: GithubEvidence;
  reason?: string;
  request: GithubOperationPayload["expected"];
}

const secretField = /token|secret|password|authorization|private.?key|api.?key|credential/i;
const json = (value: unknown): string => JSON.stringify(value, Object.keys(value as object ?? {}).sort());
const digest = (value: unknown): string => createHash("sha256").update(JSON.stringify(value, (_key, item) => item && typeof item === "object" && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest("hex");
function safe(value: unknown, path = "payload"): void {
  if (Array.isArray(value)) { value.forEach((item, index) => safe(item, `${path}[${index}]`)); return; }
  if (!value || typeof value !== "object") return;
  for (const [key, child] of Object.entries(value)) {
    if (secretField.test(key)) throw new Error(`GitHub dry-run 禁止凭据字段: ${path}.${key}`);
    safe(child, `${path}.${key}`);
  }
}
function integer(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} 必须是正整数`);
  return Number(value);
}
function branch(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9._/-]{0,127}$/.test(value) || value.includes("..") || value.endsWith("/")) throw new Error("GitHub branch 名称无效");
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[0-9a-f]{7,64}$/i.test(value)) throw new Error(`${label} 必须是 Git SHA`);
  return value.toLowerCase();
}
function repository(instance: ShadowSourceInstance | undefined, expected: string): void {
  if (!instance || !instance.enabled || instance.status !== "enabled") throw new Error("GitHub Source 未启用");
  const configured = String((instance.config.repository as Record<string, unknown> | undefined)?.id ?? "");
  if (configured !== expected) throw new Error("GitHub operation 仓库身份不匹配");
}
function checksPass(preconditions: GithubOperationRequest["preconditions"]): void {
  for (const name of preconditions.requiredChecks ?? []) if (preconditions.checks?.[name] !== "success") throw new Error(`required check 未通过: ${name}`);
}
function expectedRequest(request: GithubOperationRequest): GithubOperationPayload["expected"] {
  const repo = encodeURIComponent(String(request.repositoryId));
  switch (request.kind) {
    case "branch": {
      const name = branch(request.object.branch ?? request.params.branch); const baseSha = sha(request.params.baseSha ?? request.preconditions.baseSha, "baseSha");
      return { method: "POST", path: `/repositories/${repo}/git/refs`, body: { ref: `refs/heads/${name}`, sha: baseSha } };
    }
    case "pull": {
      const head = branch(request.params.headBranch); const base = branch(request.params.baseBranch);
      if (request.params.title === undefined || typeof request.params.title !== "string" || !request.params.title.trim()) throw new Error("PR title 必填");
      return { method: "POST", path: `/repos/${repo}/pulls`, body: { title: request.params.title, body: request.params.body ?? "", head, base } };
    }
    case "review": {
      const number = integer(request.object.pullNumber, "pullNumber"); const commit = sha(request.params.commitSha ?? request.preconditions.headSha, "review commitSha");
      if (!request.params.event || !["APPROVE", "REQUEST_CHANGES", "COMMENT"].includes(String(request.params.event))) throw new Error("Review event 无效");
      return { method: "POST", path: `/repos/${repo}/pulls/${number}/reviews`, body: { commit_id: commit, event: request.params.event, body: request.params.body ?? "" } };
    }
    case "merge": {
      const number = integer(request.object.pullNumber, "pullNumber"); const head = sha(request.preconditions.headSha, "headSha"); const base = sha(request.preconditions.baseSha, "baseSha");
      if (request.preconditions.currentState !== "open") throw new Error("PR 当前状态不是 open"); checksPass(request.preconditions);
      const method = String(request.params.method ?? "squash"); if (!["merge", "squash", "rebase"].includes(method)) throw new Error("merge method 无效");
      return { method: "PUT", path: `/repos/${repo}/pulls/${number}/merge`, body: { sha: head, base, merge_method: method } };
    }
    case "issue-close": {
      const number = integer(request.object.issueNumber, "issueNumber");
      if (request.preconditions.currentState !== "open") throw new Error("Issue 当前状态不是 open");
      if (typeof request.params.mergeCommit !== "string" || !request.params.mergeCommit) throw new Error("Issue close 必须关联 mergeCommit");
      return { method: "PATCH", path: `/repos/${repo}/issues/${number}`, body: { state: "closed", mergeCommit: request.params.mergeCommit } };
    }
  }
}
function validate(request: GithubOperationRequest, registry: ShadowSourceRegistry): GithubOperationPayload["expected"] {
  safe(request.params); safe(request.preconditions); safe(request.authorization);
  if (request.source !== request.authorization.source || request.instance !== request.authorization.instance) throw new Error("GitHub authorization Source 身份不匹配");
  repository(registry.instance(request.source), String(request.repositoryId));
  if (request.authorization.repositoryId !== String(request.repositoryId)) throw new Error("GitHub authorization 仓库不匹配");
  if (request.authorization.stopped) throw new Error("GitHub operation 已被 Stop 撤回");
  if (!request.authorization.allowed.includes(request.kind)) throw new Error(`Mandate 不允许 ${request.kind}`);
  if (!Number.isSafeInteger(request.authorization.generation) || request.authorization.generation < 0) throw new Error("generation 无效");
  return expectedRequest(request);
}

/**
 * M10 planner. It never calls a transport. `simulate*` methods are explicit evidence
 * controls used by fake-server tests and do not represent a real GitHub receipt.
 */
export class GithubOperationDryRun {
  private readonly store: ShadowStore;
  private readonly registry: ShadowSourceRegistry;
  private readonly source: string;
  private readonly instance: string;
  constructor(store: ShadowStore, registry: ShadowSourceRegistry, source = "github", instance = source) {
    this.store = store; this.registry = registry; this.source = source; this.instance = instance;
  }
  plan(request: GithubOperationRequest): GithubOperationPlan {
    if (request.source !== this.source || request.instance !== this.instance) throw new Error("GitHub planner Source 身份不匹配");
    const expected = validate(request, this.registry); const paramsHash = digest({ kind: request.kind, object: request.object, params: request.params, preconditions: request.preconditions });
    const idempotencyKey = `github-dry:${request.source}:${request.instance}:${request.repositoryId}:${request.kind}:${digest({ object: request.object, paramsHash }).slice(0, 24)}`;
    const key = `github:${request.kind}:${request.repositoryId}:${digest(request.object).slice(0, 24)}`;
    const payload: GithubOperationPayload = { mode: "dry-run", kind: request.kind, params: structuredClone(request.params), paramsHash, idempotencyKey,
      authorization: structuredClone(request.authorization), preconditions: structuredClone(request.preconditions), expected };
    const operation = this.store.operations.plan({ id: idempotencyKey, source: request.source, instance: request.instance, key, payload });
    return { ...operation, payload: operation.payload as GithubOperationPayload };
  }
  get(kind: GithubOperationKind, repositoryId: string | number, object: Record<string, unknown>): GithubOperationPlan | undefined {
    const key = `github:${kind}:${repositoryId}:${digest(object).slice(0, 24)}`; const operation = this.store.operations.get(this.source, this.instance, key);
    return operation ? { ...operation, payload: operation.payload as GithubOperationPayload } : undefined;
  }
  simulateExecute(plan: GithubOperationPlan, result: { status: "confirmed" | "failed" | "uncertain"; receipt?: unknown; reason?: string }): GithubOperationReceipt {
    const current = this.store.operations.get(plan.source, plan.instance, plan.key);
    if (!current || current.id !== plan.id || current.revision !== plan.revision || current.status !== "planned") throw new Error("operation generation/revision 已失效");
    if (result.status === "uncertain") {
      if (!this.store.operations.transition(current, "uncertain", { mode: "dry-run", reason: result.reason ?? "simulated timeout" })) throw new Error("uncertain CAS 失败");
    } else if (!this.store.operations.transition(current, result.status, { mode: "dry-run", receipt: result.receipt, reason: result.reason })) throw new Error("operation settlement CAS 失败");
    return this.receipt(plan, result.status, result.reason, result.receipt);
  }
  reconcile(plan: GithubOperationPlan, evidence: GithubEvidence, receipt?: unknown): GithubOperationReceipt {
    const current = this.store.operations.get(plan.source, plan.instance, plan.key);
    if (!current || current.id !== plan.id || current.status !== "uncertain") throw new Error("只有当前 uncertain operation 可以对账");
    if (evidence === "unknown") return this.receipt({ ...plan, ...current, payload: current.payload as GithubOperationPayload }, "uncertain", "仍未知");
    const next = evidence === "confirmed" ? "confirmed" : "failed";
    if (!this.store.operations.transition(current, next, { mode: "dry-run", evidence, receipt })) throw new Error("reconcile CAS 失败");
    return this.receipt({ ...plan, ...current, payload: current.payload as GithubOperationPayload }, next, undefined, receipt);
  }
  cancel(plan: GithubOperationPlan, reason = "stop"): GithubOperationReceipt {
    const current = this.store.operations.get(plan.source, plan.instance, plan.key);
    if (!current || current.id !== plan.id || ["confirmed", "cancelled"].includes(current.status)) throw new Error("operation 不可取消");
    if (!this.store.operations.transition(current, "cancelled", { mode: "dry-run", reason })) throw new Error("cancel CAS 失败");
    return this.receipt({ ...plan, ...current, payload: current.payload as GithubOperationPayload }, "cancelled", reason);
  }
  private receipt(plan: GithubOperationPlan, status: GithubOperationReceipt["status"], reason?: string, receipt?: unknown): GithubOperationReceipt {
    return { mode: "dry-run", operationId: plan.id, idempotencyKey: plan.payload.idempotencyKey, status, ...(reason ? { reason } : {}), ...(receipt === undefined ? {} : { evidence: status === "uncertain" ? "unknown" : "confirmed", receipt }), request: plan.payload.expected } as GithubOperationReceipt;
  }
}

export const githubOperationParamsHash = (request: Pick<GithubOperationRequest, "kind" | "object" | "params" | "preconditions">): string => digest(request);
export const githubOperationJson = (value: unknown): string => json(value);
