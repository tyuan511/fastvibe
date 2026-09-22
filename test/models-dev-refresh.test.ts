import assert from "node:assert/strict";
import { test } from "node:test";
import {
  nextModelsDevRefreshDelay,
  startModelsDevRefresh,
  type TimerHandle,
} from "../src/main/engine/models-dev-refresh.ts";

const HOUR = 60 * 60 * 1000;
const START = 15_000;

test("a fresh snapshot waits out the rest of its hour", () => {
  const now = 10_000_000;
  assert.equal(
    nextModelsDevRefreshDelay({ now, generatedAt: now - 10 * 60_000, lastAttemptAt: 0, intervalMs: HOUR, startDelayMs: START }),
    50 * 60_000,
  );
});

test("an overdue or missing snapshot waits only the launch delay", () => {
  const now = 10_000_000;
  assert.equal(
    nextModelsDevRefreshDelay({ now, generatedAt: now - 3 * HOUR, lastAttemptAt: 0, intervalMs: HOUR, startDelayMs: START }),
    START,
  );
  assert.equal(
    nextModelsDevRefreshDelay({ now, generatedAt: 0, lastAttemptAt: 0, intervalMs: HOUR, startDelayMs: START }),
    START,
  );
});

test("a failed attempt does not retry until a full interval has passed", () => {
  const now = 10_000_000;
  assert.equal(
    nextModelsDevRefreshDelay({
      now,
      generatedAt: now - 5 * HOUR,
      lastAttemptAt: now,
      intervalMs: HOUR,
      startDelayMs: START,
    }),
    HOUR,
  );
});

test("a generatedAt far in the future is clamped to one interval", () => {
  const now = 10_000_000;
  assert.equal(
    nextModelsDevRefreshDelay({ now, generatedAt: now + 7 * HOUR, lastAttemptAt: 0, intervalMs: HOUR, startDelayMs: START }),
    HOUR,
  );
});

type Pending = { at: number; fn: () => void; cancelled: boolean };

function clock() {
  let now = 1_000_000;
  const pending: Pending[] = [];
  return {
    now: () => now,
    setTimer(fn: () => void, delayMs: number): TimerHandle {
      const entry: Pending = { at: now + delayMs, fn, cancelled: false };
      pending.push(entry);
      return { cancel: () => { entry.cancelled = true; } };
    },
    async advance(ms: number): Promise<void> {
      now += ms;
      for (;;) {
        const due = pending
          .filter((entry) => !entry.cancelled && entry.at <= now)
          .sort((a, b) => a.at - b.at);
        if (due.length === 0) return;
        const next = due[0]!;
        pending.splice(pending.indexOf(next), 1);
        next.fn();
        for (let i = 0; i < 20; i++) await Promise.resolve();
      }
    },
    pending: () => pending.filter((entry) => !entry.cancelled).length,
  };
}

test("a stale snapshot refreshes after the launch delay, then not again until the hour is up", async () => {
  const time = clock();
  let generatedAt = time.now() - 2 * HOUR;
  let refreshes = 0;
  startModelsDevRefresh({
    now: time.now,
    generatedAt: () => generatedAt,
    refresh: async () => {
      refreshes += 1;
      generatedAt = time.now();
    },
    setTimer: time.setTimer,
    intervalMs: HOUR,
    startDelayMs: START,
  });
  assert.equal(refreshes, 0);
  await time.advance(START - 1);
  assert.equal(refreshes, 0);
  await time.advance(1);
  assert.equal(refreshes, 1);
  await time.advance(HOUR - 1);
  assert.equal(refreshes, 1);
  await time.advance(1);
  assert.equal(refreshes, 2);
});

test("a snapshot updated while waiting is not downloaded again when the old timer fires", async () => {
  const time = clock();
  let generatedAt = time.now() - 2 * HOUR;
  let refreshes = 0;
  startModelsDevRefresh({
    now: time.now,
    generatedAt: () => generatedAt,
    refresh: async () => {
      refreshes += 1;
      generatedAt = time.now();
    },
    setTimer: time.setTimer,
    intervalMs: HOUR,
    startDelayMs: START,
  });
  // What 设置 → 关于 does during the launch delay: the snapshot is fresh before the timer fires.
  generatedAt = time.now();
  await time.advance(START);
  assert.equal(refreshes, 0);
  // The skipped tick rearms from the manual update, which is START earlier than a full hour from now.
  await time.advance(HOUR - START - 1);
  assert.equal(refreshes, 0);
  await time.advance(1);
  assert.equal(refreshes, 1);
});

test("a failed attempt is logged and retried an hour later, not immediately", async () => {
  const time = clock();
  const generatedAt = time.now() - 2 * HOUR;
  let attempts = 0;
  let errors = 0;
  startModelsDevRefresh({
    now: time.now,
    generatedAt: () => generatedAt,
    refresh: async () => {
      attempts += 1;
      throw new Error("offline");
    },
    onError: () => {
      errors += 1;
    },
    setTimer: time.setTimer,
    intervalMs: HOUR,
    startDelayMs: START,
  });
  await time.advance(START);
  assert.equal(attempts, 1);
  assert.equal(errors, 1);
  await time.advance(HOUR - 1);
  assert.equal(attempts, 1);
  await time.advance(1);
  assert.equal(attempts, 2);
});

test("stopping cancels the pending refresh", async () => {
  const time = clock();
  let refreshes = 0;
  const stop = startModelsDevRefresh({
    now: time.now,
    generatedAt: () => 0,
    refresh: async () => {
      refreshes += 1;
    },
    setTimer: time.setTimer,
    intervalMs: HOUR,
    startDelayMs: START,
  });
  stop();
  await time.advance(START + HOUR);
  assert.equal(refreshes, 0);
  assert.equal(time.pending(), 0);
});
