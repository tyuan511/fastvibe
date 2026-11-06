// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { GithubOperationHttpAdapter, GithubTestDeployment } from "../src/main/bot/shadow/github-deployment.ts";
import { GithubTestServer } from "./fixtures/vivi-dsh-github-server.ts";
import type { GithubAuthorization, GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore, type Operation } from "../src/main/bot/shadow/store.ts";

const shaA = "a".repeat(40), shaB = "b".repeat(40), shaC = "c".repeat(40), shaD = "d".repeat(40);
const config = { repository: { id: 11, owner: "acme", name: "widget", fullName: "acme/widget" }, selfLogins: ["fastvibe[bot]"] };
const authorization: GithubAuthorization = { source: "github", instance: "desktop", repositoryId: "11", ticketId: "ticket-1", mandateId: "mandate-1", generation: 1, allowed: ["branch", "pull", "review", "merge", "issue-close"] };
const secret = "loopback-only-secret";
function request(kind: GithubOperationRequest["kind"], patch: Partial<GithubOperationRequest> = {}): GithubOperationRequest {
  return { kind, source: "github", instance: "desktop", repositoryId: 11,
    object: kind === "branch" ? { branch: "fix/one" } : kind === "issue-close" ? { issueNumber: 7 } : { pullNumber: 8 },
    params: {}, authorization,
    preconditions: { currentState: "open", headSha: shaA, baseSha: shaB, requiredChecks: ["test"], checks: { test: "success" } }, ...patch };
}
async function fixture(t: TestContext, timeoutMs = 1000) {
  const dir = mkdtempSync(join(tmpdir(), "vivi-dsh-m11-")), file = join(dir, "shadow.db");
  const server = new GithubTestServer(); await server.start();
  let now = 1000;
  const connect = () => {
    const store = openShadowStore(file), registry = new ShadowSourceRegistry(store);
    registerGithubShadowSource(registry);
    if (!registry.instance("github")?.enabled) registry.configure("github", { enabled: true, config });
    const credentials = new ShadowCredentialHost(registry);
    credentials.register({ id: "m11.fake", kind: "github" }, { resolve: async () => secret });
    if (!registry.credentialBinding("github")) credentials.bind("github", { id: "m11.fake", kind: "github" });
    const deployment = new GithubTestDeployment(store, registry, credentials, { baseUrl: server.baseUrl, instance: "desktop", now: () => now, timeoutMs });
    return { store, registry, credentials, deployment };
  };
  let current = connect();
  t.after(async () => { await current.deployment.stop({ abort: true }); current.store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  return {
    server, get store() { return current.store; }, get registry() { return current.registry; }, get credentials() { return current.credentials; },
    get deployment() { return current.deployment; },
    async restart() { await current.deployment.stop({ abort: true }); current.store.close(); now += 3000; current = connect(); current.deployment.start(); await current.deployment.idle(); },
    time(value: number) { now = value; },
    status(plan: Operation) { return current.store.operations.get(plan.source, plan.instance, plan.key)?.status; },
    details() { return current.store.db.all("SELECT kind,status,error FROM dsh_effects"); },
  };
}
const pullRequest = () => request("pull", { object: {}, params: { headBranch: "fix/one", baseBranch: "main", title: "Fix", body: "" } });
const reviewRequest = () => request("review", { params: { commitSha: shaA, event: "APPROVE", body: "Verified" } });
function count(server: GithubTestServer, method: string, path: string) { return server.requests.filter(row => row.method === method && row.path === path).length; }

test("M11 executes all five types through durable HTTP effects and duplicate plan writes once", async t => {
  const f = await fixture(t); const branchRequest = request("branch", { params: { branch: "fix/one", baseSha: shaA } });
  const plans = [f.deployment.planAndQueue(branchRequest)];
  assert.deepEqual(f.deployment.planAndQueue(branchRequest), plans[0]);
  plans.push(f.deployment.planAndQueue(request("pull", { object: {}, params: { headBranch: "fix/one", baseBranch: "main", title: "Fix bug" } })));
  plans.push(f.deployment.planAndQueue(reviewRequest()));
  plans.push(f.deployment.planAndQueue(request("merge")));
  plans.push(f.deployment.planAndQueue(request("issue-close", { params: { mergeCommit: shaD } })));
  f.deployment.start(); await f.deployment.idle();
  assert.deepEqual(plans.map(plan => f.status(plan)), Array(5).fill("confirmed"), JSON.stringify(f.details()));
  assert.equal(count(f.server, "POST", "/repositories/11/git/refs"), 1);
  assert.equal(f.server.state.issue.state, "closed");
  for (const table of ["dsh_operations", "dsh_kv"]) assert.ok(f.store.db.all<{ data: string }>(`SELECT data FROM ${table}`).every(row => !row.data.includes(secret)));
  assert.equal(f.store.db.countRows("dsh_session_receipts"), 0);
  await f.restart();
  assert.deepEqual(plans.map(plan => f.status(plan)), Array(5).fill("confirmed"));
  assert.equal(count(f.server, "PUT", "/repos/11/pulls/8/merge"), 1);
});

test("head drift rejects stale Review and Merge; old approval cannot approve a new SHA", async t => {
  const f = await fixture(t); f.deployment.planAndQueue(pullRequest()); const review = f.deployment.planAndQueue(reviewRequest()); f.deployment.start(); await f.deployment.idle();
  assert.equal(f.status(review), "confirmed", JSON.stringify(f.details()));
  f.server.driftPullHead(shaC);
  const staleMerge = f.deployment.planAndQueue(request("merge")); await f.deployment.idle();
  assert.equal(f.status(staleMerge), "failed"); assert.equal(f.server.state.pull.merged, false);
  // A fresh fixture probes the new-SHA merge separately from M10's immutable
  // operation identity, which correctly rejects parameter drift.
  await f.deployment.stop();
  const g = await fixture(t); g.deployment.planAndQueue(pullRequest()); g.server.driftPullHead(shaC);
  const staleReview = g.deployment.planAndQueue(reviewRequest());
  const mergeWithoutCurrentReview = g.deployment.planAndQueue(request("merge", { preconditions: { ...request("merge").preconditions, headSha: shaC } }));
  g.deployment.start(); await g.deployment.idle();
  assert.equal(g.status(staleReview), "failed", JSON.stringify(g.details()));
  assert.equal(g.status(mergeWithoutCurrentReview), "failed"); assert.equal(g.server.state.reviews.length, 0);
});

for (const kind of ["branch", "pull", "review", "merge", "issue-close"] as const) test(`${kind} lost response: restart only inspects and does not repeat the write`, async t => {
  const f = await fixture(t);
  if (kind === "merge" || kind === "issue-close" || kind === "review") f.deployment.planAndQueue(pullRequest());
  if (kind === "merge" || kind === "issue-close") {
    f.deployment.planAndQueue(reviewRequest()); f.deployment.start(); await f.deployment.idle();
    if (kind === "issue-close") { f.deployment.planAndQueue(request("merge")); await f.deployment.idle(); }
  }
  const req = kind === "branch" ? request(kind, { params: { branch: "fix/one", baseSha: shaA } })
    : kind === "pull" ? request(kind, { object: {}, params: { headBranch: "fix/one", baseBranch: "main", title: "Fix" } })
    : kind === "review" ? reviewRequest() : kind === "issue-close" ? request(kind, { params: { mergeCommit: shaD } }) : request(kind);
  const plan = f.deployment.planAndQueue(req); const { method, path } = plan.payload.expected;
  f.server.injectFault(method, path, { kind: "drop-after-apply" });
  f.deployment.start(); await f.deployment.idle();
  assert.equal(f.status(plan), "uncertain", JSON.stringify(f.details()));
  if (kind === "issue-close") assert.equal(f.server.state.pull.merged, true);
  await f.restart();
  assert.equal(f.status(plan), "confirmed", JSON.stringify(f.details()));
  assert.equal(count(f.server, method, path), 1);
  assert.ok(f.server.requests.some(row => row.method === "GET"));
});

test("Issue close operation and unknown inspection remain separate from confirmed merge", async t => {
  const f = await fixture(t); f.deployment.planAndQueue(pullRequest()); f.deployment.planAndQueue(reviewRequest()); f.deployment.start(); await f.deployment.idle();
  const merge = f.deployment.planAndQueue(request("merge")); await f.deployment.idle(); assert.equal(f.status(merge), "confirmed");
  const close = f.deployment.planAndQueue(request("issue-close", { params: { mergeCommit: shaD } }));
  f.server.injectFault("PATCH", close.payload.expected.path, { kind: "drop-after-apply" }); await f.deployment.idle();
  f.server.injectFault("GET", close.payload.expected.path, { kind: "status", status: 503 });
  await f.restart(); assert.equal(f.status(close), "uncertain"); assert.equal(f.status(merge), "confirmed");
  f.time(7000); f.deployment.recover(); await f.deployment.idle(); assert.equal(f.status(close), "confirmed");
  assert.equal(count(f.server, "PATCH", close.payload.expected.path), 1);
});

test("5xx and absent object remain unknown without automatically repeating the write", async t => {
  const f = await fixture(t); const plan = f.deployment.planAndQueue(request("branch", { params: { baseSha: shaA } }));
  f.server.injectFault("POST", plan.payload.expected.path, { kind: "status", status: 503 });
  f.deployment.start(); await f.deployment.idle(); assert.equal(f.status(plan), "uncertain");
  assert.equal(f.server.state.branches.has("fix/one"), false);
  await f.restart(); assert.equal(f.status(plan), "uncertain", JSON.stringify(f.details()));
  assert.equal(count(f.server, "POST", plan.payload.expected.path), 1);
});

test("HTTP timeout after apply is uncertain then read-only reconciliation confirms", async t => {
  const f = await fixture(t, 100); const plan = f.deployment.planAndQueue(request("branch", { params: { baseSha: shaA } }));
  f.server.injectFault("POST", plan.payload.expected.path, { kind: "delay", delayMs: 200 });
  f.deployment.start(); await f.deployment.idle(); assert.equal(f.status(plan), "uncertain");
  await f.restart(); assert.equal(f.status(plan), "confirmed"); assert.equal(count(f.server, "POST", plan.payload.expected.path), 1);
});

test("plan and Effect enqueue are atomic; adapter refuses non-loopback destinations", async t => {
  const f = await fixture(t);
  f.store.db.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON dsh_effects BEGIN SELECT RAISE(ABORT,'enqueue abort'); END");
  assert.throws(() => f.deployment.planAndQueue(request("branch", { params: { baseSha: shaA } })), /enqueue abort/);
  assert.equal(f.store.db.countRows("dsh_operations"), 0); assert.equal(f.server.requests.length, 0);
  for (const baseUrl of ["https://api.github.com", "http://localhost:1234", "http://127.0.0.1:1234/path", "http://user:pass@127.0.0.1"]) {
    assert.throws(() => new GithubOperationHttpAdapter({ baseUrl, credentials: f.credentials }), /loopback/);
  }
});

test("host authorize runs after credential resolution and never on read reconciliation", async t => {
  const f = await fixture(t); await f.deployment.stop();
  const events: string[] = [], credentials = new ShadowCredentialHost(f.registry); let now = 1000;
  credentials.register({ id: "m11.fake", kind: "github" }, { resolve: async () => { await Promise.resolve(); events.push("credential"); return secret; } });
  const deployment = new GithubTestDeployment(f.store, f.registry, credentials, {
    baseUrl: f.server.baseUrl, instance: "desktop", now: () => now,
    authorize: () => { events.push("authorize"); assert.equal(f.server.requests.length, 0); },
  });
  t.after(() => deployment.stop({ abort: true }));
  const plan = deployment.planAndQueue(request("branch", { params: { baseSha: shaA } }));
  f.server.injectFault("POST", plan.payload.expected.path, { kind: "drop-after-apply" });
  deployment.start(); await deployment.idle(); assert.equal(f.status(plan), "uncertain");
  assert.deepEqual(events.slice(0, 2), ["credential", "authorize"]);
  now = 4000; deployment.recover(); await deployment.idle(); assert.equal(f.status(plan), "confirmed");
  assert.equal(events.filter(event => event === "authorize").length, 1);
  assert.equal(count(f.server, "POST", plan.payload.expected.path), 1);
});

test("mismatched object parameters remain uncertain and no second POST is issued", async t => {
  const f = await fixture(t); const plan = f.deployment.planAndQueue(request("branch", { params: { baseSha: shaA } }));
  f.server.injectFault("POST", plan.payload.expected.path, { kind: "drop-after-apply" });
  f.deployment.start(); await f.deployment.idle(); assert.equal(f.status(plan), "uncertain");
  f.server.state.branches.set("fix/one", shaC);
  await f.restart(); assert.equal(f.status(plan), "uncertain");
  assert.equal(count(f.server, "POST", plan.payload.expected.path), 1);
});