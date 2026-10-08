import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DagStore } from "../src/main/engine/dag-store.ts";
import { buildPrompt, DagScheduler, type DagNodeRun, type DagRunner } from "../src/main/pi/dag-scheduler.ts";
import { canonicalDagId, dagGraphState, dagRunStatus, dagSeq, formatDagId, isDagNodeId, resolveDrafts, type DagConfiguredAgent, type DagNodeDraft, type DagProfile } from "../src/shared/dag.ts";

/**
 * The DAG engine: ids, validation, and the four rules the scheduler lives by. A graph that
 * runs in the wrong order, or runs a node whose upstream failed, looks like it works.
 */

const profile: DagProfile = { name: "worker", instructions: "do the work" };
const draft = (ref: string, dependsOn: string[] = [], extra: Partial<DagNodeDraft> = {}): DagNodeDraft => ({
  ref,
  title: `title ${ref}`,
  instruction: `instruction ${ref}`,
  profile,
  dependsOn,
  ...extra,
});

function fixture(): { store: DagStore; file: string } {
  const dir = mkdtempSync(join(tmpdir(), "fastvibe-dag-"));
  const file = join(dir, "dag.json");
  return { store: new DagStore(file), file };
}

const settle = (): Promise<void> => new Promise((done) => setTimeout(done, 90));
const tick = (): Promise<void> => new Promise((done) => setImmediate(done));

/** A runner whose nodes finish when the test says so, recording the order they started in. */
function controlled(): {
  run: DagRunner;
  started: string[];
  prompts: Map<string, string>;
  finish: (id: string, result?: Partial<DagNodeRun>) => void;
  aborted: Set<string>;
} {
  const started: string[] = [];
  const prompts = new Map<string, string>();
  const waiting = new Map<string, (result: DagNodeRun) => void>();
  const aborted = new Set<string>();
  const run: DagRunner = ({ node, prompt, signal }) =>
    new Promise((resolve) => {
      started.push(node.id);
      prompts.set(node.id, prompt);
      waiting.set(node.id, resolve);
      signal.addEventListener("abort", () => {
        aborted.add(node.id);
        resolve({ status: "aborted", output: "" });
      });
    });
  return {
    run,
    started,
    prompts,
    aborted,
    finish: (id, result) => waiting.get(id)?.({ status: "completed", output: `out ${id}`, ...result }),
  };
}

test("ids are T-0001…, widen past 9999 and accept the spellings a model writes", () => {
  assert.equal(formatDagId(1), "T-0001");
  assert.equal(formatDagId(9999), "T-9999");
  assert.equal(formatDagId(10000), "T-10000");
  assert.equal(dagSeq("t-7"), 7);
  assert.equal(dagSeq("T0042"), 42);
  assert.equal(dagSeq("nope"), undefined);
  assert.equal(canonicalDagId("t-3"), "T-0003");
  assert.equal(isDagNodeId("T-0001"), true);
  assert.equal(isDagNodeId("toolcall:0"), false);
});

test("drafts: references resolve, and the mistakes a model makes are named", () => {
  const existing = new Set(["T-0001"]);
  const ok = resolveDrafts(existing, [draft("a"), draft("b", ["a", "t-1"])]);
  assert.deepEqual(ok[1].batchDeps, [0]);
  assert.deepEqual(ok[1].existingDeps, ["T-0001"]);
  assert.throws(() => resolveDrafts(existing, []), /不能为空/);
  assert.throws(() => resolveDrafts(existing, [draft("a"), draft("a")]), /重复/);
  assert.throws(() => resolveDrafts(existing, [draft("a", ["ghost"])]), /ghost/);
  assert.throws(() => resolveDrafts(existing, [draft("a", ["a"])]), /自己/);
  assert.throws(() => resolveDrafts(existing, [draft("a", ["b"]), draft("b", ["a"])]), /成环/);
  assert.throws(() => resolveDrafts(existing, [draft("a", [], { profile: { name: "x", instructions: "y", tools: ["rm"] } })]), /未知工具/);
  assert.throws(() => resolveDrafts(existing, [draft("a", [], { instruction: "  " })]), /instruction/);
});

const reviewer: DagConfiguredAgent = {
  name: "Reviewer",
  description: "checks the result",
  instructions: "review carefully",
  tools: ["read", "bash", "subagent"],
  model: "openai/gpt-x",
  thinkingLevel: "high",
};

test("a task reuses a configured agent — its instructions, tools, model and reasoning — ahead of the written profile", () => {
  const [node] = resolveDrafts(new Set(), [draft("a", [], { agent: "reviewer", profile: { name: "improvised", instructions: "ignored" } })], [reviewer]);
  assert.equal(node.agent, "Reviewer");
  assert.equal(node.profile.name, "Reviewer");
  assert.equal(node.profile.instructions, "review carefully");
  // A configured role may list tools a node cannot run (subagent); those are dropped, not an error.
  assert.deepEqual(node.profile.tools, ["read", "bash"]);
  assert.equal(node.model, "openai/gpt-x");
  assert.equal(node.thinkingLevel, "high");
});

test("a task with no matching configured agent falls back to the profile it was given", () => {
  const [node] = resolveDrafts(new Set(), [draft("a")], [reviewer]);
  assert.equal(node.agent, undefined);
  assert.equal(node.profile.name, "worker");
  assert.equal(node.model, undefined);
});

test("a diamond runs in dependency order and hands upstream results downstream", async () => {
  const { store } = fixture();
  const { run, started, prompts, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"]), draft("c", ["a"]), draft("d", ["b", "c"])]);
  assert.deepEqual(started, ["T-0001"], "only the root is ready");
  finish("T-0001");
  await tick();
  assert.deepEqual(started, ["T-0001", "T-0002", "T-0003"], "both branches start once the root is done");
  finish("T-0002");
  await tick();
  assert.equal(started.includes("T-0004"), false, "the join waits for every parent");
  finish("T-0003");
  await tick();
  assert.deepEqual(started.at(-1), "T-0004");
  const prompt = prompts.get("T-0004")!;
  assert.match(prompt, /### T-0002 title b\nout T-0002/);
  assert.match(prompt, /### T-0003 title c\nout T-0003/);
  finish("T-0004");
  await tick();
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["completed", "completed", "completed", "completed"]);
});

test("concurrency is capped per graph and freed slots are refilled", async () => {
  const { store } = fixture();
  const { run, started, finish } = controlled();
  const scheduler = new DagScheduler(store, run, { concurrency: 2 });
  scheduler.add("c1", [draft("a"), draft("b"), draft("c"), draft("d")]);
  assert.deepEqual(started, ["T-0001", "T-0002"]);
  finish("T-0001");
  await tick();
  assert.deepEqual(started, ["T-0001", "T-0002", "T-0003"]);
});

test("a failed node skips everything downstream of it — and only that", async () => {
  const { store } = fixture();
  const { run, started, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"]), draft("c", ["b"]), draft("side")]);
  finish("T-0001", { status: "failed", output: "", error: "boom" });
  finish("T-0004");
  await tick();
  const byId = Object.fromEntries(store.get("c1")!.nodes.map((node) => [node.id, node]));
  assert.equal(byId["T-0001"].status, "failed");
  assert.equal(byId["T-0001"].error, "boom");
  assert.equal(byId["T-0002"].status, "skipped");
  assert.equal(byId["T-0002"].blockedBy, "T-0001");
  assert.equal(byId["T-0003"].status, "skipped", "the skip propagates down the chain");
  assert.equal(byId["T-0004"].status, "completed", "an unrelated branch is unaffected");
  assert.equal(started.includes("T-0002"), false, "a node is never run on a failed upstream's empty result");
});

test("nodes added later can depend on existing ones, and on a failed one are skipped at once", async () => {
  const { store } = fixture();
  const { run, started, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a")]);
  finish("T-0001");
  await tick();
  scheduler.add("c1", [draft("b", ["T-0001"])]);
  assert.deepEqual(started, ["T-0001", "T-0002"], "a grown graph keeps going");
  finish("T-0002", { status: "failed", error: "x" });
  await tick();
  const added = scheduler.add("c1", [draft("c", ["t-2"])]);
  assert.equal(added[0].id, "T-0003");
  assert.equal(store.node("c1", "T-0003")?.status, "skipped");
});

test("cancel stops a running node, cancels waiting ones and skips what depended on them", async () => {
  const { store } = fixture();
  const { run, aborted } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  assert.deepEqual(scheduler.cancel("c1"), ["T-0001", "T-0002"]);
  await tick();
  assert.ok(aborted.has("T-0001"));
  const statuses = store.get("c1")!.nodes.map((node) => node.status);
  assert.deepEqual(statuses, ["cancelled", "cancelled"]);
});

test("retry resets a failed node and the downstream it blocked, then the graph resumes", async () => {
  const { store } = fixture();
  const { run, started, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  finish("T-0001", { status: "failed", error: "flaky" });
  await tick();
  assert.equal(store.node("c1", "T-0002")?.status, "skipped");
  assert.throws(() => scheduler.retry("c1", "T-0002"), /只有失败或已取消/);
  assert.deepEqual(scheduler.retry("c1", "t-1").sort(), ["T-0001", "T-0002"]);
  assert.equal(started.filter((id) => id === "T-0001").length, 2, "the node ran again");
  finish("T-0001");
  await tick();
  assert.equal(started.at(-1), "T-0002");
});

test("wait resolves when the nodes finish, on timeout, and on abort — and does not throw on failure", async () => {
  const { store } = fixture();
  const { run, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b")]);
  const all = scheduler.wait("c1", undefined, { timeoutMs: 5000 });
  finish("T-0001", { status: "failed", error: "x" });
  finish("T-0002");
  const result = await all;
  assert.equal(result.settled, true);
  assert.equal(result.nodes.length, 2);

  scheduler.add("c1", [draft("c")]);
  const slow = await scheduler.wait("c1", ["T-0003"], { timeoutMs: 20 });
  assert.equal(slow.settled, false);
  const controller = new AbortController();
  const aborted = scheduler.wait("c1", ["T-0003"], { timeoutMs: 5000, signal: controller.signal });
  controller.abort();
  assert.equal((await aborted).settled, false);
});

test("a runner that throws is a failed node, not a crashed scheduler", async () => {
  const { store } = fixture();
  const scheduler = new DagScheduler(store, async () => {
    throw new Error("session exploded");
  });
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  await tick();
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["failed", "skipped"]);
  assert.equal(store.node("c1", "T-0001")?.error, "session exploded");
});

test("ids are global and never reused, and the graph survives a restart with running nodes marked interrupted", async () => {
  const { store, file } = fixture();
  const { run } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a")]);
  scheduler.add("c2", [draft("b")]);
  assert.deepEqual([store.get("c1")!.nodes[0].id, store.get("c2")!.nodes[0].id], ["T-0001", "T-0002"]);
  scheduler.dropConversation("c2");
  assert.equal(store.get("c2"), undefined);
  assert.equal(new DagScheduler(store, run).add("c3", [draft("c")])[0].id, "T-0003", "a dropped graph's numbers are not reissued");
  await settle();

  const reopened = new DagStore(file);
  assert.equal(reopened.node("c1", "T-0001")?.status, "cancelled", "a node that was running when the app quit is not shown running forever");
  assert.match(reopened.node("c1", "T-0001")?.error ?? "", /中断/);
  assert.equal(reopened.append("c9", (next) => [{ id: next(), title: "t", instruction: "i", profile, dependsOn: [], status: "pending" }])[0].id, "T-0004");
  writeFileSync(file, "{ nope");
  assert.deepEqual(new DagStore(file).list(), []);
});

test("every change is announced with the whole graph, and a drop announces null", () => {
  const { store } = fixture();
  const seen: Array<number | null> = [];
  store.onChange = (_id, graph) => seen.push(graph ? graph.nodes.length : null);
  store.append("c1", (next) => [{ id: next(), title: "t", instruction: "i", profile, dependsOn: [], status: "pending" }]);
  store.patch("c1", "T-0001", { status: "running" });
  store.drop("c1");
  assert.deepEqual(seen, [1, 1, null]);
});

test("the prompt carries upstream results, clipped, and only from nodes that produced something", () => {
  const node = { id: "T-0003", title: "c", instruction: "merge them", profile, dependsOn: [], status: "pending", createdAt: 0 } as const;
  const upstream = [
    { ...node, id: "T-0001", title: "a", output: "x".repeat(7000), status: "completed" },
    { ...node, id: "T-0002", title: "b", status: "completed" },
  ] as const;
  const prompt = buildPrompt(node, upstream);
  assert.match(prompt, /^merge them/);
  assert.match(prompt, /### T-0001 a/);
  assert.doesNotMatch(prompt, /### T-0002/);
  assert.match(prompt, /已截断/);
  assert.doesNotMatch(buildPrompt(node, []), /上游/);
});

test("layout: every edge points down, layers follow the longest chain, and a cycle cannot hang it", async () => {
  const { layoutDag } = await import("../src/renderer/src/lib/dag-layout.ts");
  const node = (id: string, dependsOn: string[] = []) =>
    ({ id, title: id, instruction: "i", profile, dependsOn, status: "pending", createdAt: 0 }) as const;
  const layout = layoutDag([node("A"), node("B", ["A"]), node("C", ["A"]), node("D", ["B", "C"]), node("E", ["A", "D"])]);
  const layer = (id: string) => layout.positions.get(id)!.layer;
  assert.deepEqual(["A", "B", "C", "D", "E"].map(layer), [0, 1, 1, 2, 3], "E waits on D, so it sits below D, not beside it");
  for (const edge of layout.edges) assert.ok(layer(edge.from) < layer(edge.to));
  assert.equal(layout.columns, 2);
  assert.equal(layout.positions.get("D")!.x, layout.width / 2, "a lone join node is centred under its parents");
  const cyclic = layoutDag([node("X", ["Y"]), node("Y", ["X"])]);
  assert.equal(cyclic.positions.size, 2);
  assert.deepEqual(layoutDag([]).edges, []);
});

test("resume brings back everything Stop cancelled and keeps what finished", async () => {
  const { store } = fixture();
  const { run, started, prompts, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"]), draft("c", ["b"]), draft("x")]);
  finish("T-0001");
  await tick();
  // The main chat is stopped while b and x are running.
  scheduler.cancel("c1", undefined, "主会话已停止");
  await tick();
  const byId = () => Object.fromEntries(store.get("c1")!.nodes.map((node) => [node.id, node]));
  assert.deepEqual(Object.values(byId()).map((node) => node.status), ["completed", "cancelled", "cancelled", "cancelled"], "Stop cancels everything unfinished, waiting nodes included");
  assert.equal(byId()["T-0002"].error, "主会话已停止");
  assert.equal(dagGraphState(store.get("c1")!.nodes), "stopped");

  assert.deepEqual(scheduler.resume("c1").sort(), ["T-0002", "T-0003", "T-0004"]);
  assert.equal(byId()["T-0001"].status, "completed", "finished work is kept");
  assert.equal(byId()["T-0001"].output, "out T-0001");
  assert.equal(started.filter((id) => id === "T-0002").length, 2, "the interrupted node ran again");
  assert.match(prompts.get("T-0002")!, /### T-0001/, "and still receives the result that was kept");
  finish("T-0002");
  finish("T-0004");
  await tick();
  finish("T-0003");
  await tick();
  assert.equal(dagGraphState(store.get("c1")!.nodes), "completed");
  assert.deepEqual(scheduler.resume("c1"), [], "nothing left to resume");
});

test("resume leaves failures alone: a failure is a result, retried node by node", async () => {
  const { store } = fixture();
  const { run, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  finish("T-0001", { status: "failed", error: "x" });
  await tick();
  assert.deepEqual(scheduler.resume("c1"), []);
  assert.equal(dagGraphState(store.get("c1")!.nodes), "failed");
  assert.throws(() => scheduler.resume("nope"), /任务图/);
});

test("a graph that was running when the app quit comes back stopped and resumable", async () => {
  const { store, file } = fixture();
  const { run, started, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  finish("T-0001");
  await tick();
  await settle();

  const reopened = new DagStore(file);
  assert.deepEqual(reopened.get("c1")!.nodes.map((node) => node.status), ["completed", "cancelled"]);
  assert.equal(dagGraphState(reopened.get("c1")!.nodes), "stopped");
  const again = controlled();
  const restored = new DagScheduler(reopened, again.run);
  assert.deepEqual(restored.resume("c1"), ["T-0002"]);
  assert.deepEqual(again.started, ["T-0002"], "only the interrupted node runs; the finished one is not redone");
  assert.equal(started.length, 2);
});

test("graph state: running while anything runs, stopped when something was cancelled, failed, completed", () => {
  const states = (...statuses: string[]) => dagGraphState(statuses.map((status) => ({ status })) as never);
  assert.equal(states("completed", "running"), "running");
  assert.equal(states("completed", "pending"), "running");
  assert.equal(states("completed", "cancelled", "skipped"), "stopped");
  assert.equal(states("failed", "skipped"), "failed");
  assert.equal(states("failed", "cancelled"), "stopped");
  assert.equal(states("completed", "completed"), "completed");
});

test("resume also brings back a node that was skipped only because of a cancelled upstream", async () => {
  const { store } = fixture();
  const { run, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  scheduler.cancel("c1", ["T-0001"]);
  await tick();
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["cancelled", "skipped"]);
  assert.deepEqual(scheduler.resume("c1").sort(), ["T-0001", "T-0002"]);
  finish("T-0001");
  await tick();
  assert.equal(store.node("c1", "T-0002")?.status, "running");
});

test("each run gets its own id, so a rerun never inherits the last run's status or transcript", async () => {
  const { store } = fixture();
  const seen: string[] = [];
  let fail = true;
  const scheduler = new DagScheduler(store, async ({ node }) => {
    seen.push(node.runId!);
    if (fail) return { status: "failed", output: "", error: "x" };
    return { status: "completed", output: "ok" };
  });
  scheduler.add("c1", [draft("a")]);
  await tick();
  assert.equal(store.node("c1", "T-0001")?.runId, "T-0001");
  fail = false;
  scheduler.retry("c1", "T-0001");
  await tick();
  assert.deepEqual(seen, ["T-0001", "T-0001.2"]);
  assert.equal(store.node("c1", "T-0001")?.attempt, 2);
  assert.equal(isDagNodeId("T-0001.2"), true);
});

test("Stop then an immediate 恢复: a node still winding down goes back to waiting, not to cancelled", async () => {
  const { store } = fixture();
  let release: (() => void) | undefined;
  const runs: string[] = [];
  // The first run takes a moment to exit after it is aborted, like a real session does.
  const scheduler = new DagScheduler(store, ({ node, signal }) => {
    runs.push(node.runId!);
    return new Promise((resolve) => {
      if (runs.length === 1) {
        signal.addEventListener("abort", () => {
          release = () => resolve({ status: "aborted", output: "" });
        });
      } else {
        resolve({ status: "completed", output: "done" });
      }
    });
  });
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  scheduler.cancel("c1", undefined, "主会话已停止");
  assert.equal(store.node("c1", "T-0001")?.status, "running", "still exiting");
  assert.deepEqual(scheduler.resume("c1").sort(), ["T-0001", "T-0002"]);
  release!();
  await tick();
  await tick();
  assert.deepEqual(runs, ["T-0001", "T-0001.2", "T-0002"]);
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["completed", "completed"]);
});

test("Stop → resume → Stop while exiting honours the last Stop, and can resume later", async () => {
  const { store } = fixture();
  const { run, started, finish } = controlled();
  const scheduler = new DagScheduler(store, run);
  scheduler.add("c1", [draft("a"), draft("b", ["a"])]);
  scheduler.cancel("c1");
  scheduler.resume("c1");
  scheduler.cancel("c1");
  await tick();
  assert.deepEqual(started, ["T-0001"], "the pending resume must not start a second run");
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["cancelled", "cancelled"]);
  scheduler.resume("c1");
  assert.equal(store.node("c1", "T-0001")?.runId, "T-0001.2");
  finish("T-0001");
  await tick();
  finish("T-0002");
  await tick();
  assert.deepEqual(store.get("c1")!.nodes.map((node) => node.status), ["completed", "completed"]);
});

test("engine shutdown cancels every graph before a freed slot can start waiting work", async () => {
  const { store, file } = fixture();
  const { run, started } = controlled();
  let notifications = 0;
  const scheduler = new DagScheduler(store, run, { concurrency: 1, onSettled: () => { notifications++; } });
  scheduler.add("c1", [draft("a"), draft("b"), draft("c", ["a"])]);
  scheduler.add("c2", [draft("d"), draft("e")]);
  scheduler.cancel("c1");
  scheduler.resume("c1");
  scheduler.stop();
  assert.throws(() => scheduler.resume("c1"), /引擎已停止/);
  assert.throws(() => scheduler.retry("c1", "T-0002"), /引擎已停止/);
  assert.throws(() => scheduler.add("c3", [draft("f")]), /引擎已停止/);
  await tick();
  assert.deepEqual(started, ["T-0001", "T-0004"]);
  assert.ok(store.list().every((graph) => graph.nodes.every((node) => node.status === "cancelled")));
  assert.equal(notifications, 0);
  store.flush();
  assert.ok(new DagStore(file).list().every((graph) => graph.nodes.every((node) => node.status === "cancelled")));
  scheduler.start();
  assert.deepEqual(started, ["T-0001", "T-0004"], "engine restart must not auto-resume cancelled graphs");
  scheduler.resume("c1");
  assert.equal(store.node("c1", "T-0001")?.runId, "T-0001.2");
  assert.equal(store.node("c2", "T-0004")?.status, "cancelled");
  scheduler.stop();
  await tick();
});

function notifying(): { store: DagStore; scheduler: DagScheduler; finish: ReturnType<typeof controlled>["finish"]; settled: Array<{ conversationId: string; statuses: string[] }> } {
  const { store } = fixture();
  const { run, finish } = controlled();
  const settled: Array<{ conversationId: string; statuses: string[] }> = [];
  const scheduler = new DagScheduler(store, run, {
    onSettled: (conversationId, nodes) => settled.push({ conversationId, statuses: nodes.map((node) => node.status) }),
  });
  return { store, scheduler, finish, settled };
}

test("a graph that finishes while nobody waits on it is announced once — failures included", async () => {
  const { scheduler, finish, settled } = notifying();
  scheduler.add("c1", [draft("a"), draft("b", ["a"]), draft("c")]);
  finish("T-0001", { status: "failed", error: "x" });
  await tick();
  assert.deepEqual(settled, [], "c is still running");
  finish("T-0003");
  await tick();
  assert.deepEqual(settled, [{ conversationId: "c1", statuses: ["failed", "skipped", "completed"] }]);
  scheduler.cancel("c1");
  assert.equal(settled.length, 1, "nothing changed, nothing new to say");
});

test("no announcement while the main agent is in dag_wait: the wait hands it the results", async () => {
  const { scheduler, finish, settled } = notifying();
  scheduler.add("c1", [draft("a")]);
  const waiting = scheduler.wait("c1", undefined, { timeoutMs: 5000 });
  finish("T-0001");
  assert.equal((await waiting).settled, true);
  assert.deepEqual(settled, []);
});

test("a graph the user stopped is not announced; once resumed and finished, it is", async () => {
  const { scheduler, finish, settled } = notifying();
  scheduler.add("c1", [draft("a")]);
  scheduler.cancel("c1", undefined, "主会话已停止");
  await tick();
  assert.deepEqual(settled, [], "Stop is the user's own decision, not news for the agent");
  scheduler.resume("c1");
  finish("T-0001");
  await tick();
  assert.equal(settled.length, 1);
  assert.deepEqual(settled[0].statuses, ["completed"]);
});

test("a graph that grows after finishing is announced again when the new work finishes", async () => {
  const { scheduler, finish, settled } = notifying();
  scheduler.add("c1", [draft("a")]);
  finish("T-0001");
  await tick();
  scheduler.add("c1", [draft("b", ["T-0001"])]);
  finish("T-0002");
  await tick();
  assert.equal(settled.length, 2);
});

test("a batch skipped the moment it is added ran nothing, so there is nothing to announce", async () => {
  const { scheduler, finish, settled } = notifying();
  scheduler.add("c1", [draft("a")]);
  finish("T-0001", { status: "failed", error: "x" });
  await tick();
  assert.equal(settled.length, 1);
  scheduler.add("c1", [draft("b", ["T-0001"])]);
  assert.equal(settled.length, 1, "the agent learns of the skip from its own dag_add_tasks reply");
});

test("five run at once by default", () => {
  const { store } = fixture();
  const { run, started } = controlled();
  new DagScheduler(store, run).add("c1", ["a", "b", "c", "d", "e", "f", "g"].map((ref) => draft(ref)));
  assert.equal(started.length, 5);
});

test("a node's state maps onto the run vocabulary its execution tab understands", () => {
  assert.equal(dagRunStatus("completed"), "completed");
  assert.equal(dagRunStatus("failed"), "error");
  assert.equal(dagRunStatus("cancelled"), "aborted");
  assert.equal(dagRunStatus("skipped"), "aborted");
  assert.equal(dagRunStatus("running"), "running");
});
