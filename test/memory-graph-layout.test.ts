import { test } from "node:test";
import assert from "node:assert/strict";
import {
  layoutGraph,
  layoutMemoryCards,
  MEMORY_NODE_HEIGHT,
  MEMORY_NODE_WIDTH,
} from "../src/renderer/src/lib/memory-graph-layout.ts";

/** 关系图's node placement: deterministic, on screen, and faithful to the edges. */

const distance = (a: { x: number; y: number }, b: { x: number; y: number }): number => Math.hypot(a.x - b.x, a.y - b.y);

test("empty and single graphs", () => {
  assert.equal(layoutGraph([], []).size, 0);
  assert.deepEqual(layoutGraph(["only"], []).get("only"), { x: 0.5, y: 0.5 });
});

test("the same graph always lays out the same way, inside the padded unit square", () => {
  const ids = Array.from({ length: 40 }, (_unused, index) => `n${index}`);
  const edges = ids.slice(1).map((id, index) => ({ sourceId: ids[index], targetId: id }));
  const first = layoutGraph(ids, edges);
  const second = layoutGraph(ids, edges);
  assert.deepEqual([...first.entries()], [...second.entries()]);
  for (const point of first.values()) {
    assert.ok(Number.isFinite(point.x) && Number.isFinite(point.y));
    assert.ok(point.x >= 0.05 && point.x <= 0.95 && point.y >= 0.05 && point.y <= 0.95);
  }
});

test("connected memories end up closer than unconnected ones", () => {
  // Two tight clusters joined by one bridge, plus parallel and dangling edges to ignore.
  const left = ["a", "b", "c", "d"];
  const right = ["w", "x", "y", "z"];
  const clique = (group: string[]) => group.flatMap((one, i) => group.slice(i + 1).map((other) => ({ sourceId: one, targetId: other })));
  const edges = [...clique(left), ...clique(right), { sourceId: "d", targetId: "w" }, { sourceId: "a", targetId: "b" }, { sourceId: "a", targetId: "gone" }, { sourceId: "c", targetId: "c" }];
  const points = layoutGraph([...left, ...right], edges);
  const within = distance(points.get("a")!, points.get("b")!);
  const across = distance(points.get("a")!, points.get("z")!);
  assert.ok(within < across, `within ${within} should be < across ${across}`);
});

test("a dense core does not collapse beside memories with no links", () => {
  const core = Array.from({ length: 70 }, (_unused, index) => `c${index}`);
  const outliers = Array.from({ length: 10 }, (_unused, index) => `o${index}`);
  const edges = core.flatMap((id, index) => [
    { sourceId: id, targetId: core[(index + 1) % core.length] },
    { sourceId: id, targetId: core[(index + 5) % core.length] },
  ]);
  const points = layoutGraph([...core, ...outliers], edges);
  let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
  for (const point of points.values()) {
    minX = Math.min(minX, point.x); maxX = Math.max(maxX, point.x);
    minY = Math.min(minY, point.y); maxY = Math.max(maxY, point.y);
  }
  const span = Math.max(maxX - minX, maxY - minY);
  let nearest = Infinity;
  for (let i = 0; i < core.length; i++) {
    const one = points.get(core[i])!;
    for (let j = i + 1; j < core.length; j++) {
      nearest = Math.min(nearest, distance(one, points.get(core[j])!));
    }
  }
  assert.ok(nearest / span > 0.025, `core spacing ${nearest} is only ${(nearest / span).toFixed(4)} of the frame`);
});

test("coincident starts and unconnected nodes still separate", () => {
  const points = layoutGraph(["p", "q", "r"], []);
  const [p, q, r] = ["p", "q", "r"].map((id) => points.get(id)!);
  assert.ok(distance(p, q) > 0.1 && distance(q, r) > 0.1 && distance(p, r) > 0.1);
});

test("memory cards are deterministic and never overlap", () => {
  const ids = Array.from({ length: 120 }, (_unused, index) => `memory-${index}`);
  const edges = ids.slice(1).map((id, index) => ({ sourceId: ids[index], targetId: id }));
  const first = layoutMemoryCards(ids, edges, { iterations: 12 });
  const second = layoutMemoryCards(ids, edges, { iterations: 12 });
  assert.deepEqual([...first.entries()], [...second.entries()]);
  for (let i = 0; i < ids.length; i++) {
    const one = first.get(ids[i])!;
    assert.ok(Number.isFinite(one.x) && Number.isFinite(one.y));
    for (let j = i + 1; j < ids.length; j++) {
      const other = first.get(ids[j])!;
      const separated = one.x + MEMORY_NODE_WIDTH <= other.x
        || other.x + MEMORY_NODE_WIDTH <= one.x
        || one.y + MEMORY_NODE_HEIGHT <= other.y
        || other.y + MEMORY_NODE_HEIGHT <= one.y;
      assert.ok(separated, `${ids[i]} overlaps ${ids[j]}`);
    }
  }
});

test("a single memory card starts at the canvas origin", () => {
  assert.deepEqual(layoutMemoryCards(["only"], []), new Map([["only", { x: 0, y: 0 }]]));
});
