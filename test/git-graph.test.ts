import assert from "node:assert/strict";
import test from "node:test";
import { layoutGitGraph } from "../src/renderer/src/lib/git-graph.ts";
import type { GitHistoryEntry } from "../src/shared/ipc.ts";
const commit = (hash: string, parents: string[]): GitHistoryEntry => ({ hash, parents, subject: hash, body: hash, author: "Test", date: "2026-10-17", refs: [], isHead: hash === "A" });

test("commit graph draws both merge parents and rejoins the shared ancestor", () => {
  const graph = layoutGitGraph([commit("A", ["B", "C"]), commit("B", ["D"]), commit("C", ["D"]), commit("D", [])]);
  assert.equal(graph.columns, 2);
  assert.deepEqual(graph.rows.map((row) => row.column), [0, 0, 1, 0]);
  assert.deepEqual(graph.rows[0].edges.filter((edge) => edge.kind === "out").map(({ from, to }) => [from, to]), [[0, 0], [0, 1]]);
  assert.ok(graph.rows[1].edges.some((edge) => edge.kind === "through" && edge.from === 1 && edge.to === 1));
  assert.ok(graph.rows[2].edges.some((edge) => edge.kind === "out" && edge.from === 1 && edge.to === 0));
  assert.equal(graph.rows[3].edges.filter((edge) => edge.kind === "out").length, 0);
});

test("unrelated roots are not connected and loading older pages keeps existing lane colors", () => {
  const first = [commit("A", ["B"]), commit("X", []), commit("B", ["C"])];
  const before = layoutGitGraph(first);
  assert.equal(before.rows[1].edges.filter((edge) => edge.kind !== "through").length, 0);
  const after = layoutGitGraph([...first, commit("C", [])]);
  assert.deepEqual(after.rows.slice(0, 3), before.rows);
});
