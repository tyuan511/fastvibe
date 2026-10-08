import assert from "node:assert/strict";
import test from "node:test";
import { SnapshotSync, type Snapshot } from "../apps/mobile/src/chat/snapshot-sync.ts";
import { createReplyCache } from "../apps/mobile/src/chat/reply-cache.ts";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((a, b) => { resolve = a; reject = b; });
  return { promise, resolve, reject };
}
const settle = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
const meta = (seq: number) => ({ scope: "conversation:chat", epoch: "epoch", seq });

test("streaming during the initial snapshot keeps history and applies only the uncovered deltas", async () => {
  const snapshot = deferred<Snapshot>();
  const applied: number[] = [];
  let queue: unknown;
  const sync = new SnapshotSync({
    subscribe: async () => ({ resumed: false, cursor: { epoch: "epoch", seq: 0 } }),
    load: () => snapshot.promise,
    snapshot: (value) => { applied.push(value.seq); queue = value.queue; },
    event: (event) => applied.push(Number(event.seq)), error: assert.fail,
  });
  const ready = sync.restore();
  sync.receive({ seq: 9 }, meta(1));
  sync.receive({ seq: 11 }, meta(2));
  snapshot.resolve({ seq: 10, messages: ["history"], queue: { revision: 3 } });
  await ready;
  assert.deepEqual(applied, [10, 11]);
  assert.deepEqual(queue, { revision: 3 });
  assert.deepEqual(sync.checkpoint(), { floor: 11, cursor: { epoch: "epoch", seq: 2 } });
  sync.dispose();
});

test("cold subscribe and snapshot are pipelined without waiting for an acknowledgement round trip", async () => {
  const subscribed = deferred<{ resumed: boolean }>();
  let reads = 0;
  const sync = new SnapshotSync({ subscribe: () => subscribed.promise, load: async () => { reads++; return { seq: 4 }; }, snapshot: () => {}, event: () => {}, error: assert.fail });
  const ready = sync.restore();
  await settle();
  assert.equal(reads, 1);
  subscribed.resolve({ resumed: false });
  await ready;
  sync.dispose();
});

test("named replay merges earlier missed events with wildcard live events and avoids a snapshot", async () => {
  const subscribed = deferred<{ resumed: boolean; cursor: { epoch: string; seq: number } }>();
  const applied: number[] = [];
  const sync = new SnapshotSync({ subscribe: () => subscribed.promise, load: async () => assert.fail("unnecessary snapshot"), snapshot: assert.fail, event: (event) => applied.push(Number(event.seq)), error: assert.fail });
  const ready = sync.restore({ floor: 10, cursor: { epoch: "epoch", seq: 1 } });
  sync.receive({ seq: 13 }, meta(4)); // wildcard live before subscribe reaches the server
  sync.receive({ seq: 11 }, meta(2));
  sync.receive({ seq: 12 }, meta(3));
  sync.receive({ seq: 13 }, meta(4));
  subscribed.resolve({ resumed: true, cursor: { epoch: "epoch", seq: 4 } });
  await ready;
  assert.deepEqual(applied, [11, 12, 13]);
  assert.equal(sync.checkpoint()?.cursor.seq, 4);
  sync.dispose();
});

test("a journal gap replaces stale state even if the restarted host's sequence is lower", async () => {
  const applied: number[] = [];
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false, cursor: { epoch: "new", seq: 0 } }), load: async () => ({ seq: 3 }), snapshot: (value) => applied.push(value.seq), event: (event) => applied.push(Number(event.seq)), error: assert.fail });
  await sync.restore({ floor: 500, cursor: { epoch: "old", seq: 100 } });
  sync.receive({ seq: 4 }, { ...meta(1), epoch: "new" });
  assert.deepEqual(applied, [3, 4]);
  sync.dispose();
});

test("refresh bursts share one read and changes during it schedule only one follow-up", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: Array<ReturnType<typeof deferred<Snapshot>>> = [];
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false }), load: () => { const next = deferred<Snapshot>(); requests.push(next); return next.promise; }, snapshot: () => {}, event: () => {}, error: assert.fail });
  const ready = sync.restore();
  await settle();
  requests[0].resolve({ seq: 0 }); await ready;
  const first = Array.from({ length: 30 }, () => sync.refresh());
  t.mock.timers.tick(50); await settle();
  assert.equal(requests.length, 2);
  const second = Array.from({ length: 30 }, () => sync.refresh());
  t.mock.timers.tick(500); await settle();
  assert.equal(requests.length, 2, "overlapping snapshot");
  requests[1].resolve({ seq: 1 }); await Promise.all(first); await settle();
  t.mock.timers.tick(50); await settle();
  assert.equal(requests.length, 3);
  requests[2].resolve({ seq: 2 }); await Promise.all(second);
  sync.dispose();
});

test("a refresh reconciles live deltas without applying the same text twice", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const next = deferred<Snapshot>();
  let count = 0, text = "";
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false }), load: () => ++count === 1 ? Promise.resolve({ seq: 1, messages: "a" }) : next.promise,
    snapshot: (value) => { text = String(value.messages); }, event: (value) => { text += value.delta; }, error: assert.fail });
  await sync.restore();
  const refreshed = sync.refresh(); t.mock.timers.tick(50); await settle();
  sync.receive({ seq: 2, delta: "b" }, meta(2));
  sync.receive({ seq: 3, delta: "c" }, meta(3));
  assert.equal(text, "abc", "live text must keep painting while a refresh waits");
  next.resolve({ seq: 2, messages: "ab" }); await refreshed;
  assert.equal(text, "abc");
  sync.dispose();
});

test("disposing a pending snapshot cannot write into a replacement chat", async () => {
  const snapshot = deferred<Snapshot>();
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false }), load: () => snapshot.promise, snapshot: () => assert.fail("stale snapshot"), event: assert.fail, error: assert.fail });
  const ready = sync.restore(); await settle(); sync.dispose();
  snapshot.resolve({ seq: 3 }); await ready;
});

test("completed merged replies retain identity while the active reply changes", () => {
  type Row = { role: string; text: string };
  let combinations = 0;
  const merge = createReplyCache<Row>((row) => row.role === "assistant", (a, b) => { combinations++; return { role: a.role, text: a.text + b.text }; });
  const user = { role: "user", text: "question" }, a = { role: "assistant", text: "a" }, b = { role: "assistant", text: "b" };
  const before = merge([user, a, b, user, a]);
  const after = merge([user, a, b, user, { ...a, text: "stream" }]);
  assert.equal(before[1], after[1]);
  assert.equal(combinations, 1);
  assert.equal(after.at(-1)?.text, "stream");
});

test("live wire events survive an upstream engine sequence reset and still deduplicate", async () => {
  const applied: number[] = [];
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false, cursor: { epoch: "epoch", seq: 10 } }), load: async () => ({ seq: 500 }), snapshot: () => {}, event: (event) => applied.push(Number(event.seq)), error: assert.fail });
  await sync.restore();
  sync.receive({ seq: 1 }, meta(11));
  sync.receive({ seq: 1 }, meta(11));
  sync.receive({ seq: 2 }, meta(12));
  assert.deepEqual(applied, [1, 2]);
  sync.dispose();
});

test("an in-flight snapshot satisfies boundary refreshes that its engine seq already covers", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const pending = deferred<Snapshot>();
  let reads = 0;
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false }),
    load: () => ++reads === 1 ? Promise.resolve({ seq: 1 }) : pending.promise,
    snapshot: () => {}, event: () => {}, error: assert.fail });
  await sync.restore();
  const first = sync.refresh(2);
  t.mock.timers.tick(50); await settle();
  const covered = [sync.refresh(3), sync.refresh(4), sync.refresh(5)];
  pending.resolve({ seq: 5 });
  await Promise.all([first, ...covered]); await settle();
  t.mock.timers.tick(1000); await settle();
  assert.equal(reads, 2, "covered boundaries must not cost another round trip");
  sync.dispose();
});

test("boundaries newer than the snapshot and unversioned manual refreshes still read again", async (t) => {
  t.mock.timers.enable({ apis: ["setTimeout"] });
  const requests: Array<ReturnType<typeof deferred<Snapshot>>> = [];
  const sync = new SnapshotSync({ subscribe: async () => ({ resumed: false }),
    load: () => { const pending = deferred<Snapshot>(); requests.push(pending); return pending.promise; },
    snapshot: () => {}, event: () => {}, error: assert.fail });
  const initial = sync.restore(); await settle(); requests[0].resolve({ seq: 1 }); await initial;
  const first = sync.refresh(2); t.mock.timers.tick(50); await settle();
  const covered = sync.refresh(3), newer = sync.refresh(5), manual = sync.refresh();
  requests[1].resolve({ seq: 4 }); await Promise.all([first, covered]); await settle();
  t.mock.timers.tick(50); await settle();
  assert.equal(requests.length, 3);
  requests[2].resolve({ seq: 5 }); await Promise.all([newer, manual]);
  sync.dispose();
});

test("a new rendered scope rejects late snapshots before effect cleanup can dispose the old one", async () => {
  const pending = deferred<Snapshot>();
  let current = true;
  const sync = new SnapshotSync({ isCurrent: () => current, subscribe: async () => ({ resumed: false }), load: () => pending.promise,
    snapshot: () => assert.fail("stale view write"), event: () => assert.fail("stale event"), restored: () => assert.fail("stale ready"), error: assert.fail });
  const ready = sync.restore(); await settle(); current = false;
  pending.resolve({ seq: 10 }); await ready;
  sync.receive({ seq: 11 }); assert.equal(sync.checkpoint(), undefined); sync.dispose();
});

test("a synchronized old scope can hand its checkpoint to a replacement connection", async () => {
  let current = true;
  const sync = new SnapshotSync({ isCurrent: () => current, subscribe: async () => ({ resumed: false, cursor: { epoch: "e", seq: 4 } }),
    load: async () => ({ seq: 10 }), snapshot: () => {}, event: () => {}, error: assert.fail });
  await sync.restore(); current = false;
  assert.deepEqual(sync.checkpoint(), { cursor: { epoch: "e", seq: 4 }, floor: 10 }); sync.dispose();
});
