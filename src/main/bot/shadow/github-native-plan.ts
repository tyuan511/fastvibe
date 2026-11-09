// SPDX-License-Identifier: MIT
// Native REST intents only. The host owns authorization revalidation and execution.
import { createHash } from "node:crypto";
import { validateGithubOperationRequest, type GithubOperationPayload, type GithubOperationPlan, type GithubOperationRequest } from "./github-operation.ts";
import type { GithubRepository } from "./github-source.ts";
import type { ShadowSourceRegistry } from "./source-registry.ts";
import type { Operation, ShadowStore } from "./store.ts";

export interface GithubNativePayload extends GithubOperationPayload {
  kind: Exclude<GithubOperationRequest["kind"], "commit" | "push">;
  mode: "github-rest";
  schemaVersion: 1;
  repository: GithubRepository;
  object: GithubOperationRequest["object"];
  marker: string;
}

// Canonical JSON is also the stored form, so property insertion order cannot cause drift.
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") return `{${Object.entries(value).filter(([, v]) => v !== undefined).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  if (value === undefined || typeof value === "function" || typeof value === "symbol" || typeof value === "bigint" || (typeof value === "number" && !Number.isFinite(value))) throw new Error("GitHub intent 必须是有效 JSON");
  return JSON.stringify(value);
}
const digest = (value: unknown): string => createHash("sha256").update(canonical(value)).digest("hex");
function text(value: unknown, label: string): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${label} 必须非空`);
  return value;
}
function sha(value: unknown, label: string): string {
  if (typeof value !== "string" || !/^[a-f0-9]{40}$/i.test(value)) throw new Error(`${label} 必须是完整 40 位 SHA`);
  return value.toLowerCase();
}
function positive(value: unknown, label: string): number {
  if (!Number.isSafeInteger(value) || Number(value) <= 0) throw new Error(`${label} 必须是正整数`);
  return Number(value);
}
function branch(value: unknown): string {
  const name = text(value, "branch");
  if (name === "@" || name.startsWith("refs/") || /[\x00-\x20\x7f~^:?*\[\\]/.test(name) || name.includes("..") || name.includes("@{")
    || name.endsWith(".") || name.split("/").some(part => !part || part.startsWith(".") || part.endsWith(".lock"))) throw new Error("GitHub branch ref 无效");
  return name;
}
function body(value: unknown): string {
  if (value === undefined) return "";
  if (typeof value !== "string") throw new Error("GitHub body 必须是字符串");
  return value;
}
function issueSnapshot(preconditions: GithubOperationRequest["preconditions"]): void {
  const at = preconditions.issueUpdatedAt;
  if (typeof at !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(at) || !Number.isFinite(Date.parse(at))
    || new Date(at).toISOString().replace(/\.000Z$/, "Z") !== at.replace(/\.(\d{1,3})Z$/, (_, fraction: string) => `.${fraction.padEnd(3, "0")}Z`).replace(/\.000Z$/, "Z")) throw new Error("issueUpdatedAt 必须是有效 ISO 时间");
  if (!Number.isSafeInteger(preconditions.issueEventFrontier) || Number(preconditions.issueEventFrontier) < 0) throw new Error("issueEventFrontier 必须是非负整数");
}

export class GithubNativePlanner {
  private readonly store: ShadowStore;
  private readonly registry: ShadowSourceRegistry;
  private readonly source: string;
  private readonly instance: string;
  constructor(store: ShadowStore, registry: ShadowSourceRegistry, source = "github", instance = source, _now: () => number = Date.now) {
    this.store = store; this.registry = registry; this.source = source; this.instance = instance;
  }
  buildIntent(request: GithubOperationRequest): Omit<Operation, "status" | "revision"> {
    if (request.source !== this.source || request.instance !== this.instance) throw new Error("GitHub planner Source 身份不匹配");
    const installed = this.registry.instance(this.source);
    if (!installed || installed.kind !== this.source || !this.registry.kind(this.source)) throw new Error("GitHub Source kind 未安装");
    validateGithubOperationRequest(request, this.registry);
    const configured = installed.config.repository as GithubRepository;
    const repository: GithubRepository = { id: String(configured.id), owner: configured.owner, name: configured.name };
    if (configured.fullName !== undefined) repository.fullName = configured.fullName;
    text(request.authorization.ticketId, "ticketId"); text(request.authorization.mandateId, "mandateId");
    const prefix = `/repos/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.name)}`;
    const params = request.params; const pre = request.preconditions;
    let target: unknown; let expected: GithubOperationPayload["expected"];
    switch (request.kind) {
      case "commit": case "push": throw new Error("Git commit/push 必须使用受管 Git planner");
      case "branch": {
        const name = branch(request.object.branch ?? params.branch);
        if (params.branch !== undefined && params.branch !== name) throw new Error("branch 目标不一致");
        if (params.force || params.overwrite) throw new Error("branch 不允许 overwrite existing ref");
        const base = sha(params.baseSha ?? pre.baseSha, "baseSha");
        if (pre.baseSha !== undefined && sha(pre.baseSha, "baseSha") !== base) throw new Error("branch baseSha 不一致");
        target = [name]; expected = { method: "POST", path: `${prefix}/git/refs`, body: { ref: `refs/heads/${name}`, sha: base } }; break;
      }
      case "pull": {
        const head = branch(params.headBranch); const base = branch(params.baseBranch);
        sha(pre.headSha, "headSha"); sha(pre.baseSha, "baseSha");
        target = [head]; expected = { method: "POST", path: `${prefix}/pulls`, body: { title: text(params.title, "title"), body: body(params.body), head, base } }; break;
      }
      case "review": {
        const number = positive(request.object.pullNumber, "pullNumber"); const head = sha(pre.headSha, "headSha"); const base = sha(pre.baseSha, "baseSha");
        if (sha(params.commitSha ?? pre.headSha, "commitSha") !== head) throw new Error("review commitSha 必须匹配 headSha");
        target = [number, head, base, text(params.artifactId, "artifactId")];
        expected = { method: "POST", path: `${prefix}/pulls/${number}/reviews`, body: { commit_id: head, event: params.event, body: body(params.body) } }; break;
      }
      case "merge": {
        const number = positive(request.object.pullNumber, "pullNumber"); const head = sha(pre.headSha, "headSha"); const base = sha(pre.baseSha, "baseSha");
        target = [number, head, base]; expected = { method: "PUT", path: `${prefix}/pulls/${number}/merge`, body: { sha: head, merge_method: params.method ?? "squash" } }; break;
      }
      case "issue-close": {
        const number = positive(request.object.issueNumber, "issueNumber"); const commit = sha(params.mergeCommit, "mergeCommit");
        positive(params.pullNumber, "pullNumber"); issueSnapshot(pre);
        target = [number, commit]; expected = { method: "PATCH", path: `${prefix}/issues/${number}`, body: { state: "closed", state_reason: "completed" } }; break;
      }
    }
    const identity = [request.source, request.instance, String(repository.id), request.authorization.ticketId, request.kind, target];
    const identityHash = digest(identity); const key = `github-rest:${request.kind}:${identityHash}`;
    const marker = `<!-- fastvibe:github-rest:${identityHash} -->`;
    if (request.kind === "pull" || request.kind === "review") expected.body.body = `${expected.body.body}\n\n${marker}`;
    const paramsHash = digest({ kind: request.kind, object: request.object, params, preconditions: pre });
    const payload: GithubNativePayload = { mode: "github-rest", schemaVersion: 1, repository, object: request.object, marker,
      kind: request.kind, params, paramsHash, idempotencyKey: key, authorization: request.authorization, preconditions: pre, expected };
    return JSON.parse(canonical({ id: key, source: request.source, instance: request.instance, key, payload })) as Omit<Operation, "status" | "revision">;
  }
  plan(request: GithubOperationRequest): GithubOperationPlan {
    return this.store.operations.plan(this.buildIntent(request)) as GithubOperationPlan;
  }
}
