import test from "node:test";
import assert from "node:assert/strict";
import { flushStartup, formatTimeline, markStartup, resetStartupTimeline, watchEventLoop } from "../src/main/engine/startup-timeline.ts";

test("the timeline lists phases in the order they happened, whatever order they were recorded in", () => {
  assert.equal(formatTimeline(new Map([["engine-ready", 900], ["app-ready", 240], ["window-shown", 520]])), "app-ready 240, window-shown 520, engine-ready 900");
});

test("the line is written once, when both the window and the engine are up", () => {
  const lines: string[] = [];
  resetStartupTimeline((line) => lines.push(line));
  markStartup("app-ready");
  markStartup("window-shown");
  assert.equal(lines.length, 0, "the engine is not up yet");
  markStartup("engine-ready");
  assert.equal(lines.length, 1);
  assert.match(lines[0], /^\[startup\] .*app-ready \d+, window-shown \d+, engine-ready \d+/);
  markStartup("mcp-connected");
  flushStartup();
  assert.equal(lines.length, 1, "a later phase or an explicit flush does not write it again");
});

test("a phase keeps its first time: a window opened later is not the launch", async () => {
  const lines: string[] = [];
  resetStartupTimeline((line) => lines.push(line));
  markStartup("window-shown");
  await new Promise((resolve) => setTimeout(resolve, 30));
  markStartup("window-shown");
  markStartup("engine-ready");
  const times = [...lines[0].matchAll(/(window-shown|engine-ready) (\d+)/g)].map((match) => Number(match[2]));
  assert.ok(times[1] - times[0] >= 20, "the engine mark is later than the first window mark, not the second");
});

test("the event-loop watcher stays silent for a healthy minute and reports a stall", async () => {
  const lines: string[] = [];
  const stop = watchEventLoop({ thresholdMs: 150, intervalMs: 120, write: (line) => lines.push(line) });
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.equal(lines.length, 0);
  const until = Date.now() + 300;
  while (Date.now() < until);
  await new Promise((resolve) => setTimeout(resolve, 250));
  stop();
  assert.ok(lines.length >= 1, "a 300 ms synchronous block is reported");
  assert.match(lines[0], /stalled up to \d+ ms/);
});
