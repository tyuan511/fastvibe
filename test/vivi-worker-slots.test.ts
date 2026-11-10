import assert from "node:assert/strict";
import test from "node:test";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { WorkerSlots } from "../src/main/bot/shadow/worker-slots.ts";
const binding = (ticketId: string, assignmentId = "a") => ({ ticketId, assignmentId, generation: 1, claimToken: 1 });
function fixture(t: test.TestContext, max = 2) { const store = openShadowStore(":memory:"); let now = 0; const slots = new WorkerSlots(store, { max: () => max, now: () => now, leaseMs: 10, owner: "owner-a" }); t.after(() => store.close()); return { store, slots, advance: (n: number) => { now += n; } }; }

test("reserve is idempotent per ticket and launch capacity excludes launch reservations", t => { const f = fixture(t, 2); const a = f.slots.reserve("t1", "launch", binding("t1")); assert.equal(f.slots.reserve("t1", "launch", binding("t1")).revision, a.revision); assert.equal(f.slots.launches(), 2); const b = f.slots.reserve("t2", "wake", binding("t2")); assert.equal(f.slots.launches(), 1); assert.equal(f.slots.used(), 2); });

test("person wake gets one extra slot, second person does not", t => { const f = fixture(t, 1); f.slots.reserve("t1", "launch", binding("t1")); const p = f.slots.reserve("t2", "person", binding("t2")); assert.equal(p.by, "person"); assert.throws(() => f.slots.reserve("t3", "person", binding("t3")), /slot/); });

test("phase changes retain the lease and stale phase cannot mutate", t => { const f = fixture(t); const a = f.slots.reserve("t1", "launch", binding("t1")); const b = f.slots.phase(a, "running"); assert.equal(f.slots.valid(b), true); assert.throws(() => f.slots.phase(a, "settling"), /ownership/); const c = f.slots.phase(b, "settling"); assert.equal(c.phase, "settling"); });

test("expired slots become uncertain and remain counted until quiet reconciliation", t => { const f = fixture(t, 1); const a = f.slots.reserve("t1", "launch", binding("t1")); f.advance(20); f.slots.used(); assert.equal(f.slots.records()[0]!.phase, "uncertain"); assert.equal(f.slots.used(), 1); assert.equal(f.slots.reconcile(a, { quiet: false }), false); f.slots.used(); const uncertain = f.slots.records()[0]!; assert.equal(f.slots.reconcile(uncertain, { quiet: true }), true); assert.equal(f.slots.used(), 0); });

test("stale owner cannot release a replacement slot", t => { const f = fixture(t); const a = f.slots.reserve("t1", "launch", binding("t1")); f.advance(20); f.slots.used(); assert.equal(f.slots.reconcile(f.slots.records()[0]!, { quiet: true }), true); const b = f.slots.reserve("t1", "launch", binding("t1", "b")); assert.equal(f.slots.release(a), false); assert.equal(f.slots.get("t1")?.binding.assignmentId, "b"); });

test("cross connection cannot reserve the same live ticket", t => { const f = fixture(t); const other = new WorkerSlots(f.store, { max: () => 2, now: () => 0, leaseMs: 10, owner: "owner-b" }); const a = f.slots.reserve("t1", "launch", binding("t1")); assert.throws(() => other.reserve("t1", "launch", binding("t1")), /active|owned/); assert.equal(f.slots.valid(a), true); });
