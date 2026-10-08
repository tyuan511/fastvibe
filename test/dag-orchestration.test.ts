import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DagStore } from "../src/main/engine/dag-store.ts";
import { DagScheduler, buildPrompt, type DagNodeRun } from "../src/main/pi/dag-scheduler.ts";
import { runDagTool } from "../src/main/dag-tools.ts";
import { resolveDrafts, dagGraphState, normalizeDagWritePath, type DagNodeDraft } from "../src/shared/dag.ts";
import { dagInputAllowance, estimateDagTokens, validateDagReport, dagReportExtension } from "../src/main/pi/dag-node-runtime.ts";

const draft = (title: string, extra: Partial<DagNodeDraft> = {}): DagNodeDraft => ({ title, instruction: title, profile: { name: "worker", instructions: "work" }, ...extra });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture(t: test.TestContext, options: ConstructorParameters<typeof DagScheduler>[2] = {}) {
  const dir = mkdtempSync(join(tmpdir(), "dag-orchestration-"));
  const store = new DagStore(join(dir, "dag.json"));
  const pending = new Map<string, (result: DagNodeRun) => void>();
  const started: string[] = [];
  const scheduler = new DagScheduler(store, ({ node, signal }) => new Promise((resolve) => {
    started.push(node.id); pending.set(node.id, resolve);
    signal.addEventListener("abort", () => resolve({ status: "aborted", output: "partial" }), { once: true });
  }), options);
  t.after(async () => { scheduler.stop(); await tick(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const finish = (id: string, extra: Partial<DagNodeRun> = {}) => pending.get(id)!({ status: "completed", output: `result ${id}`, ...extra });
  return { store, scheduler, finish, started, dir };
}

test("cancelled history cannot suppress a later batch's completion receipt", async (t) => {
  const notices: string[][] = [];
  const f = fixture(t, { onSettled: (_id, nodes) => { notices.push(nodes.map((n) => n.id)); } });
  const [a] = f.scheduler.add("c", [draft("old")]);
  f.scheduler.cancel("c", [a.id]); await tick();
  const [b] = f.scheduler.add("c", [draft("new")]);
  f.finish(b.id); await tick();
  assert.deepEqual(notices, [[b.id]]);
  f.store.flush();
  const reopened = new DagStore(join(f.dir, "dag.json"));
  new DagScheduler(reopened, async () => { throw new Error("must not run"); }, { onSettled: () => { assert.fail("delivered result was replayed"); } }).start();
});

test("a subset wait only consumes its own outcomes", async (t) => {
  const notices: string[][] = [];
  const f = fixture(t, { onSettled: (_id, nodes) => { notices.push(nodes.map((n) => n.id)); } });
  const [a, b] = f.scheduler.add("c", [draft("a"), draft("b")]);
  const waiting = f.scheduler.wait("c", [a.id], { timeoutMs: 1000 });
  f.finish(b.id); await tick(); f.finish(a.id);
  assert.deepEqual((await waiting).nodes.map((n) => n.id), [a.id]);
  await tick(); assert.deepEqual(notices, [[b.id]]);
});

test("a failed delivery remains unacknowledged across a restart", async (t) => {
  const f = fixture(t, { onSettled: () => false });
  const [a] = f.scheduler.add("c", [draft("a")]); f.finish(a.id); await tick(); f.store.flush();
  assert.equal(f.store.node("c", a.id)?.observedOutcome, undefined);
  const reopened = new DagStore(join(f.dir, "dag.json"));
  let notices = 0;
  new DagScheduler(reopened, async () => { throw new Error("must not run"); }, { onSettled: () => { notices++; } }).start();
  assert.equal(notices, 1); reopened.flush();
});

test("blocked work can wake the coordinator while another branch is still running", async (t) => {
  const notices: string[][] = [];
  const f = fixture(t, { notifyFailures: true, onSettled: (_id, nodes) => { notices.push(nodes.map((n) => n.status)); } });
  const [a] = f.scheduler.add("c", [draft("a"), draft("b")]);
  f.finish(a.id, { status: "blocked", error: "missing input" }); await tick();
  assert.deepEqual(notices, [["blocked"]]);
});

test("complete results remain readable, searchable and paged after restart", async (t) => {
  const f = fixture(t);
  const [a] = f.scheduler.add("c", [draft("a")]);
  const output = "start" + "x".repeat(24000) + "important ending";
  f.finish(a.id, { output }); await tick(); f.store.flush();
  const store = new DagStore(join(f.dir, "dag.json"));
  assert.equal(store.output("c", store.node("c", a.id)!), output);
  const result = await runDagTool({ store, scheduler: f.scheduler }, { action: "result", input: { id: a.id, query: "important ending", limit: 100 } }, "c");
  assert.equal(result.ok, true);
  assert.match(JSON.stringify(result), /important ending/);
  assert.ok(JSON.stringify(result).length < 1000);
});

test("fan-in has an aggregate bound and ordering dependencies need not enter context", () => {
  const node = { ...draft("merge"), id: "T-0100", profile: { name: "w", instructions: "w" }, status: "pending" as const, createdAt: 0, dependsOn: [] };
  const upstream = Array.from({ length: 99 }, (_, i) => ({ ...node, id: `T-${String(i + 1).padStart(4, "0")}`, output: "x".repeat(10000) }));
  const prompt = buildPrompt(node, upstream);
  assert.ok(prompt.length < 17000);
  assert.match(prompt, /T-0099/);
  assert.doesNotMatch(buildPrompt({ ...node, contextFrom: [] }, upstream), /### T-/);
  assert.throws(() => resolveDrafts(new Set(), [draft("a", { ref: "a" }), draft("b", { contextFrom: ["a"] })]), /context_from/);
});

test("global and provider caps apply across graphs and freed capacity starts other graphs", async (t) => {
  const f = fixture(t, { globalConcurrency: 3, providerConcurrency: 2, resource: () => ({ workspace: "repo", provider: "p" }) });
  const first = f.scheduler.add("one", [draft("a"), draft("b")]);
  const [next] = f.scheduler.add("two", [draft("c")]);
  assert.equal(f.started.length, 2);
  f.finish(first[0].id); await tick();
  assert.ok(f.started.includes(next.id));
});

test("overlapping writer paths serialize across chats, independent paths run together", async (t) => {
  const f = fixture(t, { resource: () => ({ workspace: "repo" }) });
  const writer = (title: string, paths: string[]) => draft(title, { profile: { name: "w", instructions: "w", tools: ["edit"] }, writePaths: paths });
  const [a] = f.scheduler.add("one", [writer("a", ["src/auth"])]);
  const [b, c] = f.scheduler.add("two", [writer("b", ["src/auth/login.ts"]), writer("c", ["src/ui"])]);
  assert.deepEqual(f.started, [a.id, c.id]);
  f.finish(a.id); await tick(); assert.ok(f.started.includes(b.id));
});

test("a waiting coordinator releases its slot and reacquires it without deadlock at concurrency one", async (t) => {
  const f = fixture(t, { concurrency: 1, globalConcurrency: 1 });
  const [parent] = f.scheduler.add("c", [draft("parent", { coordinator: true })]);
  const [child] = f.scheduler.add("c", [draft("child")], [], parent.id);
  assert.deepEqual(f.started, [parent.id]);
  const waiting = f.scheduler.wait("c", [child.id], { timeoutMs: 1000, ownerId: parent.id });
  assert.deepEqual(f.started, [parent.id, child.id]);
  f.finish(child.id); assert.equal((await waiting).settled, true);
  const [sibling] = f.scheduler.add("c", [draft("sibling")]);
  assert.ok(!f.started.includes(sibling.id));
  f.finish(parent.id); await tick(); assert.ok(f.started.includes(sibling.id));
});

test("coordinators cannot create dependency cycles or touch siblings", async (t) => {
  const f = fixture(t);
  const [parent, sibling] = f.scheduler.add("c", [draft("parent", { coordinator: true }), draft("other")]);
  assert.throws(() => f.scheduler.add("c", [draft("cycle", { dependsOn: [parent.id] })], [], parent.id), /协调者/);
  const result = await runDagTool({ store: f.store, scheduler: f.scheduler, scope: { nodeId: parent.id, runId: parent.runId! } }, { action: "cancel", input: { ids: [sibling.id] } }, "c");
  assert.equal(result.ok, false);
  assert.equal(f.store.node("c", sibling.id)?.status, "running");
});

test("coordinator cancellation cascades and a new attempt does not inherit its retired children", async (t) => {
  const f = fixture(t);
  const [parent] = f.scheduler.add("c", [draft("parent", { coordinator: true })]);
  const [child] = f.scheduler.add("c", [draft("child")], [], parent.id);
  f.scheduler.cancel("c", [parent.id]); await tick();
  assert.equal(f.store.node("c", child.id)?.status, "cancelled");
  f.scheduler.retry("c", parent.id);
  assert.deepEqual(f.scheduler.descendants("c", parent.id), []);
  const [fresh] = f.scheduler.add("c", [draft("new child")], [], parent.id);
  assert.equal(fresh.parentRunId, `${parent.id}.2`);
});

test("reports and context estimates enforce the task contract", () => {
  assert.throws(() => validateDagReport({ outcome: "completed", summary: "done" }, "tests pass"), /证据/);
  assert.equal(validateDagReport({ outcome: "blocked", summary: "need input" }).outcome, "blocked");
  assert.ok(estimateDagTokens("中".repeat(100)) >= 100);
  assert.equal(dagInputAllowance("x".repeat(100000), "", 8192), 0);
});

test("a report cannot claim completion with unfinished children and is invalidated by later work", async () => {
  let ready = false; let report: unknown; let tool: any; let before: any;
  dagReportExtension({ childrenReady: () => ready, report: (value) => { report = value; } })({ on: (_name: string, fn: unknown) => { before = fn; }, registerTool: (value: unknown) => { tool = value; } } as any);
  assert.equal((await tool.execute("x", { outcome: "completed", summary: "done" })).isError, true);
  ready = true; await tool.execute("x", { outcome: "completed", summary: "done" });
  assert.ok(report); before({ toolName: "edit" }); assert.equal(report, undefined);
});

test("token usage is recorded on ancestors but never stops a task", async (t) => {
  const dir = mkdtempSync(join(tmpdir(), "dag-budget-"));
  const store = new DagStore(join(dir, "dag.json"));
  const charge = new Map<string, (usage: { tokens: number; turns: number }) => void>();
  const done = new Map<string, (result: DagNodeRun) => void>();
  const scheduler = new DagScheduler(store, ({ node, signal, onUsage }) => new Promise((resolve) => {
    charge.set(node.id, onUsage);
    done.set(node.id, resolve);
    signal.addEventListener("abort", () => resolve({ status: "aborted", output: "checkpoint" }));
  }));
  t.after(async () => { scheduler.stop(); await tick(); store.flush(); rmSync(dir, { recursive: true, force: true }); });
  const [parent] = scheduler.add("c", [draft("p", { coordinator: true, budget: { maxTokens: 20 } })]);
  const [a, b] = scheduler.add("c", [draft("a"), draft("b")], [], parent.id);
  charge.get(a.id)!({ tokens: 10, turns: 1 });
  charge.get(a.id)!({ tokens: 10, turns: 1 }); // Duplicate snapshots must not double-charge.
  charge.get(b.id)!({ tokens: 400_000, turns: 90 }); await tick();
  assert.equal(store.node("c", parent.id)?.usage?.tokens, 400_010);
  assert.equal(store.node("c", parent.id)?.status, "running");
  assert.equal(store.node("c", a.id)?.status, "running");
  assert.equal(store.node("c", b.id)?.status, "running");
  done.get(a.id)!({ status: "failed", output: "partial" }); await tick();
  scheduler.retry("c", a.id); await tick();
  assert.equal(store.node("c", a.id)?.status, "running", "spent tokens must not block the next attempt");
});

test("retry limits require deliberate revision, and pending task edits do not affect live work", async (t) => {
  const f = fixture(t);
  const [node] = f.scheduler.add("c", [draft("limited", { budget: { maxAttempts: 1 } })]);
  assert.throws(() => f.scheduler.update("c", node.id, { instruction: "changed" }), /只能修改/);
  f.finish(node.id, { status: "failed" }); await tick();
  assert.throws(() => f.scheduler.retry("c", node.id), (error: Error) => /重试上限/.test(error.message) && !/预算/.test(error.message));
  f.scheduler.update("c", node.id, { budget: { maxAttempts: 2 }, instruction: "revised" });
  f.scheduler.retry("c", node.id);
  assert.equal(f.store.node("c", node.id)?.attempt, 2);
  assert.equal(f.store.node("c", node.id)?.instruction, "revised");
});

test("old aborted tool calls cannot restart a stopped graph", async (t) => {
  const f = fixture(t); const controller = new AbortController(); controller.abort();
  const result = await runDagTool({ store: f.store, scheduler: f.scheduler }, { action: "add", input: { tasks: [draft("late")] } }, "c", controller.signal);
  assert.equal(result.ok, false); assert.equal(f.started.length, 0);
});

test("coordinator depth is bounded and cancellation wakes a wait parked for capacity", async (t) => {
  const f = fixture(t, { concurrency: 1, globalConcurrency: 1 });
  const [a] = f.scheduler.add("c", [draft("a", { coordinator: true })]);
  const [b] = f.scheduler.add("c", [draft("b", { coordinator: true })], [], a.id);
  const abort = new AbortController();
  const waiting = f.scheduler.wait("c", [b.id], { timeoutMs: 1, ownerId: a.id, signal: abort.signal });
  await new Promise((resolve) => setTimeout(resolve, 10));
  abort.abort(); assert.equal((await waiting).settled, false);
  assert.throws(() => f.scheduler.add("c", [draft("too deep", { coordinator: true })], [], b.id), /层/);
});

test("parent model choice survives a store restart", async (t) => {
  const f = fixture(t, { parentModel: () => "chosen/model", globalConcurrency: 1 });
  f.scheduler.add("c", [draft("a"), draft("b")]); f.store.flush();
  const reopened = new DagStore(join(f.dir, "dag.json"));
  assert.deepEqual(reopened.get("c")!.nodes.map((n) => n.fallbackModel), ["chosen/model", "chosen/model"]);
  reopened.flush();
});


test("hierarchical graph state respects a coordinator verdict and standalone child batches", () => {
  assert.equal(dagGraphState([{ id: "p", status: "completed" }, { id: "c", parentId: "p", status: "failed" }]), "completed");
  assert.equal(dagGraphState([{ id: "c", parentId: "p", status: "blocked" }]), "failed");
  assert.equal(normalizeDagWritePath("src/./auth/"), "src/auth");
  assert.throws(() => normalizeDagWritePath("src/**"), /通配符/);
});

test("structured evidence survives as part of the full attempt artifact", async (t) => {
  const f = fixture(t);
  const [node] = f.scheduler.add("c", [draft("report")]);
  f.finish(node.id, { output: "x".repeat(10000), report: { outcome: "completed", summary: "done", evidence: ["verified-tail-evidence"] } });
  await tick();
  assert.match(f.store.output("c", f.store.node("c", node.id)!), /verified-tail-evidence/);
  assert.ok(f.store.node("c", node.id)!.output!.length < 4100);
});
