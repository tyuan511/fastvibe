import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DagStore } from "../src/main/engine/dag-store.ts";
import { DagScheduler, type DagRunner } from "../src/main/pi/dag-scheduler.ts";
import { runDagTool } from "../src/main/dag-tools.ts";

/** The main agent's tools over the graph: input as a model writes it, errors as data it can fix. */

function setup(agents: Array<{ name: string; instructions: string; tools?: string[]; model?: string; thinkingLevel?: string }> = []): {
  call: (action: string, input?: Record<string, unknown>, signal?: AbortSignal) => ReturnType<typeof runDagTool>;
  finish: (id: string, result?: { status?: "completed" | "failed"; output?: string; error?: string }) => void;
  store: DagStore;
} {
  const store = new DagStore(join(mkdtempSync(join(tmpdir(), "fastvibe-dagtool-")), "dag.json"));
  const waiting = new Map<string, (value: { status: "completed" | "failed" | "aborted"; output: string; error?: string }) => void>();
  const run: DagRunner = ({ node, signal }) =>
    new Promise((resolve) => {
      waiting.set(node.id, resolve);
      signal.addEventListener("abort", () => resolve({ status: "aborted", output: "" }));
    });
  const scheduler = new DagScheduler(store, run);
  return {
    store,
    call: (action, input, signal) => runDagTool({ store, scheduler, agents: () => agents }, { action, input }, "c1", signal),
    finish: (id, result) => waiting.get(id)?.({ status: "completed", output: `out ${id}`, ...result }),
  };
}

const task = (ref: string, deps?: string[]) => ({
  ref,
  title: `Task ${ref}`,
  instruction: `Do ${ref}`,
  profile: { name: `role-${ref}`, instructions: `You are ${ref}`, tools: ["read", "grep"] },
  ...(deps ? { depends_on: deps } : {}),
});

test("add: tasks get T- ids, start on their own, and the reply names them", async () => {
  const { call, store } = setup();
  const result = await call("add", { tasks: [task("a"), task("b", ["a"])] });
  assert.equal(result.ok, true);
  const added = result.ok ? (result.value as { added: Array<{ id: string; status: string; dependsOn?: string[] }> }).added : [];
  assert.deepEqual(added.map((node) => node.id), ["T-0001", "T-0002"]);
  assert.deepEqual(added[1].dependsOn, ["T-0001"]);
  assert.equal(store.node("c1", "T-0001")?.status, "running");
  assert.equal(store.node("c1", "T-0002")?.status, "pending");
  assert.deepEqual(store.node("c1", "T-0001")?.profile.tools, ["read", "grep"]);
});

test("add: a bad batch is refused whole, with the reason in words the agent can act on", async () => {
  const { call, store } = setup();
  const cyclic = await call("add", { tasks: [task("a", ["b"]), task("b", ["a"])] });
  assert.equal(cyclic.ok, false);
  assert.match(String(!cyclic.ok && cyclic.error), /成环/);
  const unknownTool = await call("add", { tasks: [{ ...task("a"), profile: { name: "x", instructions: "y", tools: ["rm"] } }] });
  assert.match(String(!unknownTool.ok && unknownTool.error), /未知工具/);
  const notArray = await call("add", { tasks: "nope" });
  assert.equal(notArray.ok, false);
  assert.equal(store.get("c1"), undefined, "nothing was added by a refused call");
});

test("add: naming a configured agent reuses it, and a name that matches none is refused", async () => {
  const { call, store } = setup([{ name: "Reviewer", instructions: "review carefully", tools: ["read"], model: "openai/gpt-x", thinkingLevel: "high" }]);
  const reused = await call("add", { tasks: [{ ...task("a"), agent: "reviewer" }] });
  assert.equal(reused.ok, true);
  const node = store.node("c1", "T-0001");
  assert.equal(node?.agent, "Reviewer");
  assert.equal(node?.profile.instructions, "review carefully");
  assert.equal(node?.model, "openai/gpt-x");
  assert.equal(node?.thinkingLevel, "high");
  const missing = await call("add", { tasks: [{ ...task("b"), agent: "nobody" }] });
  assert.match(String(!missing.ok && missing.error), /nobody/);
});

test("wait returns when everything is done and previews outputs; failure is a result, not an error", async () => {
  const { call, finish } = setup();
  await call("add", { tasks: [task("a"), task("b")] });
  const waiting = call("wait", { timeoutSeconds: 5 });
  finish("T-0001", { output: "x".repeat(2000) });
  finish("T-0002", { status: "failed", error: "boom" });
  const result = await waiting;
  assert.equal(result.ok, true);
  const value = result.ok ? (result.value as { settled: boolean; summary: Record<string, number>; nodes: Array<{ output?: string; error?: string }> }) : undefined;
  assert.equal(value?.settled, true);
  assert.deepEqual(value?.summary, { completed: 1, failed: 1 });
  assert.match(value?.nodes[0].output ?? "", /用 dag_result 取全文/);
  assert.equal(value?.nodes[1].error, "boom");
});

test("wait on an empty graph says to add tasks first; an aborted wait leaves the nodes running", async () => {
  const { call, store } = setup();
  const empty = await call("wait", {});
  assert.equal(empty.ok, false);
  await call("add", { tasks: [task("a")] });
  const controller = new AbortController();
  const waiting = call("wait", { timeoutSeconds: 60 }, controller.signal);
  controller.abort();
  const result = await waiting;
  assert.equal(result.ok && (result.value as { settled: boolean }).settled, false);
  assert.equal(store.node("c1", "T-0001")?.status, "running");
});

test("result gives the full output; status, cancel and retry accept the sloppy id spelling", async () => {
  const { call, finish, store } = setup();
  await call("add", { tasks: [task("a"), task("b", ["a"])] });
  finish("T-0001", { output: "the full report" });
  await new Promise((done) => setImmediate(done));
  const result = await call("result", { id: "t-1" });
  assert.equal(result.ok && (result.value as { output: string }).output, "the full report");
  assert.equal((await call("result", { id: "T-0099" })).ok, false);
  const status = await call("status", { ids: ["t-2"] });
  assert.equal(status.ok && (status.value as { nodes: unknown[] }).nodes.length, 1);
  const cancelled = await call("cancel", { ids: ["T-0002"] });
  assert.equal(cancelled.ok, true);
  // The node was running (T-0001 finished), so the stop lands when its run returns.
  await new Promise((done) => setImmediate(done));
  assert.equal(store.node("c1", "T-0002")?.status, "cancelled");
  const retry = await call("retry", { id: "t-2" });
  assert.equal(retry.ok, true);
});

test("an unknown action lists the real ones", async () => {
  const { call } = setup();
  const result = await call("explode");
  assert.match(String(!result.ok && result.error), /add, status, result, wait, cancel, resume, retry/);
});

test("resume: stopped nodes start again and the reply says so; with nothing stopped it points at dag_retry", async () => {
  const { call, store } = setup();
  await call("add", { tasks: [task("a")] });
  const none = await call("resume", {});
  assert.match(String(none.ok && (none.value as { note: string }).note), /dag_retry/);
  await call("cancel", {});
  await new Promise((done) => setImmediate(done));
  assert.equal(store.node("c1", "T-0001")?.status, "cancelled");
  const resumed = await call("resume", {});
  assert.deepEqual(resumed.ok && (resumed.value as { resumed: string[] }).resumed, ["T-0001"]);
  assert.equal(store.node("c1", "T-0001")?.status, "running");
});

test("wait refuses an id that does not exist instead of returning at once as if it had finished", async () => {
  const { call } = setup();
  await call("add", { tasks: [task("a")] });
  const result = await call("wait", { ids: ["T-0099"], timeoutSeconds: 5 });
  assert.equal(result.ok, false);
  assert.match(String(!result.ok && result.error), /T-0099/);
});
