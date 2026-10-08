import test from "node:test";
import assert from "node:assert/strict";
import { watchMobileDag, dagToolNodeId } from "../apps/mobile/src/chat/dag-data.ts";
import { dagProgress, dagTaskRows } from "../src/shared/dag-view.ts";
import type { DagGraph, DagNode } from "../src/shared/dag.ts";

const node = (id: string, status: DagNode["status"], extra: Partial<DagNode> = {}): DagNode => ({ id, status, title: id, instruction: "task", profile: { name: "worker", instructions: "work" }, dependsOn: [], createdAt: 1, ...extra });
const graph = (revision: number, nodes = [node("T-0001", "running")]): DagGraph => ({ conversationId: "chat", revision, nodes, createdAt: 1, updatedAt: revision });
const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
function fixture() {
  const requests: Array<{ resolve: (value: unknown) => void; reject: (error: Error) => void }> = [];
  const listeners = new Set<(event: Record<string, unknown>) => void>();
  const updates: Array<DagGraph | null> = [];
  const errors: unknown[] = [];
  const source = {
    call: () => new Promise<unknown>((resolve, reject) => requests.push({ resolve, reject })),
    onEvent: (listener: (event: Record<string, unknown>) => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  const watch = watchMobileDag(source, "chat", (value) => updates.push(value), (error) => errors.push(error));
  return { watch, requests, updates, errors, listeners, push: (event: Record<string, unknown>) => { for (const listener of listeners) listener(event); } };
}

test("mobile DAG follows live updates and rejects an older initial list", async () => {
  const f = fixture();
  f.push({ type: "dag_changed", conversationId: "chat", graph: graph(4, [node("T-0001", "completed")]) });
  f.requests[0].resolve([graph(2)]); await tick();
  assert.equal(f.updates.at(-1)?.nodes[0].status, "completed");
  assert.equal(f.updates.length, 1); f.watch.dispose();
});

test("a newer list may advance a push, but a concurrent deletion cannot be resurrected", async () => {
  const f = fixture();
  f.push({ type: "dag_changed", conversationId: "chat", graph: graph(2) });
  f.requests[0].resolve([graph(4)]); await tick();
  assert.equal(f.updates.at(-1)?.revision, 4);
  const refresh = f.watch.refresh();
  f.push({ type: "dag_changed", conversationId: "chat", graph: null });
  f.requests[1].resolve([graph(5)]); await refresh;
  assert.equal(f.updates.at(-1), null); f.watch.dispose();
});

test("mobile DAG scope survives a failed list and ignores another chat or a retired connection", async () => {
  const f = fixture();
  f.requests[0].reject(new Error("offline")); await tick();
  assert.equal(f.errors.length, 1);
  f.push({ type: "dag_changed", conversationId: "other", graph: { ...graph(3), conversationId: "other" } });
  assert.equal(f.updates.length, 0);
  f.push({ type: "dag_changed", conversationId: "chat", graph: graph(5) });
  assert.equal(f.updates.length, 1);
  const refresh = f.watch.refresh(); f.watch.dispose();
  f.requests[1].resolve([graph(8)]); await refresh;
  assert.equal(f.updates.length, 1); assert.equal(f.listeners.size, 0);
});

test("stale revisions and malformed pushes cannot roll back the task list", async () => {
  const f = fixture();
  f.requests[0].resolve([graph(5)]); await tick();
  f.push({ type: "dag_changed", conversationId: "chat", graph: graph(2) });
  f.push({ type: "dag_changed", conversationId: "chat", graph: { nodes: [] } });
  assert.equal(f.updates.at(-1)?.revision, 5); f.watch.dispose();
});

test("the phone tree preserves ownership, prioritises attention and labels retired attempts", () => {
  const nodes = [node("T-0001", "completed"), node("T-0002", "running", { coordinator: true, runId: "T-0002.2" }), node("T-0003", "blocked", { parentId: "T-0002", parentRunId: "T-0002.2" }), node("T-0004", "completed", { parentId: "T-0002", parentRunId: "T-0002" })];
  const rows = dagTaskRows(nodes);
  assert.deepEqual(rows.map((item) => item.node.id), ["T-0002", "T-0003", "T-0004", "T-0001"]);
  assert.deepEqual(rows.map((item) => item.depth), [0, 1, 1, 0]);
  assert.equal(rows[2].previousAttempt, true);
  assert.deepEqual(dagProgress(nodes), { total: 4, completed: 2, active: 1, attention: 1 });
});

test("a filtered batch or malformed ownership cycle still renders each task once", () => {
  const rows = dagTaskRows([node("T-0001", "pending", { parentId: "T-0002" }), node("T-0002", "pending", { parentId: "T-0001" })]);
  assert.equal(rows.length, 2);
  assert.equal(dagTaskRows([node("T-0001", "pending", { parentId: "missing" })])[0].depth, 0);
  assert.equal(dagToolNodeId({ id: "t1" }), "T-0001");
});
