import assert from "node:assert/strict";
import test, { type TestContext } from "node:test";
import { createHash } from "node:crypto";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createFauxCore, fauxAssistantMessage, fauxToolCall, getCurrentTools, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { Policy } from "../src/main/bot/core/ports.ts";
import { ShadowDriver, DeliveryRejected } from "../src/main/bot/shadow/driver.ts";
import { PiExecutor, type PiExecutorOptions } from "../src/main/bot/shadow/pi-executor.ts";
import { PiLedger } from "../src/main/bot/shadow/pi-ledger.ts";
import type { PiReviewArtifact, PiReviewRecord } from "../src/main/bot/shadow/pi-reviewer.ts";
import { githubEventToTrigger } from "../src/main/bot/shadow/github-source.ts";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { initialClock, openCrashHost } from "./fixtures/dsh-sdk-executor-crash.ts";
import * as gh from "./fixtures/vivi-dsh-github-http.ts";

// Real Driver, SQLite, SDK and isolated ModelRuntime; every provider response is offline.
type Responses = Parameters<ReturnType<typeof createFauxCore>["setResponses"]>[0];
const timeout = { timeout: 20_000 };
const head1 = "a".repeat(40), head2 = "c".repeat(40), base = "b".repeat(40);
const hash = (value: unknown) => createHash("sha256").update(JSON.stringify(value)).digest("hex");
const tool = (name: string, args: Record<string, unknown>) => fauxAssistantMessage([fauxToolCall(name, JSON.parse(JSON.stringify(args)))], { stopReason: "toolUse" });
const ready = () => tool("dsh_report", { state: "ready", summary: "workspace inspected and ready for followed work" });
function deferred() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean) {
  const end = Date.now() + 7_000;
  while (!check()) { if (Date.now() > end) throw new Error("Executor boundary timeout"); await new Promise<void>(done => setImmediate(done)); }
}
async function provider(root: string, name: string, responses: Responses) {
  const faux = createFauxCore({ api: `${name}-api`, provider: name, models: [{ id: "offline" }] }); faux.setResponses(responses);
  const runtime = await ModelRuntime.create({ authPath: join(root, `${name}-auth.json`), modelsPath: null, modelsStore: new InMemoryModelsStore(), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerProvider(name, { baseUrl: "http://faux.invalid", api: `${name}-api` as never, apiKey: "unused", streamSimple: faux.streamSimple as never,
    models: [{ id: "offline", name: "offline", reasoning: false, input: ["text"], cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 }, contextWindow: 100_000, maxTokens: 4096 }] });
  return { faux, runtime, model: runtime.getModel(name, "offline")! };
}
interface HarnessOptions { delivery?: "reject" | "rollback"; reviewer?: (root: string) => Promise<NonNullable<PiExecutorOptions["reviewer"]>> }
async function harness(t: TestContext, responses: Responses = [fauxAssistantMessage("idle")], options: HarnessOptions = {}) {
  const root = mkdtempSync(join(tmpdir(), "dsh-sdk-executor-")), store = openShadowStore(join(root, "shadow.db"));
  let now = Date.now(), autoSweep = false;
  const worker = await provider(root, "executor-worker", responses);
  const policy: Policy = { version: "executor-test", paused: false, evalTimeoutMs: 60_000,
    gate: () => ({ admissible: true, strength: "explicit", basis: { via: "listed" } }), revalidate: () => true, admitsInferred: () => true };
  let driver!: ShadowDriver;
  const executor = new PiExecutor({ store, root, engine: () => driver.engine, enabled: () => !driver.paused(), maxWorkers: () => 1,
    now: () => now, modelRuntime: worker.runtime, model: worker.model, reviewer: await options.reviewer?.(root) });
  driver = new ShadowDriver(store, { policy: () => policy, scope: { scope: () => ({ listened: true, observed: false }) }, now: () => now,
    intervalMs: false, beforePass: () => autoSweep ? executor.sweep() : undefined }, {
    ...executor.adapters, assessment: async () => {}, relay: async () => {}, notice: async () => {}, release: async () => {},
    delivery: async (...args) => { if (options.delivery === "reject") throw new DeliveryRejected("explicit offline refusal"); await executor.adapters.delivery!(...args); },
  });
  // The source event, Eval, Decision, Ticket and binding are all created by the real domain.
  const issue = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", gh.config);
  driver.engine.sources.receive(issue); driver.engine.evaluateDue();
  const candidate = driver.engine.main.candidate(issue.id)!;
  const result = driver.engine.main.decide(issue.id, { evalId: candidate.evalId, kind: "accept", title: "SDK issue repair", scope: "acme/widget", reason: "explicit offline Issue" });
  const ticketId = result.ticketId!; assert.ok(ticketId);
  driver.engine.sources.bindThread(ticketId, { source: "github", id: "acme/widget/pull/8" }, true);
  driver.start(); await driver.idle();
  const binding = driver.engine.currentBinding(ticketId)!; assert.ok(binding, "real launch must commit its binding");
  const ledger = new PiLedger(store), sessionKey = `worker-${ticketId}`;
  const messages = () => readFileSync(ledger.session(sessionKey)!.sessionFile, "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
  const ticket = () => store.tickets.get(ticketId)!;
  if (options.delivery === "rollback") store.db.exec(`CREATE TRIGGER reject_delivery_commit BEFORE UPDATE ON dsh_tickets
    WHEN json_array_length(json_extract(OLD.data,'$.undelivered'))>0 AND json_array_length(json_extract(NEW.data,'$.undelivered'))=0
    BEGIN SELECT RAISE(ABORT,'injected delivery rollback'); END`);
  let next = 0;
  const deliver = async (text = "repair the Issue in the dedicated workspace") => {
    now++;
    const trigger = { ...issue, id: `${issue.id}:follow-${++next}`, at: new Date(now).toISOString(), text };
    driver.engine.sources.receive(trigger); await driver.idle(); return trigger;
  };
  const run = async () => { autoSweep = true; await driver.idle(); await executor.sweep(); await executor.idle(); await driver.idle(); };
  t.after(async () => { await driver.stop({ abort: true }); await executor.stop().catch(() => {}); store.close(); rmSync(root, { recursive: true, force: true }); });
  return { root, store, worker, driver, executor, binding, ledger, sessionKey, ticketId, ticket, messages, deliver, run,
    tick: (ms: number) => { now += ms; }, users: () => messages().filter(row => row.type === "message" && row.message.role === "user") };
}

test("Stop waits for the entire recipe-await launch; no late Session or slot survives and a new Ticket can launch", timeout, async t => {
  const root = mkdtempSync(join(tmpdir(), "dsh-executor-stop-recipe-")), gate = deferred(), entered = deferred();
  let first = true, recipeExited = false, recipeSignal: AbortSignal | undefined;
  const stopEntered = deferred(); let stopped = false, stopping: Promise<void> | undefined;
  const h = await openCrashHost(root, { observeStop: completion => {
    stopping = completion.then(() => { stopped = true; }); stopEntered.resolve();
  }, recipe: { id: "blocked-offline-recipe", run: async context => {
    if (!first) return; first = false; recipeSignal = context.signal; entered.resolve();
    await gate.promise; recipeExited = true;
  } } });
  t.after(async () => { gate.resolve(); await h.close(); rmSync(root, { recursive: true, force: true }); });
  const accept = (suffix: string) => {
    const number = suffix === "first" ? 100 : 200;
    const event = githubEventToTrigger({ type: "issues", issue: { ...gh.issue, id: gh.issue.id + number, number,
      html_url: `https://github.com/acme/widget/issues/${number}`, url: `https://api.github.com/repos/acme/widget/issues/${number}` }, repository: gh.repository }, "github", "desktop", gh.config);
    event.id += `:${suffix}`;
    h.driver.engine.sources.receive(event); h.driver.engine.evaluateDue();
    const candidate = h.driver.engine.main.candidate(event.id)!;
    return h.driver.engine.main.decide(event.id, { evalId: candidate.evalId, kind: "accept", title: `Stop recipe ${suffix}`, scope: "acme/widget", reason: "offline launch fence" }).ticketId!;
  };
  const ticketId = accept("first"); h.driver.start(); await entered.promise;
  assert.equal(h.executor.slots.used(), 1); assert.equal(h.ledger.session(`worker-${ticketId}`), undefined);
  h.driver.engine.people.stopTicket(ticketId, "Stop during recipe await");
  // Observe the actual Driver Stop adapter promise, independently of Driver.idle
  // (which also waits for launch and could hide a prematurely completed Stop).
  await stopEntered.promise;
  await new Promise<void>(done => setImmediate(done));
  const completedBeforeRecipe = stopped;
  gate.resolve(); await stopping; await h.driver.idle(); await h.executor.idle();
  assert.equal(completedBeforeRecipe, false, "Stop must remain pending until recipe exits");
  assert.equal(recipeExited, true); assert.equal(recipeSignal?.aborted, true);
  assert.equal(h.store.tickets.get(ticketId)!.ended?.outcome, "stopped");
  assert.equal(h.executor.slots.used(), 0); assert.notEqual(h.executor.record(ticketId)?.state, "opened");
  assert.equal(h.ledger.session(`worker-${ticketId}`), undefined, "late launch must not open the SDK Session");
  assert.equal(h.faux.state.callCount, 0);
  const next = accept("second"); await h.driver.idle();
  assert.ok(h.driver.engine.currentBinding(next)); assert.equal(h.executor.record(next)?.state, "opened");
  assert.equal(h.executor.slots.used(), 1); assert.equal(h.faux.state.callCount, 0);
});

test("expired preparing slot is released only after the recipe actually returns, without opening SDK", timeout, async t => {
  const root = mkdtempSync(join(tmpdir(), "dsh-executor-expired-prepare-")), gate = deferred(), entered = deferred();
  const h = await openCrashHost(root, { recipe: { id: "expiry-recipe", run: async () => { entered.resolve(); await gate.promise; } } });
  t.after(async () => { gate.resolve(); await h.close(); rmSync(root, { recursive: true, force: true }); });
  const trigger = githubEventToTrigger({ type: "issues", issue: gh.issue, repository: gh.repository }, "github", "desktop", gh.config);
  h.driver.engine.sources.receive(trigger); h.driver.engine.evaluateDue();
  const candidate = h.driver.engine.main.candidate(trigger.id)!;
  const decision = h.driver.engine.main.decide(trigger.id, { evalId: candidate.evalId, kind: "accept", title: "expired prepare", scope: "acme/widget", reason: "lease fence" });
  h.driver.start(); await entered.promise; h.tick(60_001);
  assert.equal(h.executor.slots.used(), 1, "expiry alone does not prove the recipe quiet");
  gate.resolve(); await h.driver.idle();
  assert.equal(h.executor.slots.used(), 0);
  assert.equal(h.ledger.session(`worker-${decision.ticketId}`), undefined);
  assert.equal(h.faux.state.callCount, 0);
  assert.notEqual(h.store.effects.get("launch", h.store.tickets.get(decision.ticketId!)!.assignments.at(-1)!.id)?.status, "done");
});

test("real launch and delivery commit prepare durably; only post-commit sweep activates provider once", timeout, async t => {
  const h = await harness(t, [context => { assert.deepEqual(h.ticket().undelivered, []); return fauxAssistantMessage("idle"); }]);
  assert.equal(h.worker.faux.state.callCount, 0); assert.equal(h.executor.record(h.ticketId)?.state, "opened");
  assert.equal(h.executor.slots.used(), 1); assert.deepEqual(h.users(), []);
  const trigger = await h.deliver();
  const input = h.ticket().inputs.find(item => item.kind === "trigger" && item.triggerId === trigger.id)!;
  assert.equal(input.kind === "trigger" && input.deliveredTo, h.binding.assignmentId);
  assert.equal(input.kind === "trigger" && input.readAt, null);
  assert.deepEqual(h.ticket().undelivered, []); assert.equal(h.store.effects.get("delivery", h.ticketId)?.status, "done");
  const receipt = h.ledger.list(h.sessionKey)[0]!;
  assert.equal(receipt.stage, "accepted"); assert.equal(receipt.entryId, undefined); assert.equal(h.worker.faux.state.callCount, 0); assert.deepEqual(h.users(), []);
  await Promise.all([h.executor.sweep(), h.executor.sweep(), h.executor.sweep()]); await h.executor.idle();
  assert.equal(h.worker.faux.state.callCount, 1); assert.equal(h.users().length, 1);
  assert.ok(h.ticket().inputs.some(item => item.kind === "trigger" && item.readAt));
  await h.executor.sweep(); await h.executor.idle(); assert.equal(h.worker.faux.state.callCount, 1);
  assert.equal(h.executor.slots.used(), 0); assert.equal(h.ticket().assignments.at(-1)?.state, "running");
  assert.ok(h.ticket().assignments.at(-1)?.idleAt); assert.equal(h.ticket().ended, undefined);
  const assignment = h.ticket().assignments.at(-1)!;
  assert.equal(assignment.report?.state, "waiting");
  assert.equal(assignment.report?.summary, "Worker ended without a final structured status report. Request its status before treating the assignment as complete.");
  assert.deepEqual(h.ledger.list(h.sessionKey)[0]!.reports, []);
  assert.doesNotMatch(JSON.stringify(h.messages()), /fastvibe-dsh-report/);
  const snapshot = structuredClone(assignment);
  const idleKeys = () => h.store.db.all<{ key: string }>("SELECT key FROM dsh_kv WHERE key LIKE 'pi:executor-idle:%'");
  assert.equal(idleKeys().length, 1);
  await Promise.all([h.executor.sweep(), h.executor.sweep()]); await h.executor.idle();
  assert.deepEqual(h.ticket().assignments.at(-1), snapshot); assert.equal(idleKeys().length, 1);
});

test("SDK provider error yields a fixed domain failed status without mirroring raw error or fabricating PiReport", timeout, async t => {
  const raw = "offline-provider-private-detail token=faux-sensitive-value";
  const h = await harness(t, [fauxAssistantMessage("", { stopReason: "error", errorMessage: raw })]);
  await h.deliver(); await h.run();
  assert.equal(h.worker.faux.state.callCount, 1);
  assert.ok(h.messages().some(row => row.type === "message" && row.message.role === "assistant" && row.message.stopReason === "error"), "actual SDK error must be persisted");
  assert.equal(h.ticket().assignments.at(-1)?.report?.state, "failed");
  assert.equal(h.ticket().assignments.at(-1)?.report?.summary, "SDK Worker run failed. Inspect the persistent input and external operation receipts before retrying.");
  assert.doesNotMatch(JSON.stringify(h.ticket().assignments.at(-1)?.report), /offline-provider-private-detail|faux-sensitive-value/);
  assert.deepEqual(h.ledger.list(h.sessionKey)[0]!.reports, []);
  assert.doesNotMatch(JSON.stringify(h.messages()), /fastvibe-dsh-report/);
  assert.equal(h.executor.slots.used(), 0);
});

test("structured progress followed by SDK idle yields domain waiting while SDK reports and mirror remain progress only", timeout, async t => {
  const summary = "inspected one file; implementation still in progress";
  const h = await harness(t, [tool("dsh_report", { state: "progress", summary })]);
  await h.deliver(); await h.run();
  assert.equal(h.worker.faux.state.callCount, 1);
  assert.equal(h.ticket().assignments.at(-1)?.report?.state, "waiting");
  assert.equal(h.ticket().assignments.at(-1)?.report?.summary, "Worker ended without a final structured status report. Request its status before treating the assignment as complete.");
  const reports = h.ledger.list(h.sessionKey)[0]!.reports;
  assert.equal(reports.length, 1); assert.deepEqual(reports[0]!.report, { state: "progress", summary });
  const mirrors = h.messages().filter(row => row.type === "custom" && row.customType === "fastvibe-dsh-report");
  assert.equal(mirrors.length, 1); assert.match(JSON.stringify(mirrors), /inspected one file/);
  assert.doesNotMatch(JSON.stringify(mirrors), /"state":"waiting"/);
  assert.equal(h.ticket().assignments.at(-1)?.state, "running"); assert.equal(h.ticket().ended, undefined);
  assert.equal(h.executor.slots.used(), 0);
});

for (const delivery of ["reject", "rollback"] as const) test(`real Effect delivery ${delivery} leaves provider and user JSONL untouched`, timeout, async t => {
  const h = await harness(t, undefined, { delivery }); await h.deliver();
  await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.worker.faux.state.callCount, 0); assert.deepEqual(h.users(), []);
  if (delivery === "rollback") {
    assert.ok(h.ticket().undelivered.length); assert.equal(h.ledger.list(h.sessionKey).length, 1);
    assert.equal(h.ledger.list(h.sessionKey)[0]!.entryId, undefined);
    assert.equal(h.store.effects.get("delivery", h.ticketId)?.status, "uncertain");
    assert.ok(h.ticket().inputs.every(item => item.kind !== "trigger" || item.deliveredTo === undefined));
  } else { assert.match(h.ticket().delivery!.error, /offline refusal/); assert.equal(h.ledger.list(h.sessionKey).length, 0); }
});

test("SDK write_file/edit_file change workspace; dsh_report records domain read, ready and JSONL without ending Follow", timeout, async t => {
  let declared: string[] = [];
  const h = await harness(t, [context => { declared = getCurrentTools(context.messages).map(item => item.name); return tool("write_file", { path: "src/fix.ts", text: "export const value = 1;\n" }); },
    tool("edit_file", { path: "src/fix.ts", oldText: "value = 1", newText: "value = 2" }),
    context => { assert.match(JSON.stringify(context.messages), /Workspace file edited/); return ready(); }]);
  await h.deliver(); await h.run();
  assert.deepEqual(declared.sort(), ["dsh_report", "edit_file", "list_files", "read_file", "write_file"]);
  assert.equal(readFileSync(join(h.executor.directories.get(h.ticketId)!.cwd, "src/fix.ts"), "utf8"), "export const value = 2;\n");
  assert.equal(h.ticket().assignments.at(-1)?.report?.state, "ready");
  assert.equal(h.ticket().assignments.at(-1)?.report?.summary, "workspace inspected and ready for followed work"); assert.equal(h.ticket().ended, undefined);
  assert.equal(h.ticket().assignments.at(-1)?.state, "running"); assert.equal(h.executor.slots.used(), 0);
  const receipt = h.ledger.list(h.sessionKey)[0]!; assert.equal(receipt.stage, "reported"); assert.equal(receipt.reads.length, 3); assert.equal(receipt.reports.length, 1);
  const jsonl = JSON.stringify(h.messages()); assert.match(jsonl, /fastvibe-dsh-report/); assert.match(jsonl, /fastvibe-dsh-read/);
  for (const name of ["write_file", "edit_file", "dsh_report"]) assert.ok(h.messages().some(row => row.type === "message" && row.message.role === "toolResult" && row.message.toolName === name));
  const count = h.worker.faux.state.callCount;
  await h.executor.sweep(); await h.executor.idle(); assert.equal(h.worker.faux.state.callCount, count); assert.equal(h.users().length, 1);
  h.worker.faux.setResponses([ready()]); await h.deliver("follow-up work after ready"); await h.run();
  assert.equal(h.users().length, 2); assert.equal(h.ticket().assignments.length, 1); assert.equal(h.ticket().ended, undefined); assert.equal(h.executor.slots.used(), 0);
});

test("Stop after committed prepare refuses activation and cannot resume by repeated sweep", timeout, async t => {
  const h = await harness(t); await h.deliver();
  h.driver.engine.people.stopTicket(h.ticketId, "human Stop before activation"); await h.driver.idle();
  await h.executor.sweep(); await h.executor.idle();
  assert.equal(h.worker.faux.state.callCount, 0); assert.deepEqual(h.users(), []);
  assert.equal(h.ticket().ended?.outcome, "stopped"); assert.equal(h.executor.record(h.ticketId)?.state, "stopped"); assert.equal(h.executor.slots.used(), 0);
  assert.equal(h.ledger.list(h.sessionKey)[0]?.status, "stopped");
});

for (const late of ["read", "report", "tool"] as const) test(`slot expiry rejects late ${late} at real SDK boundary`, timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return late === "report" ? ready() : late === "tool" ? tool("write_file", { path: "late.ts", text: "must not land" }) : fauxAssistantMessage("late read"); }]);
  let expired = false;
  if (late === "read") {
    const stream = h.worker.runtime.streamSimple.bind(h.worker.runtime);
    h.worker.runtime.streamSimple = ((...args: Parameters<typeof stream>) => { const result = stream(...args); h.tick(60_001); expired = true; return result; }) as typeof h.worker.runtime.streamSimple;
  }
  await h.deliver(); await h.executor.sweep(); await until(() => h.worker.faux.state.callCount === 1);
  if (late !== "read") { await until(() => h.ledger.list(h.sessionKey)[0]!.reads.length === 1); h.tick(60_001); expired = true; }
  gate.resolve(); await h.executor.idle().catch(() => {});
  assert.equal(expired, true); assert.equal(h.ticket().assignments.at(-1)?.report, undefined);
  const receipt = h.ledger.list(h.sessionKey)[0]!; assert.deepEqual(receipt.reports, []);
  if (late === "read") {
    assert.ok(h.ticket().inputs.every(item => item.kind !== "trigger" || item.readAt === null), "domain read callback must reject expired slot");
    assert.deepEqual(receipt.reads, [], "reconciliation must not resurrect the read rejected by the host fence");
  }
  assert.equal(existsSync(join(h.executor.directories.get(h.ticketId)!.cwd, "late.ts")), false);
  assert.doesNotMatch(JSON.stringify(h.messages()), /fastvibe-dsh-report/);
});

test("Stop at provider stream return rejects late domain read before the SDK callback", timeout, async t => {
  const h = await harness(t); const stream = h.worker.runtime.streamSimple.bind(h.worker.runtime); let reached = false;
  h.worker.runtime.streamSimple = ((...args: Parameters<typeof stream>) => {
    const result = stream(...args); reached = true;
    h.driver.engine.people.stopTicket(h.ticketId, "Stop at read boundary");
    return result;
  }) as typeof h.worker.runtime.streamSimple;
  await h.deliver(); await h.executor.sweep(); await h.executor.idle().catch(() => {}); await h.driver.idle();
  assert.equal(reached, true); assert.ok(h.worker.faux.state.callCount <= 1); assert.equal(h.ticket().ended?.outcome, "stopped");
  assert.ok(h.ticket().inputs.every(item => item.kind !== "trigger" || item.readAt === null));
  assert.deepEqual(h.ledger.list(h.sessionKey)[0]!.reports, []);
});

for (const late of ["report", "tool"] as const) test(`Stop during provider fences late ${late} and waits for SDK disposal`, timeout, async t => {
  const gate = deferred(); t.after(gate.resolve);
  const h = await harness(t, [async () => { await gate.promise; return late === "report" ? ready() : tool("write_file", { path: "late.ts", text: "must not land" }); }]);
  await h.deliver(); await h.executor.sweep(); await until(() => h.ledger.list(h.sessionKey)[0]!.reads.length === 1);
  h.driver.engine.people.stopTicket(h.ticketId, "Stop while provider is pending"); gate.resolve();
  await h.driver.idle(); await h.executor.idle();
  assert.equal(h.ticket().ended?.outcome, "stopped"); assert.equal(h.ticket().assignments.at(-1)?.report, undefined);
  assert.equal(existsSync(join(h.executor.directories.get(h.ticketId)!.cwd, "late.ts")), false);
  assert.deepEqual(h.ledger.list(h.sessionKey)[0]!.reports, []); assert.equal(h.executor.slots.used(), 0);
  assert.equal(h.store.get(`pi:owner:${h.sessionKey}`), null);
});

test("same role transcript under live new binding never re-reads old Assignment deliveredTo", timeout, async t => {
  const h = await harness(t, [tool("dsh_report", { state: "failed", summary: "explicit retryable failure" })]); await h.deliver(); await h.run();
  const first = h.ledger.list(h.sessionKey)[0]!; const oldReads = structuredClone(first.reads);
  // The real retry command emits stop and launch controls for the new Assignment.
  h.tick(1); h.driver.engine.people.retryTicket(h.ticketId);
  await h.driver.idle();
  // A concurrently dispatched launch may defer until the old owner's stop completes.
  if (!h.driver.engine.currentBinding(h.ticketId)) { h.tick(5_001); await h.driver.idle(); }
  const current = h.driver.engine.currentBinding(h.ticketId)!;
  assert.ok(current, JSON.stringify(h.store.effects.get("launch", h.ticket().assignments.at(-1)!.id))); assert.notEqual(current.assignmentId, h.binding.assignmentId);
  h.worker.faux.setResponses([ready()]); await h.deliver("new Assignment input"); await h.run();
  assert.deepEqual(h.ledger.get(h.sessionKey, first.requestId)!.reads, oldReads);
  const next = h.ledger.list(h.sessionKey).find(item => item.binding.assignmentId === current.assignmentId)!;
  assert.ok(next); assert.ok(next.reads.length); assert.ok(next.reports.length);
  assert.equal(next.reads[0]!.binding.assignmentId, current.assignmentId);
  assert.equal(h.ticket().assignments.at(-1)?.report?.state, "ready");
});

test("worker request_review uses independent SDK read_file/dsh_review; repair yields new SHA artifact with checks not-run", timeout, async t => {
  let reviewer!: Awaited<ReturnType<typeof provider>>, head = head1, snapshotContent = "export const value = 1;\n";
  const inputs: { artifactId: string; headSha: string; version: string }[] = [];
  const reviewCall = (artifactId: string, headSha: string) => tool("dsh_review", {
    artifactId, headSha, baseSha: base, findings: [], checks: [{ name: "unit", status: "passed", evidence: "model claims tests passed" }], summary: "static inspection", verdict: "comment",
  } satisfies PiReviewArtifact);
  const h = await harness(t, [tool("write_file", { path: "fix.ts", text: snapshotContent }), tool("request_review", { artifactId: "before-repair" }),
    context => { assert.match(JSON.stringify(context.messages), /not-run/); return tool("edit_file", { path: "fix.ts", oldText: "value = 1", newText: "value = 2" }); },
    () => { head = head2; snapshotContent = "export const value = 2;\n"; return tool("request_review", { artifactId: "after-repair" }); }, ready()], {
    reviewer: async root => {
      reviewer = await provider(root, "executor-reviewer", [context => {
        assert.deepEqual(getCurrentTools(context.messages).map(item => item.name).sort(), ["dsh_review", "read_file"]);
        assert.match(JSON.stringify(context.messages), /HOST_FIXED_DIFF/); assert.doesNotMatch(JSON.stringify(context.messages), /repair the Issue/);
        return tool("read_file", { path: "fix.ts" });
      }, context => { assert.match(JSON.stringify(context.messages), /export const value = 1/); return reviewCall("before-repair", head1); },
      tool("read_file", { path: "fix.ts" }), context => { assert.match(JSON.stringify(context.messages), /export const value = 2/); return reviewCall("after-repair", head2); }]);
      return { modelRuntime: reviewer.runtime, model: reviewer.model, current: () => ({ headSha: head, baseSha: base }), input: (_binding, artifactId) => {
        inputs.push({ artifactId, headSha: head, version: hash(snapshotContent) });
        return { artifactId, headSha: head, baseSha: base, diff: `HOST_FIXED_DIFF:${head}\n${snapshotContent}`, requirements: "Inspect complete fixed diff without claiming test execution", files: [{ path: "fix.ts", version: hash(snapshotContent) }] };
      } };
    },
  });
  await h.deliver(); await h.run();
  assert.equal(reviewer.faux.state.callCount, 4); assert.equal(h.ticket().assignments.at(-1)?.report?.state, "ready");
  assert.deepEqual(inputs.map(input => input.headSha), [head1, head2]); assert.notEqual(inputs[0]!.version, inputs[1]!.version);
  const records = h.store.db.all<{ data: string }>("SELECT data FROM dsh_source_cursors WHERE source='pi-reviewer'").map(row => JSON.parse(row.data) as PiReviewRecord);
  assert.equal(records.length, 2);
  for (const record of records) {
    assert.equal(record.status, "completed"); assert.equal(record.artifact?.checks[0]?.status, "not-run"); assert.ok(record.evidence?.read.entryId);
    const state = h.ledger.session(record.sessionKey)!; assert.notEqual(state.sessionFile, h.ledger.session(h.sessionKey)!.sessionFile);
    const jsonl = readFileSync(state.sessionFile, "utf8"); assert.match(jsonl, /read_file/); assert.match(jsonl, /dsh_review/); assert.doesNotMatch(jsonl, /dsh_report/);
  }
  assert.notEqual(records[0]!.sessionKey, records[1]!.sessionKey);
  assert.equal(readFileSync(join(h.executor.directories.get(h.ticketId)!.cwd, "fix.ts"), "utf8"), snapshotContent);
  assert.equal(h.ticket().ended, undefined); assert.equal(h.executor.slots.used(), 0);
});
