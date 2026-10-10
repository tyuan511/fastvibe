import assert from "node:assert/strict";
import test from "node:test";
import { activeTurnIndex } from "../src/renderer/src/lib/turn-rail.ts";

// A turn lights up once its prompt has reached the reading line, and it stays lit
// for the whole of its reply: the next turn only takes over when its own prompt
// crosses that line. The reading line is the viewport's scroll offset plus its top
// inset, so the numbers below are already in that coordinate.

test("the last turn whose prompt has reached the reading line is the active one", () => {
  const starts = [0, 400, 900, 1600];
  assert.equal(activeTurnIndex(starts, 0), 0);
  // Still inside the first turn's reply, just short of the second prompt.
  assert.equal(activeTurnIndex(starts, 399), 0);
  assert.equal(activeTurnIndex(starts, 400), 1);
  // Deep inside a long reply, nowhere near its own prompt.
  assert.equal(activeTurnIndex(starts, 1500), 2);
  assert.equal(activeTurnIndex(starts, 5000), 3);
});

test("a turn the virtualizer has not measured yet cannot win", () => {
  // The tail is still an estimate with no recorded position.
  assert.equal(activeTurnIndex([0, 400, undefined, undefined], 5000), 1);
  assert.equal(activeTurnIndex([undefined, undefined], 0), -1);
  assert.equal(activeTurnIndex([], 0), -1);
});
