import assert from "node:assert/strict";
import { test } from "node:test";
import { coalesce, type CoalesceClock } from "../src/renderer/src/lib/coalesce.ts";

function manualClock(): CoalesceClock & { tick(): void } {
  const queue: Array<() => void> = [];
  return {
    setTimeout(run) {
      queue.push(run);
    },
    tick() {
      for (const run of queue.splice(0)) run();
    },
  };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

test("calls made before the read starts share one read", async () => {
  const clock = manualClock();
  let reads = 0;
  const refresh = coalesce(async () => { reads += 1; }, 16, clock);
  const asked = [refresh(), refresh(), refresh()];
  assert.equal(reads, 0);
  clock.tick();
  await Promise.all(asked);
  assert.equal(reads, 1);
});

test("a call during the read gets exactly one more read after it", async () => {
  const clock = manualClock();
  let reads = 0;
  let finish!: () => void;
  const refresh = coalesce(() => {
    reads += 1;
    return new Promise<void>((resolve) => { finish = resolve; });
  }, 16, clock);
  const first = refresh();
  clock.tick();
  assert.equal(reads, 1);
  const second = refresh();
  const third = refresh();
  assert.notEqual(second, first);
  finish();
  await first;
  await flush();
  clock.tick();
  assert.equal(reads, 2);
  finish();
  await Promise.all([second, third]);
  assert.equal(reads, 2);
});

test("a failing read still resolves its callers and does not stop later reads", async () => {
  const clock = manualClock();
  let reads = 0;
  const refresh = coalesce(async () => {
    reads += 1;
    throw new Error("offline");
  }, 16, clock);
  const asked = refresh();
  clock.tick();
  await asked;
  const again = refresh();
  clock.tick();
  await again;
  assert.equal(reads, 2);
});
