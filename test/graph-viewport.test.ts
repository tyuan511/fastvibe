import { test } from "node:test";
import assert from "node:assert/strict";
import { MAX_SPAN, MIN_SPAN, boundsOf, fitView, panBy, pixelToData, wheelFactor, zoomAt, zoomPercent } from "../src/renderer/src/lib/graph-viewport.ts";

/** 关系图's pan and zoom: the point under the pointer stays put, and nothing stretches. */

const size = { width: 800, height: 400 };
const close = (a: number, b: number): boolean => Math.abs(a - b) < 1e-9;

test("fitting keeps the plot's aspect ratio and centres the bounds", () => {
  const view = fitView(size, { x0: 0, x1: 1, y0: 0, y1: 1 }, 0);
  assert.ok(close((view.x1 - view.x0) / (view.y1 - view.y0), 2));
  assert.ok(close((view.x0 + view.x1) / 2, 0.5) && close((view.y0 + view.y1) / 2, 0.5));
  assert.ok(close(view.y0, 0) && close(view.y1, 1));
  const tall = fitView({ width: 200, height: 400 }, { x0: 0.2, x1: 0.4, y0: 0.1, y1: 0.9 }, 0);
  assert.ok(close(tall.y0, 0.1) && close(tall.y1, 0.9) && close(tall.x1 - tall.x0, 0.4));
});

test("zooming keeps the layout point under the pointer where it was", () => {
  const view = fitView(size);
  const before = pixelToData(view, size, 600, 100);
  const zoomed = zoomAt(view, size, 0.5, 600, 100);
  const after = pixelToData(zoomed, size, 600, 100);
  assert.ok(close(before.x, after.x) && close(before.y, after.y));
  assert.ok(close(zoomed.x1 - zoomed.x0, (view.x1 - view.x0) * 0.5));
  assert.equal(zoomPercent(zoomed, view), 200);
});

test("zoom stops at the span limits, still anchored", () => {
  let view = fitView(size);
  for (let step = 0; step < 50; step++) view = zoomAt(view, size, 0.5, 400, 200);
  assert.ok(close(Math.min(view.x1 - view.x0, view.y1 - view.y0), MIN_SPAN));
  for (let step = 0; step < 50; step++) view = zoomAt(view, size, 2, 400, 200);
  assert.ok(close(Math.max(view.x1 - view.x0, view.y1 - view.y0), MAX_SPAN));
});

test("panning moves the content with the pointer", () => {
  const view = fitView(size);
  const moved = panBy(view, size, 80, -40);
  const grabbed = pixelToData(view, size, 100, 100);
  const nowUnder = pixelToData(moved, size, 180, 60);
  assert.ok(close(grabbed.x, nowUnder.x) && close(grabbed.y, nowUnder.y));
});

test("bounds of points, and the wheel factor's direction and cap", () => {
  assert.deepEqual(boundsOf([{ x: 0.2, y: 0.9 }, { x: 0.7, y: 0.1 }]), { x0: 0.2, x1: 0.7, y0: 0.1, y1: 0.9 });
  assert.deepEqual(boundsOf([]), { x0: 0, x1: 1, y0: 0, y1: 1 });
  assert.ok(wheelFactor(-100, 0) < 1 && wheelFactor(100, 0) > 1);
  assert.ok(close(wheelFactor(10_000, 0), Math.E));
  assert.ok(close(wheelFactor(3, 1), wheelFactor(48, 0)));
});
