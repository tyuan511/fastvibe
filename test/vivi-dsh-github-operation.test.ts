import assert from "node:assert/strict";
import test from "node:test";
import { GithubOperationDryRun, type GithubAuthorization, type GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

const config = { repository: { id: 11, owner: "acme", name: "widget", fullName: "acme/widget" }, selfLogins: ["fastvibe[bot]"] };
const auth: GithubAuthorization = { source: "github", instance: "desktop", repositoryId: "11", ticketId: "ticket-1", mandateId: "mandate-1", generation: 3, allowed: ["branch", "pull", "review", "merge", "issue-close"] };
function fixture(t: test.TestContext) {
  const store = openShadowStore(":memory:"); const registry = new ShadowSourceRegistry(store); const unregister = registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config }); t.after(() => { unregister(); store.close(); });
  return { store, registry, planner: new GithubOperationDryRun(store, registry, "github", "desktop") };
}
function request(kind: GithubOperationRequest["kind"], patch: Partial<GithubOperationRequest> = {}): GithubOperationRequest {
  return { kind, source: "github", instance: "desktop", repositoryId: 11, object: kind === "branch" ? { branch: "fix/one" } : kind === "issue-close" ? { issueNumber: 7 } : { pullNumber: 8 }, params: {}, authorization: auth,
    preconditions: { currentState: "open", headSha: "a".repeat(40), baseSha: "b".repeat(40), requiredChecks: ["test"], checks: { test: "success" } }, ...patch };
}

test("plans branch, PR, review, merge and Issue close with explicit expected requests", t => {
  const { planner, store } = fixture(t);
  const branch = planner.plan(request("branch", { params: { branch: "fix/one", baseSha: "a".repeat(40) } }));
  assert.equal(branch.status, "planned"); assert.equal(branch.payload.mode, "dry-run"); assert.deepEqual(branch.payload.expected, { method: "POST", path: "/repositories/11/git/refs", body: { ref: "refs/heads/fix/one", sha: "a".repeat(40) } });
  const pull = planner.plan(request("pull", { object: {}, params: { headBranch: "fix/one", baseBranch: "main", title: "Fix bug", body: "details" } }));
  assert.deepEqual(pull.payload.expected.body, { title: "Fix bug", body: "details", head: "fix/one", base: "main" });
  const review = planner.plan(request("review", { params: { commitSha: "c".repeat(40), event: "REQUEST_CHANGES", body: "Please fix" } }));
  assert.equal(review.payload.expected.path, "/repos/11/pulls/8/reviews");
  const merge = planner.plan(request("merge", { params: { method: "squash" } }));
  assert.deepEqual(merge.payload.expected.body, { sha: "a".repeat(40), base: "b".repeat(40), merge_method: "squash" });
  const close = planner.plan(request("issue-close", { params: { mergeCommit: "d".repeat(40) } }));
  assert.deepEqual(close.payload.expected.body, { state: "closed", mergeCommit: "d".repeat(40) });
  assert.equal(store.db.countRows("dsh_effects"), 0); assert.equal(store.db.countRows("dsh_operations"), 5);
});

test("operation identity is idempotent and rejects parameter drift", t => {
  const { planner } = fixture(t); const first = planner.plan(request("merge", { params: { method: "squash" } }));
  const replay = planner.plan(request("merge", { params: { method: "squash" } })); assert.deepEqual(replay, first);
  assert.throws(() => planner.plan(request("merge", { params: { method: "rebase" } })), /意图已变化/);
  assert.equal(planner.get("merge", 11, { pullNumber: 8 })?.id, first.id);
});

test("authorization, Stop, state, head/base and checks are validated before persistence", t => {
  const { planner, store } = fixture(t);
  assert.throws(() => planner.plan(request("merge", { authorization: { ...auth, allowed: ["review"] } })), /不允许/);
  assert.throws(() => planner.plan(request("merge", { authorization: { ...auth, stopped: true } })), /Stop/);
  assert.throws(() => planner.plan(request("merge", { preconditions: { ...request("merge").preconditions, currentState: "closed" } })), /不是 open/);
  assert.throws(() => planner.plan(request("merge", { preconditions: { ...request("merge").preconditions, headSha: "1" } })), /Git SHA/);
  assert.throws(() => planner.plan(request("merge", { preconditions: { ...request("merge").preconditions, checks: { test: "failure" } } })), /required check/);
  assert.throws(() => planner.plan(request("branch", { object: {}, params: { branch: "../escape", baseSha: "a".repeat(40) } })), /branch/);
  assert.throws(() => planner.plan(request("review", { params: { commitSha: "c".repeat(40), event: "APPROVE", token: "secret" } })), /凭据/);
  assert.equal(store.db.countRows("dsh_operations"), 0);
});

test("uncertain, unknown, confirmed and not-applied reconciliation are explicit", t => {
  const { planner } = fixture(t); const plan = planner.plan(request("review", { params: { commitSha: "c".repeat(40), event: "COMMENT", body: "review" } }));
  const unknown = planner.simulateExecute(plan, { status: "uncertain", reason: "simulated timeout" }); assert.equal(unknown.status, "uncertain");
  assert.equal(planner.reconcile(plan, "unknown").status, "uncertain");
  const confirmed = planner.reconcile(plan, "confirmed", { fakeServer: "would-confirm" }); assert.equal(confirmed.status, "confirmed");
  assert.throws(() => planner.reconcile(plan, "not-applied"), /uncertain/);
  assert.throws(() => planner.simulateExecute(plan, { status: "confirmed" }), /generation\/revision/);
});

test("Stop cancellation is durable and dry-run never creates HTTP or execution effects", t => {
  const { planner, store } = fixture(t); const plan = planner.plan(request("issue-close", { params: { mergeCommit: "d".repeat(40) } }));
  const cancelled = planner.cancel(plan, "ticket stopped"); assert.equal(cancelled.status, "cancelled"); assert.equal(planner.get("issue-close", 11, { issueNumber: 7 })?.status, "cancelled");
  assert.equal(store.db.countRows("dsh_effects"), 0); assert.equal(store.db.countRows("dsh_session_receipts"), 0);
});
