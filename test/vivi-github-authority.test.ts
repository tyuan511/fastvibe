import assert from "node:assert/strict";
import test from "node:test";
import { GithubOperationAuthority } from "../src/main/bot/shadow/github-authority.ts";
import { GithubOperationDryRun, type GithubOperationRequest } from "../src/main/bot/shadow/github-operation.ts";
import { ShadowEngine } from "../src/main/bot/shadow/engine.ts";
import { registerGithubShadowSource } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { GithubTestDeployment } from "../src/main/bot/shadow/github-deployment.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { GithubTestServer } from "./fixtures/vivi-github-server.ts";

function fixture(t: test.TestContext) {
  const store = openShadowStore(); const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
  const config = { repository: { id: 11, owner: "acme", name: "widget", fullName: "acme/widget" }, selfLogins: ["agent"] };
  registry.configure("github", { enabled: true, config });
  let policy: Policy = { version: "v1", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  const engine = new ShadowEngine(store, { policy: () => policy, scope: registry, now: () => 1000 });
  engine.sources.receive({ id: "issue", source: "github", threads: [{ source: "github", id: "issue-7" }], actor: { source: "github", id: "alice" },
    human: true, addressed: "mention", at: new Date(1000).toISOString(), text: "fix", meta: { repositoryId: "11", instance: "desktop" } });
  engine.evaluateDue(); const candidate = engine.main.candidate("issue")!; assert.ok(candidate);
  const accepted = engine.main.decide("issue", { evalId: candidate.evalId, kind: "accept", title: "fix", scope: "repo 11", reason: "explicit" });
  assert.ok(accepted.ticketId); const ticket = store.tickets.get(accepted.ticketId)!;
  const claim = store.effects.claim("launch", ticket.assignments[0]!.id, "host", 1000, 1000)!;
  const token = engine.completeLaunch(claim)!; assert.ok(token);
  const authority = new GithubOperationAuthority(store, registry, engine, () => policy);
  const authorization = authority.grant(token, "github", "desktop", "11", ["branch", "merge", "review"]);
  const request: GithubOperationRequest = { source: "github", instance: "desktop", repositoryId: "11", kind: "merge", object: { pullNumber: 8 }, params: {}, authorization,
    preconditions: { currentState: "open", headSha: "a".repeat(40), baseSha: "b".repeat(40) } };
  const planner = new GithubOperationDryRun(store, registry, "github", "desktop");
  t.after(() => store.close());
  return { store, registry, authority, engine, token, authorization, request, planner, config, policy: (patch: Partial<Policy>) => { policy = { ...policy, ...patch }; } };
}

test("host operation authority binds persisted Decision/Mandate and exact Worker token", t => {
  const f = fixture(t); const plan = f.planner.plan(f.request); f.authority.authorize(plan);
  assert.deepEqual(f.authority.grant(f.token, "github", "desktop", "11", ["merge", "review", "branch"]), f.authorization);
  assert.throws(() => f.authority.grant(f.token, "github", "desktop", "11", ["pull"]), /不可扩大/);
  assert.throws(() => f.authority.grant(f.token, "github", "desktop", "11", ["issue-close"]), /continuation/);
  assert.throws(() => f.authority.grant({ ...f.token, claimToken: f.token.claimToken + 1 }, "github", "desktop", "11", ["merge"]), /binding/);
  assert.throws(() => f.authority.authorize({ ...plan, payload: { ...plan.payload, authorization: { ...f.authorization, allowed: ["merge", "pull"] } } }), /宿主授权/);
  assert.equal(f.authorization.mandateId, f.store.tickets.get(f.token.ticketId)!.decisionId);
});

for (const change of ["stop", "source", "policy", "paused", "revalidate", "binding"] as const) test(`write authority rechecks durable ${change} before request`, t => {
  const f = fixture(t); const plan = f.planner.plan(f.request);
  if (change === "stop") f.engine.people.stopTicket(f.token.ticketId, "user stop");
  if (change === "source") f.registry.configure("github", { enabled: true, config: f.config });
  if (change === "policy") f.policy({ version: "v2" });
  if (change === "paused") f.policy({ paused: true });
  if (change === "revalidate") f.policy({ revalidate: () => false });
  if (change === "binding") f.engine.worker.interrupted(f.token);
  assert.throws(() => f.authority.authorize(plan), /已失效/);
  assert.equal(f.store.operations.get(plan.source, plan.instance, plan.key)?.status, "planned");
});

test("authority profile and grant roll back with outer transaction", t => {
  const f = fixture(t); f.store.db.run("DELETE FROM vivi_source_cursors");
  assert.throws(() => f.store.atomic(() => { f.authority.grant(f.token, "github", "desktop", "11", ["merge"]); throw new Error("abort grant"); }), /abort grant/);
  assert.equal(f.store.db.countRows("vivi_source_cursors"), 0);
});

for (const stop of [false, true]) test(`HTTP write revalidates the domain after async credential lookup, stop=${stop}`, async t => {
  const f = fixture(t); const server = new GithubTestServer(); await server.start();
  let entered!: () => void, release!: () => void;
  const waiting = new Promise<void>(resolve => { entered = resolve; });
  const gate = new Promise<void>(resolve => { release = resolve; });
  const credentials = new ShadowCredentialHost(f.registry);
  credentials.register({ id: "authority.test", kind: "github" }, { resolve: async () => { entered(); await gate; return "loopback-only-secret"; } });
  credentials.bind("github", { id: "authority.test", kind: "github" });
  const deployment = new GithubTestDeployment(f.store, f.registry, credentials, {
    baseUrl: server.baseUrl, instance: "desktop", now: () => 1000, authorize: op => f.authority.authorize(op),
  });
  try {
    const plan = deployment.planAndQueue({ ...f.request, kind: "branch", object: { branch: "fix/authority" }, params: { baseSha: "a".repeat(40) }, preconditions: {} });
    deployment.start(); await waiting;
    if (stop) f.engine.people.stopTicket(f.token.ticketId, "stop while resolving credential");
    release(); await deployment.idle();
    assert.equal(server.requests.filter(row => row.method === "POST").length, stop ? 0 : 1);
    assert.equal(f.store.operations.get(plan.source, plan.instance, plan.key)?.status, stop ? "uncertain" : "confirmed");
    if (stop) assert.equal(f.store.tickets.get(f.token.ticketId)?.ended?.outcome, "stopped");
  } finally { release(); await deployment.stop({ abort: true }); await server.close(); }
});
