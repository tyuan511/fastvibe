// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { GithubOperationAuthority } from "../src/main/bot/shadow/github-authority.ts";
import { GithubTestDeployment } from "../src/main/bot/shadow/github-deployment.ts";
import { GithubIssueSettlement } from "../src/main/bot/shadow/github-settlement.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { githubEventToTrigger, registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import type { GithubAuthorization, GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { GithubTestServer } from "./fixtures/vivi-github-server.ts";
import * as gh from "./fixtures/vivi-github-http.ts";

for (const mode of ["success", "lost-close", "close-refused", "reopen-before-close", "reopen-after-lost-close"] as const) test(`domain merged -> durable HTTP Issue continuation: ${mode}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-github-continuation-")), file = join(dir, "shadow.db");
  const server = new GithubTestServer(); await server.start();
  let now = Date.parse(gh.at), store = openShadowStore(file);
  const policy: Policy = { version: "m11-domain-test", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  const connect = () => {
    const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    if (!registry.instance("github")?.enabled) registry.configure("github", { enabled: true, config: gh.config });
    const credentials = new ShadowCredentialHost(registry);
    credentials.register({ id: "m11.profile", kind: "github" }, { resolve: async () => "loopback-only-secret" });
    if (!registry.credentialBinding("github")) credentials.bind("github", { id: "m11.profile", kind: "github" });
    const engine = new ShadowEngine(store, { policy: () => policy, scope: registry, now: () => now });
    const authority = new GithubOperationAuthority(store, registry, engine, () => policy);
    let settlement!: GithubIssueSettlement;
    const deployment = new GithubTestDeployment(store, registry, credentials, { baseUrl: server.baseUrl, instance: "desktop", now: () => now,
      authorize: op => (op.payload as { kind: string }).kind === "issue-close" ? settlement.authorize(op) : authority.authorize(op),
      driverOptions: { policy: () => policy, scope: registry } });
    settlement = new GithubIssueSettlement(store, deployment.driver.operations!, { policy: () => policy, registry });
    return { engine, authority, deployment, settlement };
  };
  let host = connect();
  t.after(async () => { await host.deployment.stop({ abort: true }); store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const trigger = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", gh.config);
  const pull = githubEventToTrigger({ type: "pull_request", pull_request: gh.pull, repository: gh.repository }, "github", "desktop", gh.config).threads[0]!;
  host.engine.sources.receive(trigger); host.engine.evaluateDue();
  const candidate = host.engine.main.candidate(trigger.id)!; assert.ok(candidate);
  const accepted = host.engine.main.decide(trigger.id, { kind: "accept", evalId: candidate.evalId, title: "fix bug", scope: "acme/widget issue 7", reason: "explicit fixture" });
  const ticketId = accepted.ticketId!; assert.ok(ticketId);
  host.engine.sources.bindThread(ticketId, pull, true);
  const assignment = store.tickets.get(ticketId)!.assignments[0]!;
  const claim = store.effects.claim("launch", assignment.id, "fixture-worker", now, 30_000)!;
  const token = host.engine.completeLaunch(claim)!; assert.ok(token);
  const auth: GithubAuthorization = host.authority.grant(token, "github", "desktop", "11", ["pull", "review", "merge", "issue-close"], { settleIssue: true });
  const request = (kind: GithubOperationRequest["kind"], params: Record<string, unknown> = {}): GithubOperationRequest => ({ kind, params,
    source: "github", instance: "desktop", repositoryId: 11, object: kind === "issue-close" ? { issueNumber: 7 } : kind === "pull" ? {} : { pullNumber: 8 }, authorization: auth,
    preconditions: { currentState: "open", headSha: "a".repeat(40), baseSha: "b".repeat(40), requiredChecks: ["test"], checks: { test: "success" }, ...(kind === "issue-close" ? { issueVersion: 1 } : {}) } });
  host.deployment.planAndQueue(request("pull", { headBranch: "fix/one", baseBranch: "main", title: "Fix bug" }));
  host.deployment.planAndQueue(request("review", { event: "APPROVE", commitSha: "a".repeat(40), body: "fixture review" }));
  host.deployment.start(); await host.deployment.idle();
  host.engine.worker.read(token, store.tickets.get(ticketId)!.inputs.map(input => input.id));
  host.engine.worker.report(token, { state: "ready", summary: "test worker ready" });
  assert.equal(store.tickets.get(ticketId)!.ended, undefined);
  const merge = host.deployment.planAndQueue(request("merge")); await host.deployment.idle();
  assert.equal(store.operations.get(merge.source, merge.instance, merge.key)?.status, "confirmed");
  if (mode === "lost-close" || mode === "reopen-after-lost-close") server.injectFault("PATCH", "/repos/11/issues/7", { kind: "drop-after-apply" });
  if (mode === "close-refused") server.injectFault("PATCH", "/repos/11/issues/7", { kind: "status", status: 403 });
  const continuation = host.settlement.closeMergedThread(host.engine.sources, pull, {
    ticketId, originIssue: 7, pullThread: pull, closedAt: new Date(now + 1).toISOString(),
    mergeOperation: { source: merge.source, instance: merge.instance, key: merge.key }, closeRequest: request("issue-close", { mergeCommit: "d".repeat(40) }),
  });
  assert.equal(continuation.status, "pending");
  assert.equal(host.engine.currentBinding(ticketId), undefined);
  const endedAssignments = store.tickets.get(ticketId)!.assignments;
  if (mode === "reopen-before-close") server.reopenIssue();
  await host.deployment.idle();
  const expected = mode === "success" ? "confirmed" : mode === "lost-close" || mode === "reopen-after-lost-close" ? "uncertain" : "failed";
  assert.equal(host.settlement.get(ticketId)!.status, expected);
  assert.equal(store.tickets.get(ticketId)!.ended?.outcome, "merged");
  assert.deepEqual(store.tickets.get(ticketId)!.assignments, endedAssignments);
  assert.equal(server.state.issue.state, mode === "close-refused" || mode === "reopen-before-close" ? "open" : "closed");
  if (mode === "reopen-after-lost-close") server.reopenIssue();
  await host.deployment.stop({ abort: true }); store.close(); now += 3000; store = openShadowStore(file); host = connect();
  host.deployment.start(); await host.deployment.idle();
  assert.equal(host.settlement.get(ticketId)!.status, mode === "lost-close" ? "confirmed" : expected);
  assert.equal(server.requests.filter(row => row.method === "PATCH").length, 1);
  assert.equal(store.tickets.get(ticketId)!.ended?.outcome, "merged");
  if (mode === "reopen-after-lost-close") assert.equal(server.state.issue.state, "open");
});
