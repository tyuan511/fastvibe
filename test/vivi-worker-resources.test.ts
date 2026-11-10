import assert from "node:assert/strict";
import test from "node:test";
import { openShadowStore } from "../src/main/bot/shadow/store.ts";
import { WorkerSlots } from "../src/main/bot/shadow/worker-slots.ts";
import { WorkerResources } from "../src/main/bot/shadow/worker-resources.ts";
const binding = { ticketId: "ticket-res", assignmentId: "a", generation: 1, claimToken: 1 };
function fixture(t: test.TestContext) { const store = openShadowStore(":memory:"); const slots = new WorkerSlots(store, { max: () => 1, owner: "owner", leaseMs: 10_000 }); const starts: string[] = []; const stops: string[] = []; const resources = new WorkerResources(store, slots, { start: async (_kind, record) => { starts.push(record.name); }, stop: async (_kind, record) => { stops.push(record.name); } }, { owner: "resource-owner" }); t.after(() => store.close()); return { store, slots, resources, starts, stops }; }

test("job start owns a slot and handoff keeps the job without a settling slot", async t => { const f = fixture(t); const job = await f.resources.start(binding.ticketId, binding, "job", "build"); assert.equal(job.state, "running"); assert.equal(f.slots.used(), 1); const handed = f.resources.handoff(binding.ticketId); assert.equal(handed[0]!.state, "handed-off"); assert.equal(f.starts[0], "build"); });

test("stop waits for adapter and releases slot only after resources settle", async t => { const f = fixture(t); await f.resources.start(binding.ticketId, binding, "subagent", "review"); await f.resources.stop(binding.ticketId, binding); assert.deepEqual(f.stops, ["review"]); assert.equal(f.resources.list(binding.ticketId)[0]!.state, "stopped"); assert.equal(f.slots.used(), 0); });

test("same named resource is idempotent while running", async t => { const f = fixture(t); const a = await f.resources.start(binding.ticketId, binding, "job", "same"); const b = await f.resources.start(binding.ticketId, binding, "job", "same"); assert.equal(a.id, b.id); assert.equal(f.starts.length, 1); });

test("adapter stop failure remains uncertain and slot is not silently released", async t => { const store = openShadowStore(":memory:"); t.after(() => store.close()); const slots = new WorkerSlots(store, { max: () => 1, owner: "owner", leaseMs: 10_000 }); const resources = new WorkerResources(store, slots, { start: async () => {}, stop: async () => { throw new Error("still running"); } }); await resources.start(binding.ticketId, binding, "job", "bad"); await assert.doesNotReject(resources.stop(binding.ticketId, binding)); assert.equal(resources.list(binding.ticketId)[0]!.state, "uncertain"); assert.equal(slots.used(), 1); });

test("recovery reports live resources as unknown without executing adapter", async t => { const f = fixture(t); await f.resources.start(binding.ticketId, binding, "job", "recover"); const recovered = f.resources.recover(binding.ticketId); assert.equal(recovered[0]!.state, "uncertain"); assert.equal(f.stops.length, 0); });

test("a second binding cannot stop a slot it does not own", async t => { const f = fixture(t); await f.resources.start(binding.ticketId, binding, "job", "owned"); await assert.rejects(f.resources.stop(binding.ticketId, { ...binding, assignmentId: "new" }), /owned/); });
