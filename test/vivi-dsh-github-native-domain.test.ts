// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../src/main/bot/core/ports.ts";
import type { GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { GithubNativeDeployment } from "../src/main/bot/shadow/github-native-deployment.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { githubEventToTrigger, registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { GithubNativeServer, HEAD, BASE, MERGED, ROOT } from "./fixtures/vivi-dsh-github-native-server.ts";
import * as gh from "./fixtures/vivi-dsh-github-http.ts";

for (const mode of ["strict", "close", "lost-close", "repair"] as const) test(`native deployment uses real domain authority and ended continuation: ${mode}`, async t => {
  const dir = mkdtempSync(join(tmpdir(), "dsh-native-domain-")), file = join(dir, "shadow.db"), server = new GithubNativeServer();
  await server.start(); let store = openShadowStore(file), now = Date.now();
  const config = { ...gh.config, selfLogins: ["agent"] };
  const policy: Policy = { version: "native-domain", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  const connect = () => {
    const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    if (!registry.instance("github")?.enabled) registry.configure("github", { enabled: true, config });
    const credentials = new ShadowCredentialHost(registry);
    for (const [source, id, value] of [["github", "native.writer", "fake-writer"], ["github-review", "native.reviewer", "fake-reviewer"]]) {
      credentials.register({ id: id!, kind: "github" }, { resolve: async () => value });
      if (!registry.credentialBinding(source!)) credentials.bind(source!, { id: id!, kind: "github" });
    }
    const transport = (source: string) => new GithubRestTransport({ repository: gh.config.repository, credentials, source, baseUrl: server.baseUrl, loopbackTest: true });
    return new GithubNativeDeployment(store, registry, {
      writer: transport("github"), reviewer: transport("github-review"), reader: transport("github"), writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" },
      requiredChecks: ["test"], issueClose: mode === "strict" ? undefined : "best-effort", instance: "desktop",
      driver: { policy: () => policy, now: () => now, intervalMs: false },
      adapters: { assessment: async () => {}, launch: async () => {}, delivery: async () => {}, notice: async () => {}, relay: async () => {}, stop: async () => {}, release: async () => {} },
    });
  };
  let deployment = connect();
  t.after(async () => { await deployment.stop({ abort: true }); store.close(); await server.close(); rmSync(dir, { recursive: true, force: true }); });
  const trigger = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", config);
  const engine = deployment.driver.engine;
  engine.sources.receive(trigger); engine.evaluateDue(); const candidate = engine.main.candidate(trigger.id)!;
  const result = engine.main.decide(trigger.id, { evalId: candidate.evalId, kind: "accept", title: "native work", scope: "acme/widget", reason: "explicit fixture" });
  const ticketId = result.ticketId!; deployment.start(); await deployment.idle();
  const token = engine.currentBinding(ticketId)!; assert.ok(token);
  const authorization = deployment.grant(token, ["pull", "review", "merge", "issue-close"], { settleIssue: true });
  let head = HEAD;
  const request = (kind: GithubOperationRequest["kind"], params: Record<string, unknown>): GithubOperationRequest => ({ kind, source: "github", instance: "desktop", repositoryId: 11,
    object: kind === "pull" ? {} : kind === "issue-close" ? { issueNumber: 7 } : { pullNumber: 8 }, params, authorization,
    preconditions: { currentState: "open", headSha: head, baseSha: BASE, requiredChecks: ["test"], checks: { test: "success" },
      ...(kind === "issue-close" ? { issueUpdatedAt: "2026-01-01T00:00:00Z", issueEventFrontier: 0 } : {}) } });
  const pr = deployment.planAndQueue(request("pull", { headBranch: "fix/one", baseBranch: "main", title: "Fix" })); await deployment.idle();
  assert.equal(store.operations.get(pr.source, pr.instance, pr.key)?.status, "confirmed");
  const pull = githubEventToTrigger({ type: "pull_request", pull_request: server.pulls[0], repository: gh.repository }, "github", "desktop", config).threads[0]!;
  engine.sources.bindThread(ticketId, pull, true);
  const review = deployment.planAndQueue(request("review", { commitSha: head, event: "APPROVE", artifactId: "review-a", body: "Checked" })); await deployment.idle();
  assert.equal(store.operations.get(review.source, review.instance, review.key)?.status, "confirmed");
  if (mode === "repair") {
    head = "d".repeat(40); server.driftHead(head); server.checks[0]!.head_sha = head;
    const next = deployment.planAndQueue(request("review", { commitSha: head, event: "APPROVE", artifactId: "review-b", body: "Rechecked repaired head" })); await deployment.idle();
    assert.notEqual(next.key, review.key); assert.equal(store.operations.get(next.source, next.instance, next.key)?.status, "confirmed");
    assert.equal(server.reviews.length, 2);
  }
  engine.worker.read(token, store.tickets.get(ticketId)!.inputs.map(input => input.id));
  engine.worker.report(token, { state: "ready", summary: "fixture worker finished" });
  assert.equal(store.tickets.get(ticketId)!.ended, undefined);
  const merge = deployment.planAndQueue(request("merge", {})); await deployment.idle();
  assert.equal(store.operations.get(merge.source, merge.instance, merge.key)?.status, "confirmed");
  assert.throws(() => deployment.planAndQueue(request("issue-close", { mergeCommit: MERGED, pullNumber: 8 })), /continuation/);
  if (mode === "lost-close") server.fault("PATCH", `${ROOT}/issues/7`, { kind: "drop-after-apply" });
  const continuation = deployment.settlement.closeMergedThread(engine.sources, pull, { ticketId, originIssue: 7, pullThread: pull, closedAt: new Date(now + 1).toISOString(),
    mergeOperation: { source: merge.source, instance: merge.instance, key: merge.key }, closeRequest: request("issue-close", { mergeCommit: MERGED, pullNumber: 8 }) });
  assert.equal(continuation.status, "pending"); await deployment.idle();
  assert.equal(deployment.settlement.get(ticketId)!.status, mode === "strict" ? "failed" : mode === "lost-close" ? "uncertain" : "confirmed");
  assert.equal(store.tickets.get(ticketId)!.ended?.outcome, "merged");
  assert.equal(engine.currentBinding(ticketId), undefined);
  await deployment.stop({ abort: true }); store.close(); store = openShadowStore(file); now += 60_000; deployment = connect();
  deployment.start(); await deployment.idle();
  assert.equal(deployment.settlement.get(ticketId)!.status, mode === "strict" ? "failed" : "confirmed");
  assert.equal(server.requests.filter(row => row.method === "PATCH").length, mode === "strict" ? 0 : 1);
  assert.equal(store.tickets.get(ticketId)!.assignments.length, 1);
});
