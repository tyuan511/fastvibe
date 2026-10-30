import assert from "node:assert/strict";
import { test } from "node:test";
import { isProgrammaticScroll, scrollMark, SCROLL_MARK_TTL_MS } from "../src/renderer/src/lib/scroll-follow.ts";

const now = 1_000_000;

test("a scroll the list did not perform belongs to the reader", () => {
  assert.equal(isProgrammaticScroll(null, 400, now), false);
});

test("a follow scroll explains the events it produced", () => {
  const mark = scrollMark(600, 900, now);
  // The event Chromium dispatches lands on the target…
  assert.equal(isProgrammaticScroll(mark, 900, now), true);
  // …and one from an intermediate position belongs to the same scroll.
  assert.equal(isProgrammaticScroll(mark, 700, now), true);
  assert.equal(isProgrammaticScroll(mark, 600, now), true);
});

test("the reader's wheel is not mistaken for the list's own scroll", () => {
  const mark = scrollMark(600, 900, now);
  // Following a streaming reply scrolls on every flush; the wheel starts from wherever
  // the last one left the viewport and moves the other way.
  assert.equal(isProgrammaticScroll(mark, 520, now), false);
  assert.equal(isProgrammaticScroll(mark, 0, now), false);
});

test("a stale mark explains nothing", () => {
  const mark = scrollMark(600, 900, now);
  assert.equal(isProgrammaticScroll(mark, 900, now + SCROLL_MARK_TTL_MS + 1), false);
});

test("a scroll that moves nothing is not recorded", () => {
  // Already at the bottom: there is no scroll to claim, so the reader's next one stands.
  assert.equal(scrollMark(900, 900, now), null);
  assert.equal(scrollMark(900, 901, now), null);
});

test("a jump in either direction is the list's", () => {
  assert.equal(isProgrammaticScroll(scrollMark(800, 0, now), 0, now), true);
  assert.equal(isProgrammaticScroll(scrollMark(800, 0, now), 400, now), true);
});
