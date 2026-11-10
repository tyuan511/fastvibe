import assert from "node:assert/strict";
import test from "node:test";
import { GithubNativePlanner, type GithubNativePayload } from "../src/main/bot/shadow/github-native-plan.ts";
import type { GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

const head = "a".repeat(40); const base = "b".repeat(40); const merged = "c".repeat(40);
const config = { repository: { id: 11, owner: "acme", name: "widget" } };
function fixture(t: test.TestContext) {
  const store = openShadowStore(":memory:"); const registry = new ShadowSourceRegistry(store);
  const unregister = registerGithubShadowSource(registry); registry.configure("github", { enabled: true, config });
  t.after(() => { unregister(); store.close(); });
  return { store, registry, unregister, planner: new GithubNativePlanner(store, registry, "github", "desktop", () => { throw new Error("clock must not be read"); }) };
}
function request(kind: GithubOperationRequest["kind"]): GithubOperationRequest {
  return { kind, source: "github", instance: "desktop", repositoryId: 11,
    object: kind === "branch" ? { branch: "fix/one" } : kind === "issue-close" ? { issueNumber: 7 } : kind === "pull" ? {} : { pullNumber: 8 },
    authorization: { source: "github", instance: "desktop", repositoryId: "11", ticketId: "ticket-1", mandateId: "decision-1", generation: 1,
      assignmentId: "assignment-1", bindingClaim: 2, allowed: ["branch", "pull", "review", "merge", "issue-close"] },
    params: kind === "branch" ? { baseSha: base } : kind === "pull" ? { title: "Fix", body: "Details", headBranch: "fix/one", baseBranch: "main" }
      : kind === "review" ? { artifactId: "artifact-1", commitSha: head, event: "APPROVE", body: "Reviewed" }
      : kind === "merge" ? { method: "squash" } : { mergeCommit: merged, pullNumber: 8 },
    preconditions: { headSha: head, baseSha: base, currentState: "open", issueUpdatedAt: "2026-01-01T00:00:00Z", issueEventFrontier: 0 } };
}
function payload(planner: GithubNativePlanner, req: GithubOperationRequest): GithubNativePayload {
  return planner.plan(req).payload as GithubNativePayload;
}

test("native REST methods, trusted repository paths and exact body allowlists", t => {
  const { planner, store } = fixture(t);
  const branch = payload(planner, request("branch"));
  assert.deepEqual(branch.expected, { method: "POST", path: "/repos/acme/widget/git/refs", body: { ref: "refs/heads/fix/one", sha: base } });
  const pullRequest = request("pull"); pullRequest.params.owner = "attacker"; pullRequest.params.role = "admin";
  const pull = payload(planner, pullRequest);
  assert.deepEqual(pull.expected, { method: "POST", path: "/repos/acme/widget/pulls", body: { title: "Fix", body: `Details\n\n${pull.marker}`, head: "fix/one", base: "main" } });
  assert.deepEqual(pull.repository, { id: "11", owner: "acme", name: "widget", fullName: "acme/widget" });
  const review = payload(planner, request("review"));
  assert.deepEqual(review.expected, { method: "POST", path: "/repos/acme/widget/pulls/8/reviews", body: { commit_id: head, event: "APPROVE", body: `Reviewed\n\n${review.marker}` } });
  const merge = payload(planner, request("merge"));
  assert.deepEqual(merge.expected, { method: "PUT", path: "/repos/acme/widget/pulls/8/merge", body: { sha: head, merge_method: "squash" } });
  const closeRequest = request("issue-close"); closeRequest.preconditions.issueVersion = 3;
  const close = payload(planner, closeRequest);
  assert.deepEqual(close.expected, { method: "PATCH", path: "/repos/acme/widget/issues/7", body: { state: "closed", state_reason: "completed" } });
  assert.equal(close.preconditions.issueUpdatedAt, "2026-01-01T00:00:00Z"); assert.equal(close.preconditions.issueEventFrontier, 0);
  assert.equal(close.mode, "github-rest"); assert.equal(close.schemaVersion, 1);
  for (const planned of [branch, pull, review, merge, close]) {
    assert.deepEqual(planned.authorization, request("merge").authorization);
    assert.equal(JSON.stringify(planned.expected).includes("assignment"), false);
    assert.equal(JSON.stringify(planned.expected).includes("bindingClaim"), false);
    assert.equal("plannedAt" in planned, false);
  }
  assert.equal(store.db.countRows("vivi_operations"), 5); assert.equal(store.db.countRows("vivi_effects"), 0);
});

test("native intents preserve independently installed Source and instance namespaces", t => {
  const { store, registry, planner } = fixture(t); const unregister = registerGithubShadowSource(registry, "github-other");
  t.after(unregister); registry.configure("github-other", { enabled: true, config });
  const original = planner.plan(request("review"));
  const req = request("review"); req.source = "github-other"; req.instance = "separate";
  req.authorization = { ...req.authorization, source: req.source, instance: req.instance };
  const second = new GithubNativePlanner(store, registry, req.source, req.instance).plan(req);
  assert.notEqual(second.key, original.key); assert.equal(second.source, "github-other");
  assert.equal((second.payload as GithubNativePayload).expected.path, "/repos/acme/widget/pulls/8/reviews");
  assert.equal(store.db.countRows("vivi_operations"), 2);
});

test("buildIntent is pure and deterministic, isolated from caller mutation and insertion order", t => {
  const { planner, store } = fixture(t); const req = request("pull"); const first = planner.buildIntent(req);
  assert.deepEqual(planner.buildIntent(req), first); assert.equal(store.db.countRows("vivi_operations"), 0);
  const reordered = { ...req, params: Object.fromEntries(Object.entries(req.params).reverse()) };
  assert.deepEqual(planner.buildIntent(reordered), first);
  const planned = planner.plan(req); assert.deepEqual(planner.plan(reordered), planned);
  req.params.title = "Changed"; assert.equal((first.payload as GithubNativePayload).params.title, "Fix");
  assert.throws(() => planner.plan(req), /意图已变化/);
});

for (const kind of ["branch", "pull", "review", "merge", "issue-close"] as const) {
  test(`${kind}: same target is idempotent, parameter drift rejected and new Ticket independent`, t => {
    const { planner } = fixture(t); const req = request(kind); const first = planner.plan(req);
    assert.deepEqual(planner.plan(req), first);
    const changed = structuredClone(req); changed.params.note = "different";
    assert.equal(planner.buildIntent(changed).key, first.key);
    assert.throws(() => planner.plan(changed), /意图已变化/);
    const next = structuredClone(req); next.authorization.ticketId = "ticket-2";
    assert.notEqual(planner.plan(next).id, first.id);
  });
}

test("review identities bind head/base and artifact; body drift keeps identity", t => {
  const { planner } = fixture(t); const req = request("review"); const first = planner.plan(req);
  const bodyDrift = structuredClone(req); bodyDrift.params.body = "Different verdict";
  assert.throws(() => planner.plan(bodyDrift), /意图已变化/);
  for (const dimension of ["head", "base", "artifact"] as const) {
    const next = structuredClone(req);
    if (dimension === "head") { next.preconditions.headSha = "d".repeat(40); next.params.commitSha = next.preconditions.headSha; }
    if (dimension === "base") next.preconditions.baseSha = "e".repeat(40);
    if (dimension === "artifact") next.params.artifactId = "artifact-2";
    assert.notEqual(planner.plan(next).id, first.id);
  }
});

test("merge and close identities bind their version targets", t => {
  const { planner } = fixture(t); const merge = request("merge"); const close = request("issue-close");
  const firstMerge = planner.plan(merge); const firstClose = planner.plan(close);
  merge.preconditions.headSha = "d".repeat(40); close.params.mergeCommit = "e".repeat(40);
  assert.notEqual(planner.plan(merge).id, firstMerge.id); assert.notEqual(planner.plan(close).id, firstClose.id);
});

for (const kind of ["pull", "review", "merge"] as const) {
  test(`${kind}: requires full head and base SHAs`, t => {
    const { planner, store } = fixture(t);
    for (const field of ["headSha", "baseSha"] as const) for (const invalid of [undefined, "abcdef0", "g".repeat(40), "a".repeat(64)]) {
      const req = request(kind); req.preconditions[field] = invalid;
      assert.throws(() => planner.plan(req));
    }
    assert.equal(store.db.countRows("vivi_operations"), 0);
  });
}

test("review rejects missing artifact, mismatched commit and malformed body", t => {
  const { planner } = fixture(t);
  for (const params of [{ artifactId: " " }, { commitSha: base }, { body: {} }]) {
    const req = request("review"); Object.assign(req.params, params); assert.throws(() => planner.plan(req));
  }
});

test("branch and pull reject invalid Git refs, force and mismatched targets", t => {
  const { planner, store } = fixture(t);
  for (const invalid of ["a..b", "a.lock", "a/.b", "a//b", "a/", "a.", "@", "a@{b", "a b", "refs/heads/main", "a\\b", "a?b", "a[b"]) {
    const branch = request("branch"); branch.object.branch = invalid; assert.throws(() => planner.plan(branch), /./, invalid);
    const pull = request("pull"); pull.params.headBranch = invalid; assert.throws(() => planner.plan(pull), /./, invalid);
  }
  for (const patch of [{ force: true }, { overwrite: true }, { branch: "other" }, { baseSha: head }]) {
    const req = request("branch"); Object.assign(req.params, patch); assert.throws(() => planner.plan(req));
  }
  assert.equal(store.db.countRows("vivi_operations"), 0);
});

test("Issue close requires merge SHA, PR number and valid timestamp/frontier snapshot", t => {
  const { planner, store } = fixture(t);
  const mutations: ((req: GithubOperationRequest) => void)[] = [
    r => { r.params.mergeCommit = "abc1234"; }, r => { r.params.pullNumber = 0; }, r => { delete r.params.pullNumber; },
    r => { delete r.preconditions.issueUpdatedAt; }, r => { r.preconditions.issueUpdatedAt = "2026-02-30T00:00:00Z"; },
    r => { r.preconditions.issueUpdatedAt = "yesterday"; }, r => { delete r.preconditions.issueEventFrontier; },
    r => { r.preconditions.issueEventFrontier = -1; }, r => { r.preconditions.issueEventFrontier = 0.5; },
  ];
  for (const mutate of mutations) { const req = request("issue-close"); mutate(req); assert.throws(() => planner.plan(req)); }
  assert.equal(store.db.countRows("vivi_operations"), 0);
});

test("Source revocation, disabled and uninstalled kind reject even identical replay", t => {
  const { planner, registry, unregister } = fixture(t); const req = request("merge"); planner.plan(req);
  for (const status of ["revoked", "disabled", "unavailable"] as const) {
    registry.setStatus("github", status); assert.throws(() => planner.plan(req), /未启用/);
  }
  registry.setStatus("github", "enabled"); unregister(); assert.throws(() => planner.buildIntent(req), /未安装/);
});

test("M10 authorization and precondition checks apply before any writes", t => {
  const { planner, store } = fixture(t);
  const mutations: ((r: GithubOperationRequest) => void)[] = [
    r => { r.authorization.stopped = true; }, r => { r.authorization.allowed = []; }, r => { r.repositoryId = 12; },
    r => { r.authorization.instance = "other"; }, r => { r.preconditions.currentState = "closed"; },
    r => { r.preconditions.requiredChecks = ["test"]; r.preconditions.checks = { test: "failure" }; },
    r => { r.params.token = "fake-value"; }, r => { r.authorization.ticketId = " "; },
  ];
  for (const mutate of mutations) { const req = request("merge"); mutate(req); assert.throws(() => planner.plan(req)); }
  assert.equal(store.db.countRows("vivi_operations"), 0);
});

test("composition can roll back persisted native intents in its outer transaction", t => {
  const { planner, store } = fixture(t);
  assert.throws(() => store.atomic(() => { planner.plan(request("merge")); throw new Error("composition failed"); }), /composition failed/);
  assert.equal(store.db.countRows("vivi_operations"), 0);
});
