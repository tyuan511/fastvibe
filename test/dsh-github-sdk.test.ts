// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { GithubPiDeployment, type GithubPiDeploymentOptions } from "../src/main/bot/shadow/github-pi-deployment.ts";
import { GithubRestTransport } from "../src/main/bot/shadow/github-transport.ts";
import { githubEventToTrigger, registerGithubShadowSource, type GithubSourceConfig } from "../src/main/bot/shadow/github-source.ts";
import { ShadowSourceRegistry } from "../src/main/bot/shadow/source-registry.ts";
import { ShadowCredentialHost } from "../src/main/bot/shadow/credential-host.ts";
import { PiLedger } from "../src/main/bot/shadow/pi-ledger.ts";
import type { PiReviewArtifact, PiReviewInput, PiReviewRecord } from "../src/main/bot/shadow/pi-reviewer.ts";
import { openShadowStore, type Operation } from "../src/main/bot/shadow/store.ts";
import { GithubNativeServer, HEAD, BASE, ROOT } from "./fixtures/vivi-dsh-github-native-server.ts";
import * as gh from "./fixtures/vivi-dsh-github-http.ts";

// Real SDK, domain, SQLite and native HTTP, with offline faux providers and loopback-only fake identities.
// Tool selection is a host capability boundary, not an OS sandbox.
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const timeout = { timeout: 20_000 };
const content = "export const answer = 42;\n";
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tool = (name: string, args: object) => fauxAssistantMessage([fauxToolCall(name, JSON.parse(JSON.stringify(args)))], { stopReason: "toolUse" });
const request = (artifactId = "review-1") => tool("request_review", { artifactId });
const report = () => tool("dsh_report", { state: "ready", summary: "Static review artifact requested; wait for followed PR work and host delivery receipt" });
const artifact = (patch: Partial<PiReviewArtifact> = {}): PiReviewArtifact => ({ artifactId: "review-1", headSha: HEAD, baseSha: BASE,
  findings: [], checks: [{ name: "unit", status: "passed", evidence: "model claim without execution" }], summary: "Inspected complete host diff", verdict: "approve", ...patch });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const deadline = Date.now() + 7_000;
  while (!check()) { if (Date.now() > deadline) throw new Error("GitHub SDK boundary timeout"); await new Promise<void>(done => setImmediate(done)); }
}
async function provider(root: string, name: string, responses: Responses) {
  const faux = createFauxCore({ api: `${name}-api`, provider: name, models: [{ id: "offline" }] }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, `${name}-auth.json`), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(name, { baseUrl: "http://faux.invalid", api: `${name}-api` as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  return { faux, runtime, model: runtime.getModel(name, "offline")! };
}
interface Options { worker?: Responses; reviewer?: Responses; verifiedChecks?: PiReviewInput["verifiedChecks"] }
async function harness(t: TestContext, options: Options = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-github-sdk-")), store = openShadowStore(join(root, "shadow.db"));
  const server = new GithubNativeServer(); await server.start(); server.seedPull();
  let deployment: GithubPiDeployment | undefined;
  t.after(async () => { await deployment?.stop({ abort: true }); store.close(); await server.close(); rmSync(root, { recursive: true, force: true }); });
  const worker = await provider(root, "github-sdk-worker", options.worker ?? [request(), report()]);
  let reviewerTools: string[] = [];
  const reviewer = await provider(root, "github-sdk-reviewer", options.reviewer ?? [context => {
    reviewerTools = getCurrentTools(context.messages).map(item => item.name).sort();
    assert.match(JSON.stringify(context.messages), /HOST_COMPLETE_DIFF/);
    return tool("read_file", { path: "a.ts" });
  }, context => { assert.match(JSON.stringify(context.messages), /export const answer = 42/); return tool("dsh_review", artifact()); }]);
  const config = { ...gh.config, selfLogins: ["agent"], botLogins: ["helper", "reviewer"] };
  const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry); registry.configure("github", { enabled: true, config });
  const credentials = new ShadowCredentialHost(registry);
  for (const [source, id, value] of [["github", "sdk.fake.writer", "fake-writer"], ["github-review", "sdk.fake.reviewer", "fake-reviewer"]] as const) {
    credentials.register({ id, kind: "github" }, { resolve: async () => value }); credentials.bind(source, { id, kind: "github" });
  }
  const transport = (source: string) => new GithubRestTransport({ repository: config.repository, credentials, source, baseUrl: server.baseUrl, loopbackTest: true });
  const policy: Policy = { version: "github-sdk-test", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  let snapshot = { headSha: HEAD, baseSha: BASE }, now = Date.now();
  const deploymentOptions: GithubPiDeploymentOptions = {
    native: { reader: transport("github"), writer: transport("github"), reviewer: transport("github-review"), writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" },
      instance: "desktop", requiredChecks: ["test"], driver: { policy: () => policy, intervalMs: false, now: () => now },
      adapters: { assessment: async () => {}, release: async () => {}, relay: async () => {}, notice: async () => {} } },
    worker: { root, modelRuntime: worker.runtime, model: worker.model, maxWorkers: () => 1, now: () => now,
      recipe: { id: "host-sdk-workspace", run: async ({ cwd }) => { writeFileSync(join(cwd, "a.ts"), content); } },
      reviewer: { modelRuntime: reviewer.runtime, model: reviewer.model, current: () => structuredClone(snapshot), input: (_binding, artifactId) => ({ artifactId, ...snapshot,
        diff: `HOST_COMPLETE_DIFF\ndiff --git a/a.ts b/a.ts\n--- a/a.ts\n+++ b/a.ts\n@@ -1 +1 @@\n-export const answer = 0;\n+${content}`,
        requirements: "Read every changed line; do not claim tests were executed", files: [{ path: "a.ts", version: hash(content) }], verifiedChecks: options.verifiedChecks }) } },
    reviewDelivery: { source: "github", instance: "desktop", repositoryId: 11, target: () => ({ pullNumber: 8, ...snapshot }) }, poll: false,
  };
  deployment = new GithubPiDeployment(store, registry, deploymentOptions);
  const d = deployment, engine = d.native.driver.engine;
  const issue = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", config);
  engine.sources.receive(issue); engine.evaluateDue();
  const candidate = engine.main.candidate(issue.id)!;
  const accepted = engine.main.decide(issue.id, { evalId: candidate.evalId, kind: "accept", title: "Repair DomainIssue", scope: "acme/widget", reason: "explicit offline Issue acceptance" });
  const ticketId = accepted.ticketId!; assert.ok(ticketId);
  d.start(); await d.native.idle();
  const binding = engine.currentBinding(ticketId)!; assert.ok(binding);
  // The minimal native server does not implement comment streams. 410 explicitly records unavailable streams;
  // the actual PR observation and own binding still go through Source's real HTTP poll transaction.
  for (const path of [`${ROOT}/pulls/8/comments`, `${ROOT}/issues/8/comments`, `${ROOT}/issues/7/comments`]) server.fault("GET", path, { kind: "status", status: 410 });
  const polled = await d.native.poll({ targets: [{ id: "host-pr", kind: "issue", path: `${ROOT}/pulls/8` }], bindings: [{ ticketId, branch: "fix/one", repositoryId: 11 }], branches: [] });
  assert.equal(polled.status, "completed", JSON.stringify(polled));
  assert.ok(store.tickets.get(ticketId)!.follows?.some(follow => follow.own && !follow.closed));
  assert.equal(worker.faux.state.callCount, 0);
  const ledger = new PiLedger(store), sessionKey = `worker-${ticketId}`;
  const records = () => store.db.all<{ data: string }>("SELECT data FROM dsh_source_cursors WHERE source='pi-reviewer'").map(row => JSON.parse(row.data) as PiReviewRecord);
  const operations = () => store.db.all<{ data: string }>("SELECT data FROM dsh_operations").map(row => JSON.parse(row.data) as Operation);
  const posts = () => server.requests.filter(row => row.method === "POST" && row.path === `${ROOT}/pulls/8/reviews`);
  const transcript = (key: string) => readFileSync(ledger.session(key)!.sessionFile, "utf8").split("\n").filter(Boolean).map(line => JSON.parse(line));
  let sequence = 0;
  const deliver = async () => {
    now++;
    const trigger = { ...issue, id: `${issue.id}:sdk-${++sequence}`, at: new Date(now).toISOString(), text: "HOST_WORKER_ONLY: review the fixed Issue implementation" };
    engine.sources.receive(trigger); await d.idle(); return trigger;
  };
  return { root, store, server, registry, credentials, d, engine, worker, reviewer, binding, ticketId, ledger, sessionKey, records, operations, posts, transcript, deliver,
    enableAutomaticPoll: () => { deploymentOptions.poll = { targets: [{ id: "host-pr", kind: "issue", path: `${ROOT}/pulls/8` }], branches: [] }; },
    ticket: () => store.tickets.get(ticketId)!, reviewerTools: () => reviewerTools,
    setHead: (headSha: string) => { snapshot = { ...snapshot, headSha }; }, snapshot: () => structuredClone(snapshot) };
}

function assertRejectsReviewIdentity(mutator: (config: { selfLogins: string[]; botLogins: string[] }) => void): void {
  const root = mkdtempSync(join(tmpdir(), "dsh-github-config-")), store = openShadowStore(join(root, "shadow.db"));
  try {
    const registry = new ShadowSourceRegistry(store); registerGithubShadowSource(registry);
    const config = { selfLogins: ["agent"], botLogins: ["reviewer"] };
    mutator(config);
    registry.configure("github", { enabled: true, config: { ...gh.config, ...config } });
    const credentials = new ShadowCredentialHost(registry);
    let reads = 0;
    const transport = (source: string) => {
      const port = new GithubRestTransport({ repository: gh.config.repository, credentials, source, baseUrl: "http://127.0.0.1:1", loopbackTest: true });
      port.read = async () => { reads++; throw new Error("Unexpected GitHub access during constructor rejection"); };
      return port;
    };
    const policy: Policy = { version: "config-rejection", paused: false, evalTimeoutMs: 60_000,
      gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
    assert.throws(() => new GithubPiDeployment(store, registry, {
      native: { reader: transport("github"), writer: transport("github"), reviewer: transport("github-review"), writerIdentity: { id: "1", login: "agent" }, reviewerIdentity: { id: "2", login: "reviewer" },
        instance: "desktop", requiredChecks: [], driver: { policy: () => policy, intervalMs: false, now: () => 1 }, adapters: { assessment: async () => {}, release: async () => {}, relay: async () => {}, notice: async () => {} } },
      worker: { root, get modelRuntime(): never { throw new Error("Unexpected SDK/provider access during constructor rejection"); }, model: undefined as never, maxWorkers: () => 1,
        reviewer: { modelRuntime: undefined as never, model: undefined as never, input: () => ({ artifactId: "unused", headSha: HEAD, baseSha: BASE, diff: "", requirements: "", files: [] }), current: () => ({ headSha: HEAD, baseSha: BASE }) } },
      reviewDelivery: { source: "github", instance: "desktop", repositoryId: 11, target: () => ({ pullNumber: 8, headSha: HEAD, baseSha: BASE }) }, poll: false,
    }), /explicit writer-self and reviewer-bot/);
    assert.equal(reads, 0);
    assert.equal(store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dsh_operations")!.n, 0);
  } finally { store.close(); rmSync(root, { recursive: true, force: true }); }
}

for (const [name, change] of [
  ["missing writer-self", (config: { selfLogins: string[]; botLogins: string[] }) => { config.selfLogins = ["writer-only"]; }],
  ["missing reviewer-bot", (config: { selfLogins: string[]; botLogins: string[] }) => { config.botLogins = ["helper"]; }],
  ["reviewer listed as self", (config: { selfLogins: string[]; botLogins: string[] }) => { config.selfLogins = ["agent", "reviewer"]; }],
] as const) test(`reviewDelivery rejects ${name} before SDK/provider or GitHub access`, () => assertRejectsReviewIdentity(change));

test("automatic poll read failure preserves Source health and does not starve committed SDK inbox", timeout, async t => {
  const h = await harness(t, { worker: [report()] });
  const sweep = h.d.executor.sweep.bind(h.d.executor);
  h.d.executor.sweep = async () => {};
  try { await h.deliver(); } finally { h.d.executor.sweep = sweep; }
  const receipt = h.ledger.list(h.sessionKey)[0]!;
  assert.ok(receipt); assert.equal(receipt.entryId, undefined); assert.equal(receipt.reads.length, 0); assert.equal(h.worker.faux.state.callCount, 0);
  for (let i = 0; i < 12; i++) h.server.fault("GET", `${ROOT}/pulls/8`, { kind: "status", status: 503 });
  h.enableAutomaticPoll();
  await h.d.native.idle(); await h.d.executor.idle();
  assert.equal(h.registry.health("github")?.state, "degraded");
  assert.match(h.registry.health("github")!.detail, /503|Service unavailable/);
  assert.ok(h.ledger.get(h.sessionKey, receipt.requestId)?.reads.length);
  assert.equal(h.worker.faux.state.callCount, 1); assert.equal(h.ticket().assignments[0]?.report?.state, "ready"); assert.equal(h.ticket().ended, undefined);
  assert.equal(h.posts().length, 0);
});

test("own native Review is polled as bot/nonhuman and cannot grant human authorization", timeout, async t => {
  const h = await harness(t); await h.deliver();
  assert.equal(h.posts().length, 1); assert.equal(h.operations()[0]?.status, "confirmed");
  // The minimal server omits these native REST read fields from its POST fixture.
  Object.assign(h.server.reviews[0]!, { submitted_at: new Date().toISOString(), user: { id: 2, login: "reviewer", type: "User" } });
  const classified = githubEventToTrigger({ ...h.server.reviews[0]!, number: 8 }, "github", "desktop", h.registry.instance("github")!.config as unknown as GithubSourceConfig, "review");
  assert.equal(classified.human, false); assert.equal(classified.meta.bot, true); assert.equal(classified.meta.self, false);
  const before = h.ticket();
  const authorizations = () => h.store.db.all("SELECT * FROM dsh_source_cursors WHERE data LIKE '%authorization%' ORDER BY rowid");
  const granted = authorizations();
  for (const path of [`${ROOT}/pulls/8/comments`, `${ROOT}/issues/8/comments`, `${ROOT}/issues/7/comments`]) h.server.fault("GET", path, { kind: "status", status: 410 });
  const result = await h.d.native.poll({ targets: [{ id: "host-pr", kind: "issue", path: `${ROOT}/pulls/8` }], branches: [] });
  assert.equal(result.status, "completed", JSON.stringify(result));
  const reviewTriggers = h.store.db.all<{ data: string }>("SELECT data FROM dsh_triggers WHERE json_extract(data,'$.meta.kind')='review'").map(row => JSON.parse(row.data) as { human: boolean; actor: { id: string }; meta: { kind: string; bot: boolean; self: boolean; actorType: string } });
  assert.equal(reviewTriggers.length, 1);
  assert.deepEqual(reviewTriggers[0]!.meta.actorType, "user"); assert.equal(reviewTriggers[0]!.meta.bot, true); assert.equal(reviewTriggers[0]!.meta.self, false);
  assert.equal(reviewTriggers[0]!.human, false); assert.equal(reviewTriggers[0]!.actor.id, "reviewer");
  assert.deepEqual(h.ticket().mandate, before.mandate); assert.equal(h.ticket().decisionId, before.decisionId);
  assert.deepEqual(authorizations(), granted); assert.equal(h.ticket().assignments.length, 1); assert.equal(h.posts().length, 1);
});

test("active Review cursor SQL ABORT rolls back fanout and commit wake; successful retry delivers bot input to SDK", timeout, async t => {
  const h = await harness(t); await h.deliver();
  Object.assign(h.server.reviews[0]!, { submitted_at: new Date().toISOString(), user: { id: 2, login: "reviewer", type: "User" } });
  h.d.native.driver.setPaused(true); await h.d.idle();
  const sweep = h.d.executor.sweep.bind(h.d.executor);
  h.d.executor.sweep = async () => {};
  const snapshot = () => ({
    triggers: h.store.db.all("SELECT * FROM dsh_triggers ORDER BY rowid"),
    ticket: h.ticket(),
    delivery: h.store.db.all("SELECT * FROM dsh_effects WHERE kind='delivery' ORDER BY seq"),
    cursors: h.store.db.all("SELECT * FROM dsh_source_cursors ORDER BY source,instance,cursor_key"),
    receipts: h.ledger.list(h.sessionKey),
  });
  const before = snapshot(), workerCalls = h.worker.faux.state.callCount, reviewerCalls = h.reviewer.faux.state.callCount;
  const passes = h.d.native.driver.passes, requestPass = passes.request.bind(passes);
  let wakes = 0;
  passes.request = () => { wakes++; requestPass(); };
  // This ABORT can fire only after real active-thread fanout has persisted all three facts.
  h.store.db.exec(`CREATE TRIGGER reject_active_review_cursor BEFORE UPDATE ON dsh_source_cursors
    WHEN NEW.source='github'
      AND EXISTS (SELECT 1 FROM dsh_triggers WHERE json_extract(data,'$.meta.kind')='review')
      AND EXISTS (SELECT 1 FROM dsh_tickets, json_each(dsh_tickets.data,'$.inputs') AS input
        JOIN dsh_triggers ON json_extract(input.value,'$.triggerId')=dsh_triggers.id
        WHERE json_extract(dsh_triggers.data,'$.meta.kind')='review')
      AND EXISTS (SELECT 1 FROM dsh_effects WHERE kind='delivery' AND status='pending')
    BEGIN SELECT RAISE(ABORT,'active review fanout cursor rollback'); END`);
  const poll = async () => {
    for (const path of [`${ROOT}/pulls/8/comments`, `${ROOT}/issues/8/comments`, `${ROOT}/issues/7/comments`]) h.server.fault("GET", path, { kind: "status", status: 410 });
    return h.d.native.poll({ targets: [{ id: "host-pr", kind: "issue", path: `${ROOT}/pulls/8` }], branches: [] });
  };
  try {
    const failed = await poll();
    assert.equal(failed.status, "transient-failure", JSON.stringify(failed));
    assert.match(failed.error!, /active review fanout cursor rollback/);
    await h.d.native.idle();
    assert.deepEqual(snapshot(), before);
    assert.equal(wakes, 0, "rolled-back intake must discard its afterCommit wake");
    assert.equal(h.worker.faux.state.callCount, workerCalls); assert.equal(h.reviewer.faux.state.callCount, reviewerCalls);
    h.store.db.exec("DROP TRIGGER reject_active_review_cursor");
    const succeeded = await poll(); assert.equal(succeeded.status, "completed", JSON.stringify(succeeded));
    const review = h.store.db.get<{ id: string; data: string }>("SELECT id,data FROM dsh_triggers WHERE json_extract(data,'$.meta.kind')='review'")!;
    assert.ok(review); assert.equal(JSON.parse(review.data).human, false); assert.equal(JSON.parse(review.data).meta.bot, true);
    const input = h.ticket().inputs.find(input => input.kind === "trigger" && input.triggerId === review.id)!;
    assert.ok(input && input.kind === "trigger"); assert.equal(input.readAt, undefined);
    assert.ok(h.store.db.get("SELECT 1 FROM dsh_effects WHERE kind='delivery' AND status='pending'"));
    assert.notDeepEqual(snapshot().cursors, before.cursors); assert.ok(wakes > 0);
    assert.equal(h.worker.faux.state.callCount, workerCalls); assert.equal(h.reviewer.faux.state.callCount, reviewerCalls);
    assert.deepEqual(h.ticket().mandate, before.ticket.mandate); assert.equal(h.ticket().decisionId, before.ticket.decisionId);
    h.worker.faux.setResponses([report()]);
    h.d.executor.sweep = sweep;
    h.d.native.driver.setPaused(false); await h.d.idle();
    const delivered = h.ticket().inputs.find(item => item.id === input.id)!;
    assert.ok(delivered.kind === "trigger" && delivered.deliveredTo === h.binding.assignmentId); assert.ok(delivered.readAt);
    assert.ok(h.ledger.list(h.sessionKey).some(receipt => receipt.inputIds.includes(input.id) && receipt.reads.length > 0));
    assert.equal(h.worker.faux.state.callCount, workerCalls + 1); assert.equal(h.reviewer.faux.state.callCount, reviewerCalls);
    assert.equal(h.ticket().assignments[0]?.report?.state, "ready"); assert.equal(h.ticket().ended, undefined); assert.equal(h.posts().length, 1);
  } finally { passes.request = requestPass; h.d.executor.sweep = sweep; }
});

test("real SDK Worker → independent Reviewer → host authorization → native Review HTTP receipt", timeout, async t => {
  const h = await harness(t); await h.deliver();
  const origin = h.store.triggers.get(h.ticket().origin.triggerId)!;
  assert.equal(origin.source, "github"); assert.equal(origin.meta.number, 7);
  assert.equal(h.store.decisions.get(h.ticket().decisionId)?.kind, "accept");
  assert.equal(h.ticket().assignments.length, 1); assert.equal(h.ticket().assignments[0]?.report?.state, "ready"); assert.equal(h.ticket().ended, undefined);
  assert.deepEqual(h.reviewerTools(), ["dsh_review", "read_file"]);
  const receipt = h.ledger.list(h.sessionKey)[0]!;
  assert.ok(receipt.reads.length >= 1); assert.equal(receipt.reports.length, 1);
  assert.ok(h.ticket().inputs.some(input => input.kind === "trigger" && input.readAt));
  const record = h.records()[0]!;
  assert.equal(record.status, "completed"); assert.equal(record.artifact?.checks[0]?.status, "not-run");
  assert.ok(record.evidence?.read.entryId); assert.ok(record.evidence?.toolCallId); assert.notEqual(record.sessionKey, h.sessionKey);
  for (const name of ["read_file", "dsh_review"]) assert.ok(h.transcript(record.sessionKey).some(row => row.message?.role === "toolResult" && row.message.toolName === name));
  const reviewerText = JSON.stringify(h.transcript(record.sessionKey));
  assert.doesNotMatch(reviewerText, /HOST_WORKER_ONLY|fake-writer|fake-reviewer|sdk.fake|dsh_report/);
  const operation = h.operations()[0]!;
  assert.equal(operation.status, "confirmed"); assert.ok(operation.receipt);
  assert.equal(h.posts().length, 1); assert.equal(h.posts()[0]!.actor, "reviewer");
  assert.equal(h.posts()[0]!.body?.commit_id, HEAD); assert.equal(h.posts()[0]!.body?.event, "APPROVE");
  assert.deepEqual(Object.keys(h.posts()[0]!.body!).sort(), ["body", "commit_id", "event"]);
  assert.match(String(h.posts()[0]!.body?.body), /not-run/);
  assert.ok(h.transcript(h.sessionKey).some(row => row.message?.role === "toolResult" && row.message.toolName === "request_review"));
  assert.equal(h.server.requests.filter(row => row.method !== "GET").length, 1);
  assert.deepEqual(h.credentials.bindings().map(binding => binding.ref.id).sort(), ["sdk.fake.reviewer", "sdk.fake.writer"]);
});

test("same head/artifact replay does not redispatch Reviewer or repeat Review POST; new head/artifact permits a new Review", timeout, async t => {
  const h = await harness(t); await h.deliver(); const first = h.operations()[0]!;
  h.worker.faux.setResponses([request(), report()]); await h.deliver();
  assert.equal(h.posts().length, 1); assert.equal(h.reviewer.faux.state.callCount, 2);
  const replay = h.d.planReview(h.binding, "review-1"); assert.equal(replay.id, first.id); await h.d.idle(); assert.equal(h.posts().length, 1);
  const head = "d".repeat(40); h.server.driftHead(head); h.setHead(head);
  h.worker.faux.setResponses([request("review-2"), report()]);
  h.reviewer.faux.setResponses([tool("read_file", { path: "a.ts" }), tool("dsh_review", artifact({ artifactId: "review-2", headSha: head }))]);
  await h.deliver();
  assert.equal(h.posts().length, 2); assert.equal(h.posts()[1]!.body?.commit_id, head);
  assert.equal(h.operations().length, 2); assert.notEqual(h.operations()[1]!.key, first.key);
  assert.ok(h.operations().every(operation => operation.status === "confirmed"));
  assert.notEqual(h.records()[0]!.sessionKey, h.records()[1]!.sessionKey);
});

test("SQL enqueue ABORT rolls back host authorization, operation and Effect while retaining separate completed artifact", timeout, async t => {
  const h = await harness(t);
  h.store.db.exec(`CREATE TRIGGER reject_review_enqueue BEFORE INSERT ON dsh_effects WHEN NEW.kind='source-operation' BEGIN SELECT RAISE(ABORT,'injected review enqueue rollback'); END`);
  await h.deliver();
  assert.equal(h.records()[0]?.status, "completed"); assert.ok(h.records()[0]?.evidence); assert.equal(h.posts().length, 0); assert.equal(h.operations().length, 0);
  assert.equal(h.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dsh_source_cursors WHERE data LIKE '%authorization%'")!.n, 0);
  assert.equal(h.store.db.get<{ n: number }>("SELECT COUNT(*) AS n FROM dsh_effects WHERE kind='source-operation'")!.n, 0);
  assert.throws(() => h.d.planReview(h.binding, "review-1"), /injected review enqueue rollback/);
  assert.equal(h.operations().length, 0);
  h.store.db.exec("DROP TRIGGER reject_review_enqueue");
  h.d.planReview(h.binding, "review-1"); await h.d.idle();
  assert.equal(h.posts().length, 1); assert.equal(h.operations()[0]?.status, "confirmed"); assert.equal(h.reviewer.faux.state.callCount, 2);
});

test("SQL reviewer-running ABORT rolls back prepared SDK receipt and cannot publish a Review", timeout, async t => {
  const h = await harness(t);
  h.store.db.exec(`CREATE TRIGGER reject_reviewer_running BEFORE UPDATE ON dsh_source_cursors WHEN json_extract(NEW.data,'$.status')='running' BEGIN SELECT RAISE(ABORT,'injected reviewer rollback'); END`);
  await h.deliver(); const record = h.records()[0]!;
  assert.equal(record.status, "uncertain"); assert.equal(record.artifact, undefined); assert.equal(record.evidence, undefined);
  assert.equal(h.reviewer.faux.state.callCount, 0); assert.equal(h.ledger.get(record.sessionKey, record.requestId), undefined);
  assert.equal(h.posts().length, 0); assert.equal(h.operations().length, 0);
});

for (const who of ["worker", "reviewer"] as const) test(`${who} assistant prose cannot create or send a structured Review`, timeout, async t => {
  const h = await harness(t, who === "worker" ? { worker: [fauxAssistantMessage(JSON.stringify(artifact()))] } : { reviewer: [fauxAssistantMessage(JSON.stringify(artifact()))] });
  await h.deliver(); assert.equal(h.posts().length, 0); assert.equal(h.operations().length, 0);
  assert.ok(h.ledger.list(h.sessionKey)[0]!.reads.length);
  if (who === "reviewer") { assert.equal(h.records()[0]?.status, "uncertain"); assert.equal(h.records()[0]?.artifact, undefined); }
  else assert.equal(h.records().length, 0);
});

test("a fabricated completed cursor without SDK evidence cannot authorize HTTP Review", timeout, async t => {
  const h = await harness(t, { worker: [fauxAssistantMessage("idle")] }); await h.deliver();
  const fake: PiReviewRecord = { artifactId: "forged", ticketId: h.ticketId, headSha: HEAD, baseSha: BASE, sessionKey: "invented", fingerprint: "invented", binding: h.binding,
    status: "completed", attempt: 1, requestId: "invented", cancelRequested: false, artifact: artifact({ artifactId: "forged" }) };
  assert.equal(h.store.cursors.save("pi-reviewer", "sdk", hash([h.ticketId, "forged"]), fake, 0), true);
  assert.throws(() => h.d.planReview(h.binding, "forged"), /evidence/); await h.d.idle();
  assert.equal(h.posts().length, 0); assert.equal(h.operations().length, 0);
});

for (const change of ["head", "stop"] as const) test(`${change} during independent Reviewer provider fences late artifact and Review POST`, timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, { reviewer: [tool("read_file", { path: "a.ts" }), async () => { await gate.promise; return tool("dsh_review", artifact()); }] });
  const running = h.deliver(); await until(() => h.reviewer.faux.state.callCount === 2);
  assert.ok(h.ledger.list(h.sessionKey)[0]!.reads.length); assert.equal(h.posts().length, 0);
  if (change === "head") { h.setHead("d".repeat(40)); h.server.driftHead("d".repeat(40)); }
  else h.engine.people.stopTicket(h.ticketId, "human Stop while Reviewer is pending");
  gate.resolve(); await running; await h.d.idle();
  assert.equal(h.records()[0]?.artifact, undefined); assert.equal(h.posts().length, 0); assert.equal(h.operations().length, 0);
  if (change === "stop") {
    assert.equal(h.ticket().ended?.outcome, "stopped"); assert.equal(h.d.executor.slots.used(), 0);
    assert.equal(h.store.get(`pi:owner:${h.records()[0]!.sessionKey}`), null); assert.equal(h.store.get(`pi:owner:${h.sessionKey}`), null);
  }
});

test("already completed artifact becomes stale when host target head changes", timeout, async t => {
  const h = await harness(t); await h.deliver(); h.setHead("d".repeat(40)); h.server.driftHead("d".repeat(40));
  assert.throws(() => h.d.planReview(h.binding, "review-1"), /evidence/); await h.d.idle(); assert.equal(h.posts().length, 1);
});

for (const reason of ["failed-check", "high-finding"] as const) test(`${reason} overrides model APPROVE with REQUEST_CHANGES`, timeout, async t => {
  const checks = [{ name: "unit", status: "failed" as const, evidence: "host exit=1 at fixed head" }];
  const h = await harness(t, { verifiedChecks: reason === "failed-check" ? checks : undefined,
    reviewer: [tool("read_file", { path: "a.ts" }), tool("dsh_review", artifact({ findings: reason === "high-finding" ? [{ severity: "high", path: "a.ts", line: 1, message: "Host requirement violated" }] : [] }))] });
  await h.deliver(); assert.equal(h.posts().length, 1); assert.equal(h.posts()[0]!.body?.event, "REQUEST_CHANGES"); assert.equal(h.operations()[0]?.status, "confirmed");
  if (reason === "failed-check") assert.deepEqual(h.records()[0]!.artifact?.checks, checks);
});
