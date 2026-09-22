import assert from "node:assert/strict";
import test from "node:test";
import { ALL_SCOPES } from "../src/shared/app-protocol.ts";
import { EventBus, scopeForChannel, stableEventId } from "../src/main/app-server/event-bus.ts";

test("publish assigns a stable id once, with no client attached", () => {
  const bus = new EventBus({ epoch: "epoch-1" });
  const first = bus.publish("installation", "workspace:changed", { n: 1 });
  assert.equal(first.seq, 1);
  assert.equal(first.epoch, "epoch-1");
  assert.equal(first.eventId, stableEventId("epoch-1", "installation", 1));
  assert.equal(bus.sequence("installation"), 1);
  const second = bus.publish("installation", "workspace:changed", { n: 2 });
  assert.equal(second.seq, 2);
  assert.equal(second.eventId, stableEventId("epoch-1", "installation", 2));
});

test("resume: empty / pruned / future / epoch / wildcard", () => {
  const bus = new EventBus({ epoch: "e0", maxPerScope: 2 });
  assert.deepEqual(bus.resume("installation", { epoch: "e0", seq: 0 }), { kind: "current" });
  assert.equal(bus.resume("installation", { epoch: "e0", seq: 4 }).kind, "resync");

  bus.publish("installation", "workspace:changed", 1);
  bus.publish("installation", "workspace:changed", 2);
  bus.publish("installation", "workspace:changed", 3);

  assert.equal(bus.resume("installation", { epoch: "e0", seq: 0 }).kind, "resync");
  const kept = bus.resume("installation", { epoch: "e0", seq: 1 });
  assert.equal(kept.kind, "events");
  if (kept.kind === "events") {
    assert.deepEqual(kept.events.map((record) => record.seq), [2, 3]);
    assert.equal(kept.events[0]?.eventId, stableEventId("e0", "installation", 2));
  }
  assert.deepEqual(bus.resume("installation", { epoch: "e0", seq: 3 }), { kind: "current" });
  assert.equal(bus.resume("installation", { epoch: "e0", seq: 9 }).kind, "resync");
  assert.equal(bus.resume("installation", { epoch: "other", seq: 3 }).kind, "resync");
  assert.equal(bus.resume(ALL_SCOPES, { epoch: "e0", seq: 0 }).kind, "resync");
});

test("trim on resume by age, including a fully pruned journal", () => {
  let now = 1_000;
  const bus = new EventBus({ epoch: "e0", maxAgeMs: 10, now: () => now, maxPerScope: 50 });
  bus.publish("conversation:c1", "engine:event", "a");
  now = 1_005;
  bus.publish("conversation:c1", "engine:event", "b");
  now = 1_020;
  const pruned = bus.resume("conversation:c1", { epoch: "e0", seq: 1 });
  assert.equal(pruned.kind, "resync");
  assert.equal(bus.resume("conversation:c1", { epoch: "e0", seq: 2 }).kind, "current");
});

test("scopeForChannel prefers an explicit conversation id", () => {
  assert.equal(scopeForChannel("engine:event", { conversationId: "c1" }), "conversation:c1");
  assert.equal(scopeForChannel("engine:event", {}, "c2"), "conversation:c2");
  assert.equal(scopeForChannel("workspace:changed", { project: "p1" }), "workspace:p1");
  assert.equal(scopeForChannel("settings:changed", {}), "installation");
});

test("forgotten scopes keep their sequence watermark", () => {
  const bus = new EventBus({ epoch: "e0" });
  bus.publish("conversation:c1", "x", { n: 1 });
  bus.forget("conversation:c1");
  assert.equal(bus.publish("conversation:c1", "x", { n: 2 }).seq, 2);
});

test("replay rejects excluded history instead of creating a cursor hole", () => {
  const bus = new EventBus({ epoch: "e0" });
  bus.publish("installation", "x", 1, { except: "a" });
  assert.equal(bus.resume("installation", { epoch: "e0", seq: 0 }, "a").kind, "resync");
});
