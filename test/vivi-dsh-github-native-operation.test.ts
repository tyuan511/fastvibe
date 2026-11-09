// SPDX-License-Identifier: MIT
// Native REST contract tests use real HTTP and durable operation/effect claims; all credentials are fake.
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { ShadowEffects } from "../src/main/bot/shadow/effects.ts";
import { GithubNativeOperationAdapter } from "../src/main/bot/shadow/github-native-operation.ts";
import { GithubNativePlanner } from "../src/main/bot/shadow/github-native-plan.ts";
import type { GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { ShadowOperations } from "../src/main/bot/shadow/operations.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore, type Operation } from "../src/main/bot/shadow/store.ts";
import { GithubNativeServer, HEAD, BASE, MERGED, ROOT } from "./fixtures/vivi-dsh-github-native-server.ts";

type Kind = GithubOperationRequest["kind"];
const kinds = ["branch", "pull", "review", "merge", "issue-close"] as const;
function request(kind: Kind): GithubOperationRequest {
  return { kind, source: "github", instance: "desktop", repositoryId: 11,
    object: kind === "branch" ? { branch: "fix/one" } : kind === "issue-close" ? { issueNumber: 7 } : kind === "pull" ? {} : { pullNumber: 8 },
    authorization: { source: "github", instance: "desktop", repositoryId: "11", ticketId: "ticket-1", mandateId: "decision-1", generation: 1,
      assignmentId: "assignment-1", bindingClaim: 2, allowed: [...kinds] },
    params: kind === "branch" ? { baseSha: BASE } : kind === "pull" ? { title: "Fix", body: "Details", headBranch: "fix/one", baseBranch: "main" }
      : kind === "review" ? { artifactId: "artifact-1", commitSha: HEAD, event: "APPROVE", body: "Reviewed" }
      : kind === "merge" ? { method: "squash" } : { mergeCommit: MERGED, pullNumber: 8 },
    preconditions: { headSha: HEAD, baseSha: BASE, currentState: "open", issueUpdatedAt: "2026-01-01T00:00:00Z", issueEventFrontier: 0 } };
}
const writePath = (kind: Kind) => kind === "branch" ? `${ROOT}/git/refs` : kind === "pull" ? `${ROOT}/pulls` : kind === "review" ? `${ROOT}/pulls/8/reviews` : kind === "merge" ? `${ROOT}/pulls/8/merge` : `${ROOT}/issues/7`;
const method = (kind: Kind) => kind === "merge" ? "PUT" : kind === "issue-close" ? "PATCH" : "POST";
async function fixture(t: TestContext, kind: Kind, bestEffort = true, reviewerPrincipalMode?: "user" | "github-app") {
  const server = new GithubNativeServer(); await server.start();
  const store = openShadowStore(":memory:"), registry = new ShadowSourceRegistry(store);
  registerGithubShadowSource(registry); registry.configure("github", { enabled: true, config: { repository: { id: 11, owner: "acme", name: "widget" } } });
  // Reviewer credentials have a separate Source binding, even though intents use the writer Source.
  registry.register({ kind: "github-reviewer", validate: value => value as Record<string, unknown> });
  registry.configure("github-reviewer", { enabled: true, config: {} });
  const credentials = new ShadowCredentialHost(registry);
  for (const [source, name] of [["github", "writer"], ["github-reviewer", "reviewer"]]) {
    const ref = { id: `fake-${name}`, kind: "github" }; credentials.register(ref, { resolve: async () => `fake-${name}` }); credentials.bind(source!, ref);
  }
  const transport = (source: string, principalMode?: "user" | "github-app") => new GithubRestTransport({ repository: { id: 11, owner: "acme", name: "widget" }, credentials, source, baseUrl: server.baseUrl, loopbackTest: true, ...(principalMode ? { principalMode } : {}) });
  let authorized = 0;
  const adapter = new GithubNativeOperationAdapter({ store, writer: transport("github"), reviewer: transport("github-reviewer", reviewerPrincipalMode),
    writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" }, requiredChecks: ["test"],
    authorize: () => { authorized++; }, ...(bestEffort ? { issueClose: "best-effort" as const } : {}) });
  const effects = new ShadowEffects(store), operations = new ShadowOperations(store, effects, adapter), planner = new GithubNativePlanner(store, registry, "github", "desktop");
  if (kind === "branch") server.branches.delete("fix/one");
  if (kind === "review" || kind === "merge") server.seedPull();
  if (kind === "merge") server.seedApproval();
  if (kind === "issue-close") server.seedMerged();
  t.after(async () => { await effects.drain({ abort: true }); store.close(); await server.close(); });
  const plan = (req = request(kind)) => store.atomic(() => { const planned = planner.plan(req); return operations.plan(planned); });
  const current = (op: Operation) => operations.get(op.source, op.instance, op.key)!;
  const run = async (req = request(kind)) => { const op = plan(req); effects.start(); await effects.idle(); return current(op); };
  const recover = async (op: Operation) => { operations.recover(); await effects.idle(); return current(op); };
  const writes = () => server.requests.filter(r => r.method !== "GET");
  return { server, store, effects, operations, plan, run, recover, current, writes, authorized: () => authorized };
}

for (const kind of kinds) {
  test(`${kind}: native REST success through durable Effect/Operation and exact wire body`, async t => {
    const f = await fixture(t, kind); const op = await f.run();
    assert.equal(op.status, "confirmed", JSON.stringify(op)); assert.equal(f.writes().length, 1); assert.equal(f.authorized(), 2);
    const wire = f.writes()[0]!; assert.equal(wire.path, writePath(kind)); assert.equal(wire.method, method(kind));
    assert.equal(wire.actor, kind === "review" || kind === "merge" ? "reviewer" : "agent");
    assert.equal(wire.headers["x-m11-operation"], undefined); assert.equal(wire.headers["idempotency-key"], undefined);
    assert.equal(wire.headers.accept, "application/vnd.github+json"); assert.equal(wire.headers["x-github-api-version"], "2022-11-28");
    const expectedKeys = kind === "branch" ? ["ref", "sha"] : kind === "pull" ? ["base", "body", "head", "title"] : kind === "review" ? ["body", "commit_id", "event"] : kind === "merge" ? ["merge_method", "sha"] : ["state", "state_reason"];
    assert.deepEqual(Object.keys(wire.body!).sort(), expectedKeys.sort());
    assert.ok(f.server.requests.some(r => r.path === "/user" && r.actor === wire.actor));
    assert.equal(JSON.stringify(wire.body).includes("bindingClaim"), false);
    if (kind === "pull") {
      const pull = f.server.pulls[0]!;
      assert.equal((pull.head as Record<string, unknown>).sha, HEAD);
      assert.equal(typeof pull.head, "object"); assert.equal(typeof pull.base, "object");
      assert.equal(pull.operationId, undefined); assert.equal(pull.params, undefined);
    }
    if (kind === "review") { assert.equal(f.server.reviews[0]!.state, "APPROVED"); assert.equal(f.server.reviews[0]!.event, undefined); }
    if (kind === "issue-close") { assert.equal(f.server.issue.version, undefined); assert.equal(f.server.issue.mergeCommit, undefined); }
  });
  test(`${kind}: dropped response recovers using GET only and never repeats write`, async t => {
    const f = await fixture(t, kind); f.server.fault(method(kind), writePath(kind), { kind: "drop-after-apply" });
    const op = await f.run(); assert.equal(op.status, "uncertain"); assert.equal(f.writes().length, 1);
    const start = f.server.requests.length; const recovered = await f.recover(op);
    assert.equal(recovered.status, "confirmed", JSON.stringify(recovered));
    assert.ok(f.server.requests.slice(start).length > 0); assert.ok(f.server.requests.slice(start).every(r => r.method === "GET"));
    await f.recover(op); assert.equal(f.writes().length, 1);
  });
}

for (const evidence of ["linked-merge", "other-commit", "foreign-actor", "reopened"] as const) test(`strict Issue settlement observes GitHub automatic closure: ${evidence}`, async t => {
  const f = await fixture(t, "issue-close", false);
  f.server.issue.state = "closed";
  f.server.events.push({ id: 200, event: "closed", commit_id: evidence === "other-commit" ? "d".repeat(40) : MERGED,
    actor: { id: evidence === "foreign-actor" ? 3 : 2 }, created_at: new Date().toISOString() });
  if (evidence === "reopened") f.server.reopen();
  const op = await f.run();
  assert.equal(op.status, evidence === "linked-merge" ? "confirmed" : "failed");
  assert.equal(f.writes().length, 0);
  if (evidence === "linked-merge") assert.equal((op.receipt as { evidence: string }).evidence, "linked-merge-close-event");
});

test("PR and CI pagination follow page 2 for marker and required successful checks", async t => {
  const f = await fixture(t, "pull"); f.server.splitPages.add(`${ROOT}/pulls`);
  f.server.fault("POST", `${ROOT}/pulls`, { kind: "drop-after-apply" }); const op = await f.run();
  assert.equal((await f.recover(op)).status, "confirmed");
  assert.ok(f.server.requests.some(r => r.path === `${ROOT}/pulls` && r.query.page === "2" && r.query.state === "all"));
  const g = await fixture(t, "merge");
  for (const path of [`${ROOT}/commits/${HEAD}/check-runs`, `${ROOT}/commits/${HEAD}/statuses`, `${ROOT}/pulls/8/reviews`]) g.server.splitPages.add(path);
  assert.equal((await g.run()).status, "confirmed");
  for (const path of g.server.splitPages) assert.ok(g.server.requests.some(r => r.path === path && r.query.page === "2"));
});

for (const mode of ["404", "no-match", "ambiguous"] as const) test(`uncertain ${mode} evidence stays unknown and cannot be retried`, async t => {
  const kind = mode === "404" ? "branch" : "pull"; const f = await fixture(t, kind);
  f.server.fault(method(kind), writePath(kind), { kind: "drop-after-apply" }); const op = await f.run();
  if (mode === "404") f.server.branches.delete("fix/one");
  if (mode === "no-match") f.server.pulls[0]!.body = "Other author marker";
  if (mode === "ambiguous") f.server.pulls.push({ ...structuredClone(f.server.pulls[0]!), id: 999, number: 9 });
  assert.equal((await f.recover(op)).status, "uncertain");
  assert.throws(() => f.operations.retry(op.source, op.instance, op.key), /未知/); await f.recover(op); assert.equal(f.writes().length, 1);
});

test("approval on old SHA cannot merge a newer head", async t => {
  const f = await fixture(t, "merge"), newer = "d".repeat(40); f.server.driftHead(newer);
  f.server.checks[0]!.head_sha = newer;
  const req = request("merge"); req.preconditions.headSha = newer;
  assert.equal((await f.run(req)).status, "failed"); assert.equal(f.writes().length, 0);
});

test("review lost response on head drift confirms stale receipt without creating new approval", async t => {
  const f = await fixture(t, "review"); f.server.fault("POST", writePath("review"), { kind: "drop-after-apply" });
  const op = await f.run(); f.server.driftHead("d".repeat(40));
  const recovered = await f.recover(op); assert.equal(recovered.status, "confirmed");
  assert.equal((recovered.receipt as Record<string, unknown>).stale, true); assert.equal(f.server.reviews.length, 1);
});

for (const status of [409, 403, 503]) test(`native ${status}: known conflict fails; throttling/server errors remain unknown without resend`, async t => {
  const f = await fixture(t, "branch");
  f.server.fault("POST", writePath("branch"), { kind: "status", status, message: status === 409 ? "Reference conflict" : status === 403 ? "API rate limit exceeded" : "Service unavailable", ...(status === 403 ? { headers: { "x-ratelimit-remaining": "0", "retry-after": "60" } } : {}) });
  const op = await f.run(); assert.equal(op.status, status === 409 ? "failed" : "uncertain");
  if (status !== 409) { assert.equal((await f.recover(op)).status, "uncertain"); assert.throws(() => f.operations.retry(op.source, op.instance, op.key)); }
  assert.equal(f.writes().length, 1);
});

for (const kind of ["branch", "review"] as const) test(`${kind}: /user rejects swapped credential identity before writing`, async t => {
  const f = await fixture(t, kind); const token = kind === "branch" ? "fake-writer" : "fake-reviewer";
  f.server.identities.set(token, kind === "branch" ? { id: 2, login: "reviewer" } : { id: 1, login: "agent" });
  assert.equal((await f.run()).status, "failed"); assert.equal(f.writes().length, 0);
  assert.ok(f.server.requests.some(r => r.path === "/user"));
});

for (const mismatch of ["actor", "body", "commit", "ambiguous"] as const) test(`review recovery rejects ${mismatch} evidence without resend`, async t => {
  const f = await fixture(t, "review"); f.server.fault("POST", writePath("review"), { kind: "drop-after-apply" });
  const op = await f.run(), review = f.server.reviews[0]!;
  if (mismatch === "actor") review.user = { id: 3, login: "other" };
  if (mismatch === "body") review.body = "Different review";
  if (mismatch === "commit") review.commit_id = BASE;
  if (mismatch === "ambiguous") f.server.reviews.push({ ...structuredClone(review), id: 999 });
  assert.equal((await f.recover(op)).status, "uncertain"); assert.equal(f.writes().length, 1);
});

test("branch recovery rejects a ref now pointing to another commit", async t => {
  const f = await fixture(t, "branch"); f.server.fault("POST", writePath("branch"), { kind: "drop-after-apply" });
  const op = await f.run(); f.server.branches.set("fix/one", HEAD);
  assert.equal((await f.recover(op)).status, "uncertain"); assert.equal(f.writes().length, 1);
});

test("latest failed status on page 2 prevents merge despite earlier successful check", async t => {
  const f = await fixture(t, "merge"); f.server.splitPages.add(`${ROOT}/commits/${HEAD}/statuses`);
  f.server.statuses.push({ id: 1, context: "test", state: "success" }, { id: 2, context: "test", state: "failure" });
  assert.equal((await f.run()).status, "failed"); assert.equal(f.writes().length, 0);
});

for (const event of ["REQUEST_CHANGES", "COMMENT"] as const) test(`review ${event} maps to native response state`, async t => {
  const f = await fixture(t, "review"), req = request("review"); req.params.event = event;
  assert.equal((await f.run(req)).status, "confirmed");
  assert.equal(f.server.reviews[0]!.state, event === "REQUEST_CHANGES" ? "CHANGES_REQUESTED" : "COMMENTED");
});

test("Issue close event pagination confirms actor and refuses foreign close actor", async t => {
  const f = await fixture(t, "issue-close"); f.server.splitPages.add(`${ROOT}/issues/7/events`);
  f.server.fault("PATCH", writePath("issue-close"), { kind: "drop-after-apply" });
  const op = await f.run(); f.server.events[0]!.actor = { id: 3, login: "other" };
  assert.equal((await f.recover(op)).status, "uncertain"); assert.equal(f.writes().length, 1);
  assert.ok(f.server.requests.some(r => r.path === `${ROOT}/issues/7/events` && r.query.page === "2"));
});

test("Issue close strict profile refuses PATCH by default", async t => {
  const f = await fixture(t, "issue-close", false); assert.equal((await f.run()).status, "failed"); assert.equal(f.writes().length, 0);
});
for (const change of ["updated-at", "event-frontier"] as const) test(`Issue close refuses changed ${change} observation`, async t => {
  const f = await fixture(t, "issue-close");
  if (change === "updated-at") f.server.issue.updated_at = "2026-01-02T00:00:00Z";
  else f.server.events.push({ id: 5, event: "labeled", actor: { id: 3 }, created_at: new Date().toISOString() });
  assert.equal((await f.run()).status, "failed"); assert.equal(f.writes().length, 0);
});
test("Issue reopen after lost close response remains unknown and does not PATCH again", async t => {
  const f = await fixture(t, "issue-close"); f.server.fault("PATCH", writePath("issue-close"), { kind: "drop-after-apply" });
  const op = await f.run(); f.server.reopen(); assert.equal((await f.recover(op)).status, "uncertain");
  await f.recover(op); assert.equal(f.writes().length, 1); assert.equal(f.server.issue.state, "open");
});

test("github-app principal mode sends a review with no /user reflection", async t => {
  const f = await fixture(t, "review", true, "github-app");
  const op = await f.run();
  assert.equal(op.status, "confirmed", JSON.stringify(op));
  assert.equal(f.writes().length, 1);
  assert.equal(f.writes()[0]!.path, writePath("review"));
  // Default mode reflects /user twice (preflight identity + write binding); app mode must not read it at all.
  assert.ok(!f.server.requests.some(r => r.path === "/user"), "app principal mode must not read /user");
});

test("principalMode 只接受 user 或 github-app", () => {
  const credentials = new ShadowCredentialHost(new ShadowSourceRegistry(openShadowStore(":memory:")));
  const base = { repository: { id: 11, owner: "acme", name: "widget" }, credentials, source: "github" } as const;
  assert.throws(() => new GithubRestTransport({ ...base, principalMode: "app" as never }), /未确认/);
  assert.equal(new GithubRestTransport({ ...base }).principalMode, "user");
  assert.equal(new GithubRestTransport({ ...base, principalMode: "github-app" }).principalMode, "github-app");
});
