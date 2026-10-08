import assert from "node:assert/strict";
import test from "node:test";
import {
  BackpressureGuard,
  BUFFER_SOFT_LIMIT,
  BUFFER_HARD_LIMIT,
  BUFFER_GRACE_MS,
  BUFFER_MAX_PENDING_MS,
} from "../src/main/server/backpressure.ts";

const SNAPSHOT_BYTES = 3 * 1024 * 1024;

test("a multi-MiB frame being compressed is a burst, not a slow peer", () => {
  const guard = new BackpressureGuard();
  assert.equal(guard.observe(0, 0), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, 1), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES + 512, 2), null);
  assert.equal(guard.observe(0, 20), null);
});

test("sustained soft-limit congestion still closes after its grace period", () => {
  const guard = new BackpressureGuard();
  assert.equal(guard.observe(SNAPSHOT_BYTES, 0), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS - 1), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS), "sustained");
});

test("a send completion that drains resets the clock between independent bursts", () => {
  const guard = new BackpressureGuard();
  assert.equal(guard.observe(SNAPSHOT_BYTES, 0), null);
  assert.equal(guard.observe(BUFFER_SOFT_LIMIT, 10), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 2), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 3 - 1), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 3), "sustained");
});

test("a slow but draining snapshot survives longer than the stall grace", () => {
  const guard = new BackpressureGuard();
  assert.equal(guard.observe(SNAPSHOT_BYTES * 2, 0), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES * 1.5, BUFFER_GRACE_MS), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 2), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 3), "sustained");
});

test("a single old frame still has a deadline even with partial drain progress", () => {
  const guard = new BackpressureGuard();
  guard.trackSend(0);
  let bytes = 20 * 1024 * 1024;
  for (let now = 0; now < BUFFER_MAX_PENDING_MS; now += 5_000) {
    assert.equal(guard.observe(bytes, now), null);
    bytes -= 64 * 1024;
  }
  assert.equal(guard.observe(bytes, BUFFER_MAX_PENDING_MS), "pending-timeout");
});

test("fast output refilling a draining queue is not a stalled or expired stream", () => {
  const guard = new BackpressureGuard();
  // Three outstanding frames, replaced at the same rate they are sent. The
  // backlog never drops, but each frame waits only three seconds.
  const writes = Array.from({ length: 3 }, () => guard.trackSend(0));
  guard.observe(SNAPSHOT_BYTES, 0);
  for (let now = 1_000; now <= BUFFER_MAX_PENDING_MS * 3; now += 1_000) {
    writes.shift()!(now);
    writes.push(guard.trackSend(now));
    assert.equal(guard.observe(SNAPSHOT_BYTES, now), null);
  }
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_MAX_PENDING_MS * 3 + BUFFER_GRACE_MS), "sustained");
});

test("completed writes do not exempt a growing stream from the memory limit", () => {
  const guard = new BackpressureGuard();
  const sent = guard.trackSend(0);
  guard.observe(SNAPSHOT_BYTES, 0);
  sent(1_000);
  assert.equal(guard.observe(BUFFER_HARD_LIMIT + 1, 1_001), "hard-limit");
});

test("small actual writes renew grace, but duplicate and retired callbacks cannot", () => {
  const guard = new BackpressureGuard();
  const sent = guard.trackSend(0);
  guard.observe(SNAPSHOT_BYTES, 0);
  sent(BUFFER_GRACE_MS - 1);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS), null);
  sent(BUFFER_GRACE_MS * 2);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 2), "sustained");
  const retired = guard.trackSend(BUFFER_GRACE_MS * 2);
  guard.clear();
  guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 3);
  retired(BUFFER_GRACE_MS * 4);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS * 4), "sustained");
});

test("tiny drips and growing backlogs cannot indefinitely renew grace", () => {
  const guard = new BackpressureGuard();
  guard.observe(SNAPSHOT_BYTES, 0);
  assert.equal(guard.observe(SNAPSHOT_BYTES - 1, BUFFER_GRACE_MS), "sustained");
  const growing = new BackpressureGuard();
  growing.observe(SNAPSHOT_BYTES, 0);
  assert.equal(growing.observe(SNAPSHOT_BYTES + 1, BUFFER_GRACE_MS), "sustained");
});

test("a hard-limit backlog is refused immediately, even within the grace period", () => {
  const guard = new BackpressureGuard();
  assert.equal(guard.observe(SNAPSHOT_BYTES, 0), null);
  assert.equal(guard.observe(BUFFER_HARD_LIMIT + 1, 1), "hard-limit");
  assert.equal(new BackpressureGuard().observe(BUFFER_HARD_LIMIT + 1, 0), "hard-limit");
});

test("new connections do not inherit another client's congestion clock", () => {
  const slow = new BackpressureGuard();
  slow.observe(SNAPSHOT_BYTES, 0);
  assert.equal(slow.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS), "sustained");
  assert.equal(new BackpressureGuard().observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS), null);
});
