import assert from "node:assert/strict";
import { test } from "node:test";
import { ToolDeltaThrottle, toolDeltaInterval, type ThrottleClock } from "../src/main/pi/tool-delta-throttle.ts";

/** A clock the test moves by hand, with timers that fire when it passes them. */
function manualClock(): ThrottleClock & { advance(ms: number): void } {
  let now = 0;
  let next = 1;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    now: () => now,
    setTimeout(run, ms) {
      const id = next++;
      timers.set(id, { at: now + ms, run });
      return id as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout(timer) {
      timers.delete(timer as unknown as number);
    },
    advance(ms) {
      now += ms;
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}

const delta = (text: string, contentIndex = 0) => ({
  type: "message_update",
  assistantMessageEvent: { type: "toolcall_delta", contentIndex, delta: text },
});

test("a burst of deltas becomes the first one and then the newest per window", () => {
  const clock = manualClock();
  const throttle = new ToolDeltaThrottle(clock);
  const sent: number[] = [];
  for (let n = 0; n < 50; n += 1) {
    assert.equal(throttle.offer("c", delta("x".repeat(40)), { n }, (payload) => sent.push(payload.n as number)), true);
    clock.advance(4);
  }
  clock.advance(1_000);
  // 50 deltas over 200ms: the first goes at once, the window then hands over only the latest.
  assert.ok(sent.length <= 4, `sent ${sent.length}`);
  assert.equal(sent[0], 0);
  assert.equal(sent.at(-1), 49);
});

test("anything else from the same owner delivers the held delta first", () => {
  const clock = manualClock();
  const throttle = new ToolDeltaThrottle(clock);
  const order: string[] = [];
  throttle.offer("c", delta("a"), { id: "d1" }, (payload) => order.push(String(payload.id)));
  throttle.offer("c", delta("b"), { id: "d2" }, (payload) => order.push(String(payload.id)));
  const end = { type: "message_update", assistantMessageEvent: { type: "toolcall_end", contentIndex: 0 } };
  assert.equal(throttle.offer("c", end, { id: "end" }, () => assert.fail("not a delta")), false);
  throttle.release("c");
  order.push("end");
  assert.deepEqual(order, ["d1", "d2", "end"]);
  clock.advance(5_000);
  assert.deepEqual(order, ["d1", "d2", "end"]);
});

test("owners and content blocks are throttled apart", () => {
  const clock = manualClock();
  const throttle = new ToolDeltaThrottle(clock);
  const sent: string[] = [];
  throttle.offer("a", delta("x"), { id: "a0" }, (payload) => sent.push(String(payload.id)));
  throttle.offer("b", delta("x"), { id: "b0" }, (payload) => sent.push(String(payload.id)));
  throttle.offer("a", delta("x"), { id: "a1" }, (payload) => sent.push(String(payload.id)));
  // A second tool call in the same message starts by flushing the first one's held delta.
  throttle.offer("a", delta("y", 1), { id: "a-next" }, (payload) => sent.push(String(payload.id)));
  assert.deepEqual(sent, ["a0", "b0", "a1", "a-next"]);
});

test("the window grows with the arguments and stays bounded", () => {
  assert.equal(toolDeltaInterval(0), 100);
  assert.equal(toolDeltaInterval(10_000), 100);
  assert.equal(toolDeltaInterval(50_000), 500);
  assert.equal(toolDeltaInterval(5_000_000), 1_000);
});

test("streaming a 100 KB write forwards a small bounded number of payloads", () => {
  const clock = manualClock();
  const throttle = new ToolDeltaThrottle(clock);
  let forwarded = 0;
  let bytes = 0;
  const size = 100_000;
  // ~2,500 deltas over 25 seconds, each payload carrying the arguments so far.
  for (let received = 40; received <= size; received += 40) {
    throttle.offer("c", delta("x".repeat(40)), { received }, (payload) => {
      forwarded += 1;
      bytes += payload.received as number;
    });
    clock.advance(10);
  }
  throttle.release("c");
  assert.ok(forwarded < 120, `forwarded ${forwarded}`);
  assert.ok(bytes < 8_000_000, `bytes ${bytes}`);
});

test("a dropped owner delivers nothing later", () => {
  const clock = manualClock();
  const throttle = new ToolDeltaThrottle(clock);
  const sent: unknown[] = [];
  throttle.offer("c", delta("a"), { id: 1 }, (payload) => sent.push(payload));
  throttle.offer("c", delta("b"), { id: 2 }, (payload) => sent.push(payload));
  throttle.drop("c");
  clock.advance(5_000);
  assert.equal(sent.length, 1);
});
