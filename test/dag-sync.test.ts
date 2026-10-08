import assert from "node:assert/strict";
import test from "node:test";
import { watchDagGraphs } from "../src/renderer/src/lib/dag-sync.ts";
import { addedDagIds, dagBatch } from "../src/renderer/src/lib/dag-batch.ts";
import type { DagGraph, DagNodeStatus } from "../src/shared/dag.ts";
import type { ToolCallBlock } from "../src/shared/types.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));
const graph = (conversationId: string, status: DagNodeStatus = "running"): DagGraph => ({
  conversationId, createdAt: 1, updatedAt: 1,
  nodes: [{ id: "T-0001", title: conversationId, instruction: "work", profile: { name: "worker", instructions: "work" }, dependsOn: [], createdAt: 1, status }],
});

function fixture() {
  let changed!: (value: { conversationId: string; graph: DagGraph | null }) => void;
  let resolve!: (list: DagGraph[]) => void;
  let reject!: (error: Error) => void;
  let graphs: Record<string, DagGraph> = {};
  let unsubscribed = false;
  const stop = watchDagGraphs({
    list: () => new Promise<DagGraph[]>((yes, no) => { resolve = yes; reject = no; }),
    onChanged: (listener) => { changed = listener; return () => { unsubscribed = true; }; },
  }, {
    apply: (id, value) => { if (value) graphs[id] = value; else delete graphs[id]; },
    replaceAll: (list) => { graphs = Object.fromEntries(list.map((value) => [value.conversationId, value])); },
  });
  return { changed, resolve, reject, stop, get graphs() { return graphs; }, get unsubscribed() { return unsubscribed; } };
}

test("initial DAG snapshot preserves intervening completion, creation and deletion pushes", async () => {
  const f = fixture();
  f.changed({ conversationId: "c1", graph: graph("c1", "completed") });
  f.changed({ conversationId: "deleted", graph: null });
  f.changed({ conversationId: "new", graph: graph("new") });
  f.resolve([graph("c1"), graph("deleted"), graph("unchanged")]);
  await tick();
  assert.equal(f.graphs.c1.nodes[0].status, "completed");
  assert.equal(f.graphs.deleted, undefined);
  assert.ok(f.graphs.new);
  assert.ok(f.graphs.unchanged);
  f.changed({ conversationId: "new", graph: graph("new", "failed") });
  assert.equal(f.graphs.new.nodes[0].status, "failed");
  f.stop();
});

test("DAG subscription survives a failed list and ignores responses after disposal", async () => {
  const failed = fixture();
  failed.reject(new Error("offline"));
  await tick();
  failed.changed({ conversationId: "c1", graph: graph("c1") });
  assert.ok(failed.graphs.c1);
  failed.stop();
  const disposed = fixture();
  disposed.stop();
  disposed.resolve([graph("old")]);
  disposed.changed({ conversationId: "late", graph: graph("late") });
  await tick();
  assert.deepEqual(disposed.graphs, {});
  assert.equal(disposed.unsubscribed, true);
});

test("DAG batches resolve only inside the owning transcript, even when every host has T-0001", () => {
  const owners = ["c1", "remote:a:c1", "remote:b:c1"];
  const graphs = Object.fromEntries(owners.map((id) => [id, graph(id)]));
  const tool = { id: "call", name: "dag_add_tasks", status: "completed", result: JSON.stringify({ added: [{ id: "T-0001" }] }) } as ToolCallBlock;
  const ids = addedDagIds(tool);
  for (const owner of owners) {
    const batch = dagBatch(graphs[owner], owner, ids)!;
    assert.equal(batch.conversationId, owner);
    assert.equal(batch.nodes[0].title, owner);
  }
  assert.equal(dagBatch(graphs.c1, "remote:a:c1", ids), null, "a mismatched graph cannot target another host");
  assert.equal(dagBatch(undefined, "missing", ids), null);
  assert.equal(dagBatch(graphs.c1, null, ids), null);
  assert.equal(dagBatch(graphs.c1, "c1", []), null);
});
