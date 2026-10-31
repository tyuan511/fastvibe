import assert from "node:assert/strict";
import test from "node:test";
import { LIVE_PARSE_THRESHOLD_CHARS, liveParseInterval, mayShowLive } from "../src/renderer/src/lib/markdown-live.ts";

test("a small block streams in real time", () => {
  assert.equal(liveParseInterval(0), 0);
  assert.equal(liveParseInterval(LIVE_PARSE_THRESHOLD_CHARS - 1), 0);
  assert.equal(mayShowLive(100, Date.now(), Date.now()), true, "no wait at all below the threshold");
});

test("a large block's cadence grows with its size and is capped", () => {
  const at16k = liveParseInterval(16 * 1024);
  const at64k = liveParseInterval(64 * 1024);
  assert.ok(at16k > 0 && at64k > at16k, "larger blocks wait longer between parses");
  assert.equal(liveParseInterval(10 * 1024 * 1024), 400, "the cap keeps the text from looking stuck");
});

test("the cadence is measured from the last shown version, so a steady stream still updates", () => {
  const size = 64 * 1024;
  const interval = liveParseInterval(size);
  const shownAt = 1_000;
  assert.equal(mayShowLive(size, shownAt, shownAt + interval - 1), false);
  assert.equal(mayShowLive(size, shownAt, shownAt + interval), true);
});
