// SPDX-License-Identifier: MIT
// Native GitHub REST writes use durable ShadowOperations; no production registration.
import type { OperationAdapter, OperationContext } from "./operations.ts";
import type { GithubNativePayload } from "./github-native-plan.ts";
import type { GithubRestTransport, GithubRestResponse } from "./github-transport.ts";
import type { Operation, ShadowStore } from "./store.ts";

export interface GithubPrincipal { id: string; login: string }
export interface GithubNativeAdapterOptions {
  store: ShadowStore;
  writer: GithubRestTransport;
  reviewer: GithubRestTransport;
  writerIdentity: GithubPrincipal;
  reviewerIdentity: GithubPrincipal;
  requiredChecks: readonly string[];
  authorize: (operation: Operation) => void;
  /** GitHub Issue PATCH has no documented CAS. Strict profiles leave closure to a person or GitHub. */
  issueClose?: "best-effort";
  now?: () => number;
}
type Obj = Record<string, unknown>;
interface Attempt { revision: number; at: string; kind: string; principal: GithubPrincipal; head?: string; base?: string; issueUpdatedAt?: string; frontier?: number; externalFact?: Obj }
class Refused extends Error {}
const obj = (v: unknown): Obj => v && typeof v === "object" && !Array.isArray(v) ? v as Obj : {};
const sha = (v: unknown): v is string => typeof v === "string" && /^[0-9a-f]{40}$/i.test(v);
const ident = (v: unknown): string => String(v ?? "");
const equalLogin = (a: unknown, b: string): boolean => ident(a).toLowerCase() === b.toLowerCase();
const encodedRef = (v: string): string => v.split("/").map(encodeURIComponent).join("/");
const attemptKey = (op: Operation) => `github:rest:attempt:${JSON.stringify([op.id, op.revision])}`;
const eventFrontier = (rows: unknown[]): number => rows.reduce<number>((max, value) => Math.max(max, Number.isSafeInteger(obj(value).id) ? Number(obj(value).id) : 0), 0);
const eventState = (event: Obj): string => ident(event.event);
const stateFor = (event: unknown): string => ({ APPROVE: "APPROVED", REQUEST_CHANGES: "CHANGES_REQUESTED", COMMENT: "COMMENTED" })[ident(event)] ?? "";

/** No automatic write retries. Inspection only confirms positive, version-bound external facts. */
export class GithubNativeOperationAdapter implements OperationAdapter {
  private readonly options: GithubNativeAdapterOptions;
  private readonly now: () => number;
  constructor(options: GithubNativeAdapterOptions) {
    if (typeof options.authorize !== "function" || !Array.isArray(options.requiredChecks)
      || [options.writerIdentity, options.reviewerIdentity].some(p => !/^[1-9]\d*$/.test(p.id) || !p.login)
      || options.writerIdentity.id === options.reviewerIdentity.id || equalLogin(options.writerIdentity.login, options.reviewerIdentity.login)) throw new Error("GitHub 原生部署需要独立执行/审核身份和宿主授权");
    this.options = { ...options, writerIdentity: { ...options.writerIdentity }, reviewerIdentity: { ...options.reviewerIdentity }, requiredChecks: [...options.requiredChecks] };
    this.now = options.now ?? Date.now;
  }
  private payload(operation: Operation): GithubNativePayload {
    const p = operation.payload as GithubNativePayload;
    if (p?.mode !== "github-rest" || p.schemaVersion !== 1 || !p.repository || p.authorization?.source !== operation.source
      || p.authorization.instance !== operation.instance || ident(p.repository.id) !== p.authorization.repositoryId) throw new Refused("native-intent-required");
    const root = this.root(p), body = p.expected?.body;
    const suffix = p.kind === "branch" ? "/git/refs" : p.kind === "pull" ? "/pulls" : p.kind === "review" ? `/pulls/${p.object?.pullNumber}/reviews`
      : p.kind === "merge" ? `/pulls/${p.object?.pullNumber}/merge` : p.kind === "issue-close" ? `/issues/${p.object?.issueNumber}` : "";
    const method = p.kind === "merge" ? "PUT" : p.kind === "issue-close" ? "PATCH" : "POST";
    const keys = p.kind === "branch" ? ["ref", "sha"] : p.kind === "pull" ? ["title", "body", "head", "base"]
      : p.kind === "review" ? ["commit_id", "event", "body"] : p.kind === "merge" ? ["sha", "merge_method"] : ["state", "state_reason"];
    if (!suffix || p.expected.method !== method || p.expected.path !== root + suffix || !body
      || Object.keys(body).sort().join() !== keys.sort().join()) throw new Refused("native-wire-intent-mismatch");
    if (p.kind === "branch" && (body.ref !== `refs/heads/${p.object.branch ?? p.params.branch}` || !sha(body.sha))) throw new Refused("native-branch-invalid");
    if (p.kind === "pull" && (body.head !== p.params.headBranch || body.base !== p.params.baseBranch || !ident(body.body).endsWith(p.marker))) throw new Refused("native-pull-invalid");
    if (p.kind === "review" && (body.commit_id !== p.preconditions.headSha || !stateFor(body.event) || !ident(body.body).endsWith(p.marker))) throw new Refused("native-review-invalid");
    if (p.kind === "merge" && (body.sha !== p.preconditions.headSha || !["merge", "squash", "rebase"].includes(ident(body.merge_method)))) throw new Refused("native-merge-invalid");
    if (p.kind === "issue-close" && (body.state !== "closed" || body.state_reason !== "completed")) throw new Refused("native-close-invalid");
    return p;
  }
  private root(p: GithubNativePayload): string { return `/repos/${encodeURIComponent(p.repository.owner)}/${encodeURIComponent(p.repository.name)}`; }
  private transport(p: GithubNativePayload): GithubRestTransport { return p.kind === "review" || p.kind === "merge" ? this.options.reviewer : this.options.writer; }
  private principal(p: GithubNativePayload): GithubPrincipal { return p.kind === "review" || p.kind === "merge" ? this.options.reviewerIdentity : this.options.writerIdentity; }
  private async get(t: GithubRestTransport, path: string, context: OperationContext): Promise<Obj> {
    const r = await t.request("GET", path, undefined, { signal: context.signal });
    if (r.status !== 200 || !r.body || Array.isArray(r.body) || typeof r.body !== "object") throw new Refused("preflight-read-unavailable");
    return obj(r.body);
  }
  private async repository(t: GithubRestTransport, p: GithubNativePayload, context: OperationContext): Promise<void> {
    const row = await this.get(t, this.root(p), context);
    if (ident(row.id) !== ident(p.repository.id) || ident(row.full_name).toLowerCase() !== `${p.repository.owner}/${p.repository.name}`.toLowerCase()) throw new Refused("repository-mismatch");
  }
  private async identity(t: GithubRestTransport, principal: GithubPrincipal, context: OperationContext): Promise<void> {
    const row = await this.get(t, "/user", context);
    if (ident(row.id) !== principal.id || !equalLogin(row.login, principal.login)) throw new Refused("credential-principal-mismatch");
  }
  private pull(row: Obj, p: GithubNativePayload): void {
    const head = obj(row.head), base = obj(row.base);
    if (Number(row.number) !== p.object.pullNumber || ident(obj(head.repo).id) !== ident(p.repository.id)
      || ident(obj(base.repo).id) !== ident(p.repository.id) || ident(obj(row.user).id) !== this.options.writerIdentity.id) throw new Refused("pull-identity-mismatch");
  }
  private versions(row: Obj, p: GithubNativePayload): void {
    this.pull(row, p);
    if (row.state !== "open" || row.merged === true || obj(row.head).sha !== p.preconditions.headSha || obj(row.base).sha !== p.preconditions.baseSha) throw new Refused("pull-version-changed");
  }
  private local(operation: Operation, context: OperationContext): void {
    const store = this.options.store, row = store.operations.get(operation.source, operation.instance, operation.key), effect = store.effects.get(context.claim.kind, context.claim.key);
    if (!row || row.id !== operation.id || row.revision !== operation.revision || row.status !== "uncertain" || (row as Operation & { cancelRequested?: boolean }).cancelRequested
      || !effect || effect.status !== "running" || effect.seq !== context.claim.seq || effect.generation !== context.claim.generation
      || effect.claimedGeneration !== context.claim.generation || effect.claimToken !== context.claim.claimToken || effect.leaseOwner !== context.claim.leaseOwner
      || (effect.leaseUntil ?? 0) <= this.now() || context.signal.aborted) throw new Refused("operation-owner-invalid");
    this.options.authorize(operation);
  }
  private receipt(p: GithubNativePayload, fact: Obj): Obj {
    return { provider: "github", kind: p.kind, repositoryId: ident(p.repository.id), observedAt: new Date(this.now()).toISOString(), ...fact };
  }
  private async checks(t: GithubRestTransport, p: GithubNativePayload, context: OperationContext): Promise<void> {
    const root = this.root(p), head = ident(p.preconditions.headSha);
    const checks = await t.pages(`${root}/commits/${head}/check-runs?per_page=100&filter=all`, { signal: context.signal });
    const statuses = await t.pages(`${root}/commits/${head}/statuses?per_page=100`, { signal: context.signal });
    const latest = new Map<string, Obj>();
    for (const value of [...checks, ...statuses]) {
      const row = obj(value);
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || (row.context === undefined && row.head_sha !== head)) throw new Refused("check-identity-invalid");
      if (row.head_sha !== undefined && row.head_sha !== head) throw new Refused("check-head-mismatch");
      const key = row.context !== undefined ? `status:${ident(row.context)}` : `check:${ident(obj(row.app).id)}:${ident(row.name)}`;
      const prior = latest.get(key);
      // GitHub IDs grow within their endpoint; prefer the newest run/status, not the newest completion.
      if (!prior || Number(row.id) > Number(prior.id)) latest.set(key, row);
    }
    for (const name of this.options.requiredChecks) {
      const matching = [...latest.values()].filter(row => row.name === name || row.context === name);
      if (!matching.length || matching.some(row => row.context !== undefined ? row.state !== "success" : row.status !== "completed" || row.conclusion !== "success")) throw new Refused("required-check-not-successful");
    }
    const reviews = await t.pages(`${root}/pulls/${p.object.pullNumber}/reviews?per_page=100`, { signal: context.signal });
    const byActor = new Map<string, Obj>();
    for (const value of reviews) {
      const row = obj(value); if (!["APPROVED", "CHANGES_REQUESTED", "DISMISSED"].includes(ident(row.state))) continue;
      if (!Number.isSafeInteger(row.id) || Number(row.id) <= 0 || !/^[1-9]\d*$/.test(ident(obj(row.user).id))) throw new Refused("review-identity-invalid");
      const id = ident(obj(row.user).id), prior = byActor.get(id);
      if (!prior || Number(row.id) > Number(prior.id)) byActor.set(id, row);
    }
    const approval = byActor.get(this.options.reviewerIdentity.id);
    if (!approval || approval.state !== "APPROVED" || approval.commit_id !== head
      || [...byActor.values()].some(row => row.state === "CHANGES_REQUESTED")) throw new Refused("current-head-review-required");
  }
  private async preflight(t: GithubRestTransport, p: GithubNativePayload, context: OperationContext): Promise<Partial<Attempt>> {
    const root = this.root(p);
    await this.repository(t, p, context); await this.identity(t, this.principal(p), context);
    if (p.kind === "branch") {
      const existing = await t.request("GET", `${root}/git/ref/heads/${encodedRef(ident(p.object.branch ?? p.params.branch))}`, undefined, { signal: context.signal });
      if (existing.status !== 404) throw new Refused("branch-already-exists-or-unreadable");
      const commit = await this.get(t, `${root}/git/commits/${p.expected.body.sha}`, context);
      if (commit.sha !== p.expected.body.sha) throw new Refused("branch-base-invalid");
      return {};
    }
    if (p.kind === "pull") {
      const head = await this.get(t, `${root}/git/ref/heads/${encodedRef(ident(p.params.headBranch))}`, context);
      const base = await this.get(t, `${root}/git/ref/heads/${encodedRef(ident(p.params.baseBranch))}`, context);
      if (obj(head.object).sha !== p.preconditions.headSha || obj(base.object).sha !== p.preconditions.baseSha) throw new Refused("pull-branch-version-changed");
      const prior = await t.pages(`${root}/pulls?state=all&head=${encodeURIComponent(`${p.repository.owner}:${p.params.headBranch}`)}&base=${encodeURIComponent(ident(p.params.baseBranch))}&per_page=100`, { signal: context.signal });
      if (prior.length) throw new Refused("pull-for-branch-already-exists");
      return { head: ident(p.preconditions.headSha), base: ident(p.preconditions.baseSha) };
    }
    if (p.kind === "issue-close") {
      const merged = await this.get(t, `${root}/pulls/${p.params.pullNumber}`, context);
      const mergePayload = { ...p, object: { pullNumber: Number(p.params.pullNumber) } };
      this.pull(merged, mergePayload);
      if (merged.merged !== true || merged.merge_commit_sha !== p.params.mergeCommit) throw new Refused("merge-not-confirmed");
      const issue = await this.get(t, `${root}/issues/${p.object.issueNumber}`, context);
      const events = await t.pages(`${root}/issues/${p.object.issueNumber}/events?per_page=100`, { signal: context.signal });
      const lifecycle = events.map(obj).filter(event => ["closed", "reopened"].includes(eventState(event))).sort((a, b) => Number(a.id) - Number(b.id));
      const last = lifecycle.at(-1);
      // GitHub may close a linked Issue while merging. This is a positive external
      // fact, not a synthetic PATCH receipt, and works under the strict profile.
      if (!issue.pull_request && Number(issue.number) === p.object.issueNumber && issue.state === "closed" && last?.event === "closed"
        && last.commit_id === p.params.mergeCommit && Number.isSafeInteger(last.id) && Number(last.id) > Number(p.preconditions.issueEventFrontier)
        && [this.options.writerIdentity.id, this.options.reviewerIdentity.id].includes(ident(obj(last.actor).id))) {
        return { externalFact: this.receipt(p, { number: p.object.issueNumber, state: "closed", sha: p.params.mergeCommit, eventId: last.id,
          evidence: "linked-merge-close-event", writeIssued: false }) };
      }
      if (issue.pull_request || Number(issue.number) !== p.object.issueNumber || issue.state !== "open" || issue.updated_at !== p.preconditions.issueUpdatedAt
        || eventFrontier(events) !== p.preconditions.issueEventFrontier) throw new Refused("issue-observation-changed");
      if (this.options.issueClose !== "best-effort") throw new Refused("issue-close-needs-explicit-best-effort-profile");
      return { issueUpdatedAt: ident(issue.updated_at), frontier: eventFrontier(events) };
    }
    const pull = await this.get(t, `${root}/pulls/${p.object.pullNumber}`, context); this.versions(pull, p);
    if (p.kind === "merge") {
      await this.checks(t, p, context);
      this.versions(await this.get(t, `${root}/pulls/${p.object.pullNumber}`, context), p);
    }
    return { head: ident(p.preconditions.headSha), base: ident(p.preconditions.baseSha) };
  }
  private knownRefusal(r: GithubRestResponse): boolean {
    return [400, 401, 403, 404, 405, 409, 422].includes(r.status) && typeof obj(r.body).message === "string"
      && !r.headers["retry-after"] && r.headers["x-ratelimit-remaining"] !== "0" && !/rate.?limit|abuse/i.test(ident(obj(r.body).message));
  }
  private reviewMatches(row: Obj, p: GithubNativePayload): boolean {
    return row.commit_id === p.expected.body.commit_id && row.state === stateFor(p.expected.body.event)
      && row.body === p.expected.body.body && ident(obj(row.user).id) === this.options.reviewerIdentity.id && Number.isSafeInteger(row.id);
  }
  private createdPullMatches(row: Obj, p: GithubNativePayload): boolean {
    return ident(obj(row.user).id) === this.options.writerIdentity.id && Number.isSafeInteger(row.number) && Number(row.number) > 0 && Number.isSafeInteger(row.id)
      && ident(obj(obj(row.head).repo).id) === ident(p.repository.id) && ident(obj(obj(row.base).repo).id) === ident(p.repository.id)
      && obj(row.head).ref === p.params.headBranch && obj(row.base).ref === p.params.baseBranch && row.body === p.expected.body.body && row.title === p.expected.body.title;
  }
  async execute(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "failed"; receipt?: unknown }> {
    let issued = false;
    try {
      const p = this.payload(operation), t = this.transport(p); this.local(operation, context);
      const observed = await this.preflight(t, p, context);
      if (observed.externalFact) return { status: "confirmed", receipt: observed.externalFact };
      const result = await t.request(p.expected.method, p.expected.path, p.expected.body, { signal: context.signal, principal: this.principal(p), beforeSend: () => {
        this.options.store.atomic(() => {
          this.local(operation, context);
          const attempt: Attempt = { ...observed, revision: operation.revision, at: new Date(this.now()).toISOString(), kind: p.kind, principal: this.principal(p) };
          const key = attemptKey(operation);
          if (this.options.store.get(key)) throw new Refused("attempt-already-issued");
          this.options.store.set(key, attempt);
        });
        issued = true;
      } });
      if (this.knownRefusal(result)) return { status: "failed", receipt: this.receipt(p, { reason: "github-refused", status: result.status }) };
      const row = obj(result.body);
      if (p.kind === "branch" && result.status === 201 && row.ref === p.expected.body.ref && obj(row.object).sha === p.expected.body.sha) return { status: "confirmed", receipt: this.receipt(p, { ref: row.ref, sha: obj(row.object).sha }) };
      if (p.kind === "pull" && result.status === 201 && this.createdPullMatches(row, p) && obj(row.head).sha === p.preconditions.headSha && obj(row.base).sha === p.preconditions.baseSha) return { status: "confirmed", receipt: this.receipt(p, { number: row.number, objectId: row.id, headSha: obj(row.head).sha, baseSha: obj(row.base).sha, marker: p.marker }) };
      if (p.kind === "review" && result.status === 200 && this.reviewMatches(row, p)) {
        const current = await this.get(t, `${this.root(p)}/pulls/${p.object.pullNumber}`, context); this.pull(current, p);
        return { status: "confirmed", receipt: this.receipt(p, { reviewId: row.id, commitId: row.commit_id, state: row.state, marker: p.marker,
          stale: obj(current.head).sha !== p.preconditions.headSha || obj(current.base).sha !== p.preconditions.baseSha }) };
      }
      if (p.kind === "merge" && result.status === 200 && row.merged === true && sha(row.sha)) {
        const current = await this.get(t, `${this.root(p)}/pulls/${p.object.pullNumber}`, context); this.pull(current, p);
        if (current.merged === true && obj(current.head).sha === p.preconditions.headSha && current.merge_commit_sha === row.sha) return { status: "confirmed", receipt: this.receipt(p, { number: p.object.pullNumber, sha: row.sha, headSha: p.preconditions.headSha, baseSha: p.preconditions.baseSha }) };
      }
      if (p.kind === "issue-close" && result.status === 200 && row.state === "closed" && Number(row.number) === p.object.issueNumber && !row.pull_request) {
        const fact = await this.issueFact(t, p, operation, context);
        if (fact) return { status: "confirmed", receipt: fact };
      }
      throw new Error("GitHub native response not confirmed");
    } catch {
      if (!issued) return { status: "failed", receipt: { provider: "github", reason: "preflight-refused-or-unavailable", writeIssued: false } };
      throw new Error("GitHub 原生写入结果未知，必须只读对账");
    }
  }
  private async issueFact(t: GithubRestTransport, p: GithubNativePayload, op: Operation, context: OperationContext): Promise<Obj | undefined> {
    const attempt = this.options.store.get<Attempt>(attemptKey(op)); if (!attempt) return;
    const root = this.root(p), issue = await this.get(t, `${root}/issues/${p.object.issueNumber}`, context);
    const pull = await this.get(t, `${root}/pulls/${p.params.pullNumber}`, context);
    this.pull(pull, { ...p, object: { pullNumber: Number(p.params.pullNumber) } });
    if (issue.state !== "closed" || issue.pull_request || Number(issue.number) !== p.object.issueNumber || pull.merged !== true || pull.merge_commit_sha !== p.params.mergeCommit) return;
    const events = (await t.pages(`${root}/issues/${p.object.issueNumber}/events?per_page=100`, { signal: context.signal })).map(obj)
      .filter(event => Number(event.id) > (attempt.frontier ?? 0) && ["closed", "reopened"].includes(eventState(event))).sort((a, b) => Number(a.id) - Number(b.id));
    const last = events.at(-1);
    if (!last || last.event !== "closed" || ident(obj(last.actor).id) !== this.options.writerIdentity.id || !Number.isFinite(Date.parse(ident(last.created_at)))
      || Date.parse(ident(last.created_at)) + 1000 < Date.parse(attempt.at)) return;
    return this.receipt(p, { number: p.object.issueNumber, state: "closed", eventId: last.id, sha: p.params.mergeCommit,
      evidence: "post-observation-close-event", concurrency: "best-effort-no-platform-cas" });
  }
  async inspect(operation: Operation, context: OperationContext): Promise<{ status: "confirmed" | "not-applied" | "unknown"; receipt?: unknown }> {
    try {
      const p = this.payload(operation), t = this.transport(p), attempt = this.options.store.get<Attempt>(attemptKey(operation));
      if (!attempt) return { status: "unknown" };
      await this.repository(t, p, context);
      let fact: Obj | undefined;
      if (p.kind === "branch") {
        const row = await this.get(t, `${this.root(p)}/git/ref/heads/${encodedRef(ident(p.object.branch ?? p.params.branch))}`, context);
        if (row.ref === p.expected.body.ref && obj(row.object).sha === p.expected.body.sha) fact = this.receipt(p, { ref: row.ref, sha: obj(row.object).sha, evidence: "matching-ref-after-absent-observation" });
      } else if (p.kind === "pull") {
        const matches = (await t.pages(`${this.root(p)}/pulls?state=all&head=${encodeURIComponent(`${p.repository.owner}:${p.params.headBranch}`)}&base=${encodeURIComponent(ident(p.params.baseBranch))}&per_page=100`, { signal: context.signal })).map(obj).filter(row => this.createdPullMatches(row, p));
        if (matches.length === 1) fact = this.receipt(p, { number: matches[0]!.number, objectId: matches[0]!.id, marker: p.marker, evidence: "unique-authored-marker" });
      } else if (p.kind === "review") {
        const matches = (await t.pages(`${this.root(p)}/pulls/${p.object.pullNumber}/reviews?per_page=100`, { signal: context.signal })).map(obj).filter(row => this.reviewMatches(row, p));
        if (matches.length === 1) {
          const current = await this.get(t, `${this.root(p)}/pulls/${p.object.pullNumber}`, context); this.pull(current, p);
          fact = this.receipt(p, { reviewId: matches[0]!.id, commitId: matches[0]!.commit_id, marker: p.marker, state: matches[0]!.state,
            stale: obj(current.head).sha !== p.preconditions.headSha || obj(current.base).sha !== p.preconditions.baseSha });
        }
      } else if (p.kind === "merge") {
        const row = await this.get(t, `${this.root(p)}/pulls/${p.object.pullNumber}`, context); this.pull(row, p);
        if (row.merged === true && sha(row.merge_commit_sha) && obj(row.head).sha === p.preconditions.headSha
          && Number.isFinite(Date.parse(ident(row.merged_at))) && Date.parse(ident(row.merged_at)) + 1000 >= Date.parse(attempt.at)) fact = this.receipt(p, { number: p.object.pullNumber, sha: row.merge_commit_sha, headSha: p.preconditions.headSha, baseSha: attempt.base, evidence: "merged-target-head" });
      } else fact = await this.issueFact(t, p, operation, context);
      return fact ? { status: "confirmed", receipt: fact } : { status: "unknown" };
    } catch { return { status: "unknown" }; }
  }
}
