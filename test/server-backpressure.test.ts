import assert from "node:assert/strict";
import test from "node:test";
import {
  BackpressureGuard,
  BUFFER_SOFT_LIMIT,
  BUFFER_HARD_LIMIT,
  BUFFER_GRACE_MS,
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

test("partial progress above the soft watermark does not extend grace forever", () => {
  const guard = new BackpressureGuard();
  assert.equal(guard.observe(SNAPSHOT_BYTES * 2, 0), null);
  assert.equal(guard.observe(SNAPSHOT_BYTES, BUFFER_GRACE_MS), "sustained");
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
