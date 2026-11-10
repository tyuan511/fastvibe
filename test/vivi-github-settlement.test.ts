import assert from "node:assert/strict";
import test from "node:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { ShadowEffects } from "../src/main/bot/shadow/effects.ts";
import { GithubOperationDryRun, type GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { GithubIssueSettlement, type GithubMergeSettlementEvidence } from "../src/main/bot/shadow/github-settlement.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowOperations } from "../src/main/bot/shadow/operations.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";

function fixture(t: test.TestContext, file = ":memory:", result: "confirmed" | "failed" | "unknown" = "confirmed", metaPatch: Record<string, unknown> = {}) {
  const store = openShadowStore(file);
  t.after(() => store.close());
  const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  registry.configure("github", { enabled: true, config: { repository: { id: 11, owner: "acme", name: "widget" } } });
  let allowed = true;
  const policy: Policy = { version: "v1", paused: false, evalTimeoutMs: 60_000, gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => allowed, admitsInferred: () => true };
  const engine = new ShadowEngine(store, { policy: () => policy, scope: registry, now: () => 1700000000000 });
  const effects = new ShadowEffects(store);
  let writes = 0, reads = 0;
  const operations = new ShadowOperations(store, effects, {
    execute: async () => { writes++; if (result === "unknown") throw new Error("lost response"); return { status: result }; },
    inspect: async () => { reads++; return { status: "unknown" }; },
  });
  const settlement = new GithubIssueSettlement(store, operations, { policy: () => policy, registry });
  const issue = { source: "github", id: "github:github:github:11:thread:7" };
  const pullThread = { source: "github", id: "github:github:github:11:thread:8" };
  engine.sources.receive({ id: "origin", source: "github", threads: [issue], actor: { source: "github", id: "alice" }, human: true, at: "2023-11-14T22:13:20.000Z", text: "fix", meta: { kind: "issue", number: 7, repositoryId: "11", instance: "github", ...metaPatch } });
  engine.evaluateDue();
  const decision = engine.main.decide("origin", { kind: "accept", title: "Fix", scope: "issue", reason: "requested" });
  const ticket = store.tickets.get(decision.ticketId!)!;
  engine.sources.bindThread(ticket.id, pullThread, true);
  const claim = store.effects.claim("launch", ticket.assignments[0]!.id, "test", 1700000000000, 30000)!;
  const token = engine.completeLaunch(claim)!;
  const delivery = store.effects.claim("delivery", ticket.id, "test", 1700000000000, 30000);
  if (delivery) engine.completeDelivery(delivery, token);
  engine.worker.report(token, { state: "ready", summary: "ready" });
  const authorization: GithubOperationRequest["authorization"] = { source: "github", instance: "github", repositoryId: "11", ticketId: ticket.id, mandateId: ticket.decisionId, generation: 1, allowed: ["merge", "issue-close"] };
  const planner = new GithubOperationDryRun(store, registry);
  const merge = planner.plan({ kind: "merge", source: "github", instance: "github", repositoryId: 11, object: { pullNumber: 8 }, params: {}, authorization, preconditions: { currentState: "open", headSha: "a".repeat(40), baseSha: "b".repeat(40) } });
  const evidence: GithubMergeSettlementEvidence = { closedAt: "2023-11-14T22:13:21.000Z", ticketId: ticket.id, originIssue: 7, pullThread, mergeOperation: { source: merge.source, instance: merge.instance, key: merge.key }, closeRequest: { kind: "issue-close", source: "github", instance: "github", repositoryId: 11, object: { issueNumber: 7 }, params: { mergeCommit: "d".repeat(40) }, authorization, preconditions: { currentState: "open", issueVersion: 1 } } };
  const confirm = () => assert.equal(store.operations.transition(merge, "confirmed", { body: { merged: true, sha: "d".repeat(40) } }), true);
  const close = () => settlement.closeMergedThread(engine.sources, pullThread, evidence);
  return { store, engine, operations, effects, registry, policy, settlement, ticket, evidence, merge, confirm, close, calls: () => ({ writes, reads }), revoke: () => { allowed = false; } };
}

test("atomic closure + registration is idempotent and drift is rejected", t => {
  const h = fixture(t); h.confirm();
  const first = h.close(); assert.equal(first.status, "pending");
  assert.equal(h.store.tickets.get(h.ticket.id)!.ended?.outcome, "merged");
  assert.deepEqual(h.settlement.register(h.evidence), first);
  const drift = structuredClone(h.evidence); drift.closeRequest.authorization.generation++;
  assert.throws(() => h.settlement.register(drift));
  assert.equal(h.store.db.countRows("vivi_operations"), 2);
  assert.equal(h.store.db.all("SELECT * FROM vivi_effects WHERE kind='source-operation'").length, 1);
});

test("SQL ABORT enqueue rolls back closure, continuation and planner plan", t => {
  const h = fixture(t); h.confirm();
  h.store.db.exec("CREATE TRIGGER reject_close BEFORE INSERT ON vivi_effects WHEN NEW.kind='source-operation' BEGIN SELECT RAISE(ABORT,'enqueue rejected'); END");
  assert.throws(h.close, /enqueue rejected/);
  assert.equal(h.store.tickets.get(h.ticket.id)!.ended, undefined);
  assert.equal(h.store.tickets.get(h.ticket.id)!.follows![0]!.closed, undefined);
  assert.equal(h.settlement.get(h.ticket.id), undefined);
  assert.equal(h.store.db.countRows("vivi_operations"), 1);
});

test("rejects stopped, unmerged closure, unconfirmed merge and wrong origins or SHA", async t => {
  for (const scenario of ["stop", "closed", "unconfirmed", "origin", "sha", "policy", "ticket", "mandate", "repo", "pull"] as const) {
    await t.test(scenario, sub => {
      const h = fixture(sub); if (scenario !== "unconfirmed") h.confirm();
      if (scenario === "stop") h.engine.people.stopTicket(h.ticket.id);
      else h.engine.sources.threadClosed(h.evidence.pullThread, scenario === "closed" ? "closed" : "merged", "2023-11-14T22:13:21.000Z");
      if (scenario === "origin") h.evidence.originIssue = 9;
      if (scenario === "sha") h.evidence.closeRequest.params.mergeCommit = "e".repeat(40);
      if (scenario === "policy") h.revoke();
      if (scenario === "ticket") h.evidence.closeRequest.authorization.ticketId = "wrong";
      if (scenario === "mandate") h.evidence.closeRequest.authorization.mandateId = "wrong";
      if (scenario === "repo") h.evidence.closeRequest.repositoryId = 99;
      if (scenario === "pull") h.evidence.pullThread.id = "github:github:github:11:thread:9";
      assert.throws(() => h.settlement.register(h.evidence));
      assert.equal(h.settlement.get(h.ticket.id), undefined);
    });
  }
});

test("projection derives failed/confirmed/cancelled without changing merged Ticket", async t => {
  for (const status of ["failed", "confirmed", "cancelled"] as const) await t.test(status, sub => {
    const h = fixture(sub); h.confirm(); const view = h.close();
    if (status === "cancelled") h.settlement.cancel(h.ticket.id);
    else h.store.operations.transition(view.operation, status, { applied: status === "confirmed" });
    assert.equal(h.settlement.get(h.ticket.id)!.status, status);
    assert.equal(h.store.tickets.get(h.ticket.id)!.ended?.outcome, "merged");
  });
});

test("origin metadata must describe the actual Issue repository, instance and number", async t => {
  for (const meta of [{ repositoryId: "99" }, { instance: "foreign" }, { number: 9 }, { kind: "pull" }, { isPr: true }]) {
    await t.test(JSON.stringify(meta), sub => {
      const h = fixture(sub, ":memory:", "confirmed", meta); h.confirm();
      assert.throws(h.close);
      assert.equal(h.store.tickets.get(h.ticket.id)!.ended, undefined);
    });
  }
});

test("close executes after worker ended; failure preserves merged and unknown cancellation only inspects", async t => {
  for (const result of ["failed", "confirmed", "unknown"] as const) await t.test(result, async sub => {
    const h = fixture(sub, ":memory:", result); h.confirm(); h.close();
    assert.equal(h.engine.currentBinding(h.ticket.id), undefined);
    const assignments = h.store.tickets.get(h.ticket.id)!.assignments;
    h.effects.start(); await h.effects.idle();
    assert.equal(h.settlement.get(h.ticket.id)!.status, result === "unknown" ? "uncertain" : result);
    if (result === "unknown") {
      assert.equal(h.settlement.cancel(h.ticket.id).status, "uncertain");
      await h.effects.idle();
      assert.equal(h.settlement.get(h.ticket.id)!.status, "uncertain");
      assert.deepEqual(h.calls(), { writes: 1, reads: 1 });
    }
    assert.deepEqual(h.store.tickets.get(h.ticket.id)!.assignments, assignments);
    assert.equal(h.store.tickets.get(h.ticket.id)!.ended?.outcome, "merged");
    await h.effects.drain();
  });
});

test("authorize fences current policy, Source revision, cancellation, intent and merged instance", async t => {
  for (const scenario of ["ok", "policy", "paused", "source", "revision", "cancel", "intent", "reopen", "assignment", "binding"] as const) await t.test(scenario, sub => {
    const h = fixture(sub); h.confirm(); const view = h.close();
    assert.equal(view.closedAt, h.evidence.closedAt);
    assert.equal(view.decisionId, h.ticket.decisionId);
    assert.equal(view.policyVersion, "v1");
    if (scenario === "policy") h.revoke();
    if (scenario === "paused") h.policy.paused = true;
    if (scenario === "source") h.registry.setStatus("github", "disabled");
    if (scenario === "revision") h.registry.setStatus("github", "enabled");
    if (scenario === "cancel") h.settlement.cancel(h.ticket.id);
    if (scenario === "intent") (view.operation.payload as { params: Record<string, unknown> }).params.mergeCommit = "e".repeat(40);
    if (scenario === "reopen") h.engine.sources.receive({ id: "followup", source: "github", threads: [h.evidence.pullThread], actor: { source: "github", id: "alice" }, human: true, at: "2023-11-14T22:13:22.000Z", text: "more work", meta: {} });
    if (scenario === "assignment" || scenario === "binding") {
      const drift = structuredClone(h.evidence);
      if (scenario === "assignment") drift.closeRequest.authorization.assignmentId = "different";
      else drift.closeRequest.authorization.bindingClaim = 99;
      assert.throws(() => h.settlement.register(drift));
      return;
    }
    if (scenario === "ok") assert.doesNotThrow(() => h.settlement.authorize(view.operation));
    else assert.throws(() => h.settlement.authorize(view.operation));
  });
});

test("reopen preserves intent and uncertain cancellation never erases unknown", t => {
  const dir = mkdtempSync(join(tmpdir(), "vivi-settlement-")); t.after(() => rmSync(dir, { recursive: true, force: true }));
  const file = join(dir, "shadow.db"); const h = fixture(t, file); h.confirm(); const view = h.close();
  assert.equal(h.store.operations.transition(view.operation, "uncertain"), true);
  const cancelled = h.settlement.cancel(h.ticket.id); assert.equal(cancelled.status, "uncertain");
  const reopened = openShadowStore(file); t.after(() => reopened.close());
  const effects = new ShadowEffects(reopened);
  const ops = new ShadowOperations(reopened, effects, { execute: async () => { throw new Error("must not execute"); }, inspect: async () => ({ status: "unknown" }) });
  const restored = new GithubIssueSettlement(reopened, ops, { policy: () => ({ version: "v1", paused: false, evalTimeoutMs: 1, gate: () => ({ admissible: false, reason: "no" }), revalidate: () => true, admitsInferred: () => false }), registry: new ShadowSourceRegistry(reopened) });
  assert.equal(restored.get(h.ticket.id)!.status, "uncertain");
  assert.equal(ops.get(view.operation.source, view.operation.instance, view.operation.key)!.cancelRequested, true);
  assert.equal(reopened.tickets.get(h.ticket.id)!.ended?.outcome, "merged");
});
