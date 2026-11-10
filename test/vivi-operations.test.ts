// SPDX-License-Identifier: MIT
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { ShadowEffects } from "../src/main/bot/shadow/effects.ts";
import { ShadowOperations, type OperationAdapter } from "../src/main/bot/shadow/operations.ts";
import { openShadowStore, type Operation, type ShadowStore } from "../src/main/bot/shadow/store.ts";

const tick = async () => { for (let i = 0; i < 12; i++) await Promise.resolve(); };
function fixture(t: TestContext, adapter: OperationAdapter = { execute: async () => ({ status: "confirmed" }), inspect: async () => ({ status: "unknown" }) }, options: { paused?: () => boolean } = {}) {
  const dir = mkdtempSync(join(tmpdir(), "vivi-operations-"));
  const file = join(dir, "shadow.db");
  let now = 1000;
  const stores: ShadowStore[] = [], engines: ShadowEffects[] = [];
  const store = openShadowStore(file); stores.push(store);
  const effects = new ShadowEffects(store, { now: () => now, owner: `test-${Math.random()}`, leaseMs: 1000 }); engines.push(effects);
  const operations = new ShadowOperations(store, effects, adapter, { now: () => now, ...options });
  const scheduler = (connection = store) => { const engine = new ShadowEffects(connection, { now: () => now, owner: `other-${Math.random()}`, leaseMs: 1000 }); engines.push(engine); return engine; };
  t.after(async () => { await Promise.all(engines.map(engine => engine.drain({ abort: true }))); for (const item of stores) item.close(); rmSync(dir, { recursive: true, force: true }); });
  return { dir, file, store, effects, operations, scheduler, clock: () => now, connect: () => { const item = openShadowStore(file); stores.push(item); return item; }, time: (value: number) => { now = value; } };
}
function intent(key = "k"): Omit<Operation, "status" | "revision"> { return { id: `op-${key}`, source: "source", instance: "instance", key, payload: { version: 1 } }; }

test("persists immutable intent before execute and atomically commits receipt", async t => {
  let started = 0;
  const f = fixture(t, { execute: async operation => { started++; assert.equal(f.operations.get(operation.source, operation.instance, operation.key)?.status, "uncertain"); return { status: "confirmed", receipt: { remote: 7 } }; }, inspect: async () => ({ status: "unknown" }) });
  const planned = f.operations.plan(intent());
  assert.equal(planned.status, "planned"); assert.equal(started, 0); assert.deepEqual(f.store.effects.get("source-operation", JSON.stringify(["source", "instance", "k"]))?.payload, { operation: planned, phase: "execute" });
  f.effects.start(); await f.effects.idle();
  assert.deepEqual(f.operations.get("source", "instance", "k"), { ...planned, status: "confirmed", revision: 3, receipt: { remote: 7 } });
  assert.equal(f.store.effects.get("source-operation", JSON.stringify(["source", "instance", "k"]))?.status, "done");
});

test("throw leaves uncertain; recover only inspects and never reexecutes", async t => {
  let execute = 0, inspect = 0;
  const f = fixture(t, { execute: async () => { execute++; throw new Error("lost reply"); }, inspect: async () => { inspect++; return { status: "confirmed", receipt: "found" }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle();
  assert.equal(execute, 1); assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  await f.effects.drain(); const reopened = f.connect(); const effects = new ShadowEffects(reopened, { now: () => 1000, owner: "reopened", leaseMs: 1000 }); const ops = new ShadowOperations(reopened, effects, { execute: async () => { execute++; return { status: "confirmed" }; }, inspect: async () => { inspect++; return { status: "confirmed", receipt: "found" }; } }, { now: () => 1000 });
  ops.recover(); effects.start(); await effects.idle();
  assert.equal(execute, 1); assert.equal(inspect, 1); assert.equal(ops.get("source", "instance", "k")?.status, "confirmed");
  await effects.drain();
});

test("unknown reconciliation stays pending and does not send execute", async t => {
  let executes = 0, inspections = 0;
  const f = fixture(t, { execute: async () => { executes++; throw new Error("unknown"); }, inspect: async () => { inspections++; return { status: "unknown" }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle(); await f.effects.drain(); f.operations.recover(); f.effects.start(); await f.effects.idle();
  assert.equal(executes, 1); assert.equal(inspections, 1); assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  assert.equal(f.store.effects.get("source-operation", JSON.stringify(["source", "instance", "k"]))?.status, "uncertain");
});

test("not-applied becomes failed then safely schedules a fresh planned generation", async t => {
  let execute = 0, inspect = 0;
  const f = fixture(t, { execute: async () => { execute++; if (execute === 1) throw new Error("lost"); return { status: "confirmed", receipt: "retry-ok" }; }, inspect: async () => { inspect++; return { status: "not-applied" }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle(); await f.effects.drain(); f.operations.recover(); f.effects.start(); await f.effects.idle();
  assert.equal(inspect, 1); assert.equal(execute, 2); assert.equal(f.operations.get("source", "instance", "k")?.status, "confirmed");
});

test("cancel races are conservative and uncertain cancellation waits for inspect", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { execute: async () => { await wait; throw new Error("unknown"); }, inspect: async () => ({ status: "not-applied" }) });
  f.operations.plan(intent()); f.effects.start(); await tick();
  assert.equal(f.operations.cancel("source", "instance", "k").status, "uncertain"); release(); await f.effects.idle();
  f.operations.recover(); f.time(3000); f.effects.kick(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "cancelled");
});

test("planned and failed cancellation, namespaces and immutable replay", async t => {
  const f = fixture(t, { execute: async () => ({ status: "failed", receipt: "rejected" }), inspect: async () => ({ status: "unknown" }) });
  const a = f.operations.plan(intent("a")); assert.throws(() => f.operations.plan({ ...intent("a"), payload: { version: 2 } }));
  assert.equal(f.operations.cancel("source", "instance", "a").status, "cancelled");
  const bIntent = { ...intent("b"), source: "other" }; f.operations.plan(bIntent); f.operations.cancel("other", "instance", "b");
  assert.equal(f.operations.get("source", "instance", "a")?.id, a.id); assert.equal(f.operations.get("other", "instance", "b")?.status, "cancelled");
});

test("pause prevents new execution while plans remain queued", async t => {
  let paused = true, executes = 0;
  const f = fixture(t, { execute: async () => { executes++; return { status: "confirmed" }; }, inspect: async () => ({ status: "unknown" }) }, { paused: () => paused });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle(); assert.equal(executes, 0);
  assert.equal(f.operations.get("source", "instance", "k")?.status, "planned");
  paused = false; f.effects.kick(); await f.effects.idle(); assert.equal(executes, 1);
});

test("changed operation payload/revision fences old execution success", async t => {
  let release!: () => void; const wait = new Promise<void>(resolve => { release = resolve; });
  const f = fixture(t, { execute: async () => { await wait; return { status: "confirmed", receipt: "old" }; }, inspect: async () => ({ status: "unknown" }) });
  f.operations.plan(intent()); f.effects.start(); await tick(); const old = f.operations.get("source", "instance", "k")!;
  f.store.db.run("UPDATE vivi_operations SET status='planned',data=?,revision=revision+1 WHERE source='source' AND instance='instance' AND operation_key='k'",JSON.stringify({ ...old, status: "planned", revision: old.revision + 1, payload: { version: 2 } }));
  release(); await f.effects.idle(); assert.deepEqual(f.operations.get("source", "instance", "k")?.payload, { version: 2 }); assert.equal(f.operations.get("source", "instance", "k")?.status, "planned");
});

const opKey = JSON.stringify(["source", "instance", "k"]);
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}

for (const mode of ["before-execute", "after-execute"] as const) test(`real child crash ${mode}: reopen only inspects, never resends`, async t => {
  const f = fixture(t);
  const journal = join(f.dir, "external.jsonl");
  const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/vivi-operations-crash.ts", import.meta.url)), f.file, journal, mode], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.error, undefined);
  assert.equal(child.status, mode === "before-execute" ? 71 : 72, child.stderr);
  assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  assert.equal(f.operations.get("source", "instance", "k")?.receipt, undefined);
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "running");
  const reopened = f.connect(), effects = f.scheduler(reopened);
  let sends = 0, inspections = 0;
  const operations = new ShadowOperations(reopened, effects, {
    execute: async () => { sends++; throw new Error("must never execute during recovery"); },
    inspect: async operation => {
      inspections++;
      assert.equal(operation.id, "crash-op");
      if (mode === "before-execute") return { status: "unknown" };
      const rows = readFileSync(journal, "utf8").trim().split("\n").map(line => JSON.parse(line));
      assert.deepEqual(rows, [{ id: "crash-op", payload: { remote: "value" } }]);
      return { status: "confirmed", receipt: { external: "crash-op" } };
    },
  }, { now: f.clock });
  f.time(2000); operations.recover(); effects.start(); await effects.idle();
  assert.equal(sends, 0); assert.equal(inspections, 1);
  assert.equal(operations.get("source", "instance", "k")?.status, mode === "before-execute" ? "uncertain" : "confirmed");
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, mode === "before-execute" ? "uncertain" : "done");
  assert.equal(existsSync(journal), mode === "after-execute");
  await effects.drain();
});

test("plan intent and enqueue SQL ABORT roll back together; no transport call", async t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; return { status: "confirmed" }; }, inspect: async () => ({ status: "unknown" }) });
  f.store.db.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON vivi_effects BEGIN SELECT RAISE(ABORT,'enqueue abort'); END");
  assert.throws(() => f.operations.plan(intent()), /enqueue abort/);
  assert.equal(f.operations.get("source", "instance", "k"), undefined);
  assert.equal(f.store.effects.get("source-operation", opKey), undefined);
  f.effects.start(); await f.effects.idle(); assert.equal(calls, 0);
});

for (const target of ["operation", "effect"] as const) test(`SQL ABORT during ${target} receipt commit preserves uncertain without resending`, async t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; return { status: "confirmed", receipt: { remote: 1 } }; }, inspect: async () => ({ status: "confirmed", receipt: { recovered: 1 } }) });
  f.operations.plan(intent());
  f.store.db.exec(target === "operation"
    ? "CREATE TRIGGER fail_receipt BEFORE UPDATE ON vivi_operations WHEN NEW.status='confirmed' BEGIN SELECT RAISE(ABORT,'receipt abort'); END"
    : "CREATE TRIGGER fail_receipt BEFORE UPDATE ON vivi_effects WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'effect abort'); END");
  f.effects.start(); await f.effects.idle();
  assert.equal(calls, 1); assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  assert.equal(f.operations.get("source", "instance", "k")?.receipt, undefined);
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "uncertain");
  f.time(9000); f.effects.pulse(); await f.effects.idle(); assert.equal(calls, 1);
  f.store.db.exec("DROP TRIGGER fail_receipt"); f.operations.recover(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "confirmed");
  assert.deepEqual(f.operations.get("source", "instance", "k")?.receipt, { recovered: 1 });
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "done");
});

test("outer transaction rollback removes plan and enqueue; replay cannot change id or payload", async t => {
  const f = fixture(t);
  assert.throws(() => f.store.atomic(() => { f.operations.plan(intent()); throw new Error("outer abort"); }), /outer abort/);
  assert.equal(f.operations.get("source", "instance", "k"), undefined);
  assert.equal(f.store.effects.get("source-operation", opKey), undefined);
  const planned = f.operations.plan(intent()), effect = f.store.effects.get("source-operation", opKey)!;
  assert.deepEqual(f.operations.plan(intent()), planned);
  assert.equal(f.store.effects.get("source-operation", opKey)?.generation, effect.generation);
  assert.throws(() => f.operations.plan({ ...intent(), id: "changed" }));
  assert.throws(() => f.operations.plan({ ...intent(), payload: { version: 2 } }));
});

test("failed is explicitly retryable; uncertain/confirmed/cancelled are never ordinary retryable", async t => {
  let calls = 0;
  const f = fixture(t, { execute: async () => ({ status: ++calls === 1 ? "failed" : "confirmed", receipt: calls }), inspect: async () => ({ status: "unknown" }) });
  f.operations.plan(intent()); assert.throws(() => f.operations.retry("source", "instance", "k"));
  f.effects.start(); await f.effects.idle(); assert.equal(f.operations.get("source", "instance", "k")?.status, "failed");
  const stable = f.operations.get("source", "instance", "k")!;
  f.operations.retry("source", "instance", "k"); await f.effects.idle();
  assert.equal(calls, 2); assert.equal(f.operations.get("source", "instance", "k")?.id, stable.id);
  assert.deepEqual(f.operations.get("source", "instance", "k")?.payload, stable.payload);
  assert.throws(() => f.operations.retry("source", "instance", "k"));
  f.operations.plan(intent("cancel")); f.operations.cancel("source", "instance", "cancel");
  assert.throws(() => f.operations.retry("source", "instance", "cancel"));
});

test("unknown outcome rejects ordinary retry and duplicate recover preserves read generation/backoff", async t => {
  let writes = 0, reads = 0;
  const f = fixture(t, { execute: async () => { writes++; throw new Error("ambiguous"); }, inspect: async () => { reads++; return { status: "unknown" }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle();
  assert.throws(() => f.operations.retry("source", "instance", "k"));
  f.operations.recover(); await f.effects.idle(); const read = f.store.effects.get("source-reconcile", opKey)!;
  for (let i = 0; i < 5; i++) { f.operations.recover(); await f.effects.idle(); }
  assert.equal(writes, 1); assert.equal(reads, 1);
  assert.deepEqual(f.store.effects.get("source-reconcile", opKey), read);
  f.time(3000); await f.effects.idle(); assert.equal(reads, 2); assert.equal(writes, 1);
});

test("live source-operation lease prevents inspect even when cancellation or recovery requests it", async t => {
  const wait = gate<void>(); let inspections = 0;
  const f = fixture(t, { execute: async () => { await wait.promise; return { status: "confirmed", receipt: "actual success" }; }, inspect: async () => { inspections++; return { status: "not-applied" }; } });
  f.operations.plan(intent()); f.effects.start(); await tick();
  f.operations.cancel("source", "instance", "k"); f.operations.recover(); await f.effects.idle("source-reconcile");
  assert.equal(inspections, 0); assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  wait.resolve(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "confirmed");
  assert.equal(f.operations.get("source", "instance", "k")?.receipt, "actual success");
});

for (const outcome of ["confirmed", "not-applied", "unknown"] as const) test(`cancel racing inspection ${outcome} respects actual external facts`, async t => {
  const wait = gate<void>(); let inspecting = false, writes = 0;
  const f = fixture(t, { execute: async () => { writes++; throw new Error("lost ack"); }, inspect: async () => { inspecting = true; await wait.promise; return { status: outcome, receipt: outcome }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle();
  f.operations.recover(); await tick(); assert.equal(inspecting, true);
  f.operations.cancel("source", "instance", "k"); wait.resolve(); await f.effects.idle();
  assert.equal(writes, 1);
  assert.equal(f.operations.get("source", "instance", "k")?.status, outcome === "confirmed" ? "confirmed" : outcome === "not-applied" ? "cancelled" : "uncertain");
});

test("pause still permits read reconciliation; not-applied never writes until unpaused", async t => {
  let paused = false, writes = 0, reads = 0;
  const f = fixture(t, { execute: async () => { if (++writes === 1) throw new Error("unknown"); return { status: "confirmed" }; }, inspect: async () => { reads++; return { status: "not-applied" }; } }, { paused: () => paused });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle();
  paused = true; f.operations.recover(); await f.effects.idle();
  assert.equal(reads, 1); assert.equal(writes, 1); assert.equal(f.operations.get("source", "instance", "k")?.status, "planned");
  paused = false; f.effects.kick(); await f.effects.idle(); assert.equal(writes, 2);
});

test("source, instance and key form isolated namespaces including delimiter-like values", async t => {
  const seen: string[] = [];
  const f = fixture(t, { execute: async op => { seen.push(op.id); return { status: "confirmed", receipt: op.id }; }, inspect: async () => ({ status: "unknown" }) });
  const entries = [
    { ...intent(), id: "first", source: "a/b", instance: "c" },
    { ...intent(), id: "second", source: "a", instance: "b/c" },
    { ...intent(), id: "third", source: "a", instance: "other" },
    { ...intent("other"), id: "fourth", source: "a", instance: "b/c" },
  ];
  entries.forEach(op => f.operations.plan(op)); f.effects.start(); await f.effects.idle();
  assert.equal(new Set(seen).size, 4);
  for (const op of entries) assert.equal(f.operations.get(op.source, op.instance, op.key)?.receipt, op.id);
});

test("expired execution late success cannot overwrite reconciled facts or retry lease owner", async t => {
  const old = gate<void>(); let writes = 0;
  const f = fixture(t, { execute: async () => { writes++; await old.promise; return { status: "confirmed", receipt: "stale" }; }, inspect: async () => ({ status: "unknown" }) });
  f.operations.plan(intent()); f.effects.start(); await tick(); const original = f.store.effects.get("source-operation", opKey)!;
  f.time(2000); f.effects.pulse();
  const connection = f.connect(), other = f.scheduler(connection); let newWrites = 0;
  const ops = new ShadowOperations(connection, other, { execute: async () => { newWrites++; return { status: "confirmed", receipt: "fresh" }; }, inspect: async () => ({ status: "not-applied" }) }, { now: f.clock });
  ops.recover(); other.start(); await other.idle();
  assert.equal(newWrites, 1); assert.equal(ops.get("source", "instance", "k")?.receipt, "fresh");
  const settled = ops.get("source", "instance", "k"), effect = f.store.effects.get("source-operation", opKey)!;
  assert.notEqual(effect.claimToken, original.claimToken);
  old.resolve(); await f.effects.idle();
  assert.deepEqual(ops.get("source", "instance", "k"), settled); assert.equal(writes, 1);
  assert.deepEqual(f.store.effects.get("source-operation", opKey), effect);
});

test("ABA effect generation fences execution closure even with identical payload", async t => {
  const wait = gate<void>();
  const f = fixture(t, { execute: async () => { await wait.promise; return { status: "confirmed", receipt: "stale" }; }, inspect: async () => ({ status: "unknown" }) });
  f.operations.plan(intent()); f.effects.start(); await tick();
  const row = f.store.effects.get("source-operation", opKey)!;
  f.store.effects.enqueue("source-operation", opKey, { bad: "intermediate" }, f.clock());
  f.store.effects.enqueue("source-operation", opKey, row.payload, f.clock());
  wait.resolve(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  assert.equal(f.operations.get("source", "instance", "k")?.receipt, undefined);
  assert.equal(f.store.effects.get("source-operation", opKey)?.generation, row.generation + 2);
});

test("SQL ABORT of reconcile settlement rolls back operation receipt and source Effect together", async t => {
  const f = fixture(t, { execute: async () => { throw new Error("unknown"); }, inspect: async () => ({ status: "confirmed", receipt: "observed" }) });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle();
  f.store.db.exec("CREATE TRIGGER fail_inspect BEFORE UPDATE ON vivi_effects WHEN NEW.kind='source-reconcile' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'inspect settle abort'); END");
  f.operations.recover(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  assert.equal(f.operations.get("source", "instance", "k")?.receipt, undefined);
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "uncertain");
  f.store.db.exec("DROP TRIGGER fail_inspect"); f.time(3000); f.operations.recover(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "confirmed");
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "done");
});

test("expired read reconciliation is safely retried on recover and late inspect cannot overwrite", async t => {
  const wait = gate<void>(); let oldReads = 0, writes = 0;
  const f = fixture(t, { execute: async () => { writes++; throw new Error("unknown"); }, inspect: async () => { oldReads++; await wait.promise; return { status: "not-applied" }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle(); f.operations.recover(); await tick();
  assert.equal(oldReads, 1);
  const connection = f.connect(), engine = f.scheduler(connection); let reads = 0;
  const ops = new ShadowOperations(connection, engine, {
    execute: async () => { writes++; return { status: "confirmed", receipt: "wrong resend" }; },
    inspect: async () => { reads++; return { status: "confirmed", receipt: "observed" }; },
  }, { now: f.clock });
  f.time(2000); ops.recover(); engine.start(); await engine.idle();
  assert.equal(reads, 1); assert.equal(writes, 1);
  const settled = ops.get("source", "instance", "k");
  assert.equal(settled?.receipt, "observed");
  wait.resolve(); await f.effects.idle();
  assert.deepEqual(ops.get("source", "instance", "k"), settled);
  assert.equal(writes, 1);
});

test("inspection closure requires exact operation revision even when identity/status return to uncertain", async t => {
  const wait = gate<void>();
  const f = fixture(t, { execute: async () => { throw new Error("unknown"); }, inspect: async () => { await wait.promise; return { status: "confirmed", receipt: "old inspect" }; } });
  f.operations.plan(intent()); f.effects.start(); await f.effects.idle(); f.operations.recover(); await tick();
  const old = f.operations.get("source", "instance", "k")!;
  f.store.atomic(() => {
    assert.equal(f.store.operations.transition(old, "failed"), true);
    assert.equal(f.store.operations.transition(f.operations.get("source", "instance", "k")!, "planned"), true);
    assert.equal(f.store.operations.transition(f.operations.get("source", "instance", "k")!, "uncertain"), true);
  });
  const newer = f.operations.get("source", "instance", "k");
  wait.resolve(); await f.effects.idle();
  assert.deepEqual(f.operations.get("source", "instance", "k"), newer);
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "uncertain");
});

test("claim expiring before handler SQL validation prevents execute entirely", async t => {
  let calls = 0, reads = 0;
  let outcome: "unknown" | "not-applied" = "unknown";
  const f = fixture(t, { execute: async () => { calls++; return { status: "confirmed" }; }, inspect: async () => { reads++; return { status: outcome }; } });
  f.operations.plan(intent());
  const attempt = f.effects.attempt.bind(f.effects);
  f.effects.attempt = claim => { const value = attempt(claim); f.time(2000); return value; };
  f.effects.start(); await f.effects.idle();
  assert.equal(calls, 0); assert.equal(f.operations.get("source", "instance", "k")?.status, "planned");
  assert.equal(f.store.effects.get("source-operation", opKey)?.status, "uncertain");
  f.effects.attempt = attempt;
  f.operations.recover(); await f.effects.idle();
  assert.equal(reads, 1); assert.equal(calls, 0);
  assert.equal(f.operations.get("source", "instance", "k")?.status, "uncertain");
  outcome = "not-applied"; f.time(4000); f.effects.pulse(); await f.effects.idle();
  assert.equal(reads, 2); assert.equal(calls, 1);
  assert.equal(f.operations.get("source", "instance", "k")?.status, "confirmed");
});

for (const cancel of [false, true]) for (const outcome of ["unknown", "confirmed", "not-applied"] as const) {
  test(`claim committed before handler crash: ${cancel ? "cancel" : "recover"} with ${outcome} evidence`, async t => {
    const f = fixture(t), journal = join(f.dir, "external.jsonl");
    const child = spawnSync(process.execPath, [fileURLToPath(new URL("./fixtures/vivi-operations-crash.ts", import.meta.url)), f.file, journal, "before-handler"], { encoding: "utf8", timeout: 10_000 });
    assert.equal(child.error, undefined); assert.equal(child.status, 73, child.stderr);
    const planned = f.operations.get("source", "instance", "k")!;
    assert.equal(planned.status, "planned"); assert.equal(existsSync(journal), false);
    const claimed = f.store.effects.get("source-operation", opKey)!;
    assert.equal(claimed.status, "running");
    assert.deepEqual((f.effects.attempt(claimed)?.payload as { operation: Operation }).operation, planned);
    const connection = f.connect(), effects = f.scheduler(connection);
    let evidence: "unknown" | "confirmed" | "not-applied" = "unknown", writes = 0, reads = 0;
    const operations = new ShadowOperations(connection, effects, {
      execute: async () => { writes++; assert.equal(evidence, "not-applied"); return { status: "confirmed" }; },
      inspect: async operation => {
        reads++; assert.equal(operation.status, "uncertain"); assert.equal(operation.revision, planned.revision + 1);
        assert.equal(connection.operations.get(operation.source, operation.instance, operation.key)?.status, "uncertain");
        return { status: evidence, receipt: "inspection" };
      },
    }, { now: f.clock });
    f.time(2000);
    if (cancel) assert.equal(operations.cancel("source", "instance", "k").status, "uncertain");
    else operations.recover();
    effects.start(); await effects.idle();
    assert.equal(reads, 1); assert.equal(writes, 0);
    assert.equal(operations.get("source", "instance", "k")?.status, "uncertain");
    assert.throws(() => operations.retry("source", "instance", "k"));
    evidence = outcome; f.time(4000); operations.recover(); effects.pulse(); await effects.idle();
    assert.equal(reads, 2);
    assert.equal(writes, outcome === "not-applied" && !cancel ? 1 : 0);
    assert.equal(operations.get("source", "instance", "k")?.status,
      outcome === "unknown" ? "uncertain" : outcome === "not-applied" && cancel ? "cancelled" : "confirmed");
    assert.equal(f.store.effects.get("source-operation", opKey)?.status,
      outcome === "unknown" ? "uncertain" : outcome === "not-applied" && cancel ? "cancelled" : "done");
  });
}

for (const mismatch of ["revision", "intent", "generation", "namespace"] as const) test(`planned unknown claim rejects ${mismatch} mismatch for recovery and cancellation`, async t => {
  const f = fixture(t);
  const planned = f.operations.plan(intent());
  // Use the real dispatcher to persist the immutable attempt, but expire before execute validation.
  const attempt = f.effects.attempt.bind(f.effects);
  f.effects.attempt = claim => { const value = attempt(claim); f.time(2000); return value; };
  f.effects.start(); await f.effects.idle(); f.effects.attempt = attempt;
  if (mismatch === "generation") {
    const row = f.store.effects.get("source-operation", opKey)!;
    f.store.effects.enqueue("source-operation", opKey, { intermediate: true }, f.clock());
    f.store.effects.enqueue("source-operation", opKey, row.payload, f.clock());
  } else {
    const changed = { ...planned, ...(mismatch === "revision" ? { revision: planned.revision + 1 }
      : mismatch === "intent" ? { payload: { version: 2 } } : { source: "other" }) };
    f.store.db.run("UPDATE vivi_operations SET source=?,revision=?,data=? WHERE id=?", changed.source, changed.revision, JSON.stringify(changed), planned.id);
  }
  if (mismatch === "namespace") f.operations.recover();
  else assert.throws(() => f.operations.recover(), /attempt/);
  const source = mismatch === "namespace" ? "other" : "source";
  // Namespace changes leave the original claim isolated, so its absence permits ordinary cancellation.
  if (mismatch === "namespace") assert.equal(f.operations.cancel(source, "instance", "k").status, "cancelled");
  else {
    assert.throws(() => f.operations.cancel(source, "instance", "k"), /attempt/);
    assert.equal(f.operations.get(source, "instance", "k")?.status, "planned");
  }
});

test("planned claim checkpoint and reconcile enqueue roll back together on SQL ABORT", async t => {
  let writes = 0, reads = 0;
  const f = fixture(t, { execute: async () => { writes++; return { status: "confirmed" }; }, inspect: async () => { reads++; return { status: "confirmed" }; } });
  const planned = f.operations.plan(intent());
  const attempt = f.effects.attempt.bind(f.effects);
  f.effects.attempt = claim => { const value = attempt(claim); f.time(2000); return value; };
  f.effects.start(); await f.effects.idle(); f.effects.attempt = attempt;
  const source = f.store.effects.get("source-operation", opKey);
  f.store.db.exec("CREATE TRIGGER fail_recovery BEFORE INSERT ON vivi_effects WHEN NEW.kind='source-reconcile' BEGIN SELECT RAISE(ABORT,'recovery abort'); END");
  for (const action of [() => f.operations.recover(), () => f.operations.cancel("source", "instance", "k")]) {
    assert.throws(action, /recovery abort/);
    assert.deepEqual(f.operations.get("source", "instance", "k"), planned);
    assert.deepEqual(f.store.effects.get("source-operation", opKey), source);
    assert.equal(f.store.effects.get("source-reconcile", opKey), undefined);
  }
  f.store.db.exec("DROP TRIGGER fail_recovery");
  f.operations.recover(); await f.effects.idle();
  assert.equal(reads, 1); assert.equal(writes, 0);
  assert.equal(f.operations.get("source", "instance", "k")?.status, "confirmed");
});

test("cancel followed by an explicit failed execute confirms cancellation without another write", async t => {
  const wait = gate<void>(); let calls = 0;
  const f = fixture(t, { execute: async () => { calls++; await wait.promise; return { status: "failed", receipt: "not applied" }; }, inspect: async () => ({ status: "unknown" }) });
  f.operations.plan(intent()); f.effects.start(); await tick(); f.operations.cancel("source", "instance", "k");
  wait.resolve(); await f.effects.idle();
  assert.equal(f.operations.get("source", "instance", "k")?.status, "cancelled");
  assert.equal(calls, 1); assert.throws(() => f.operations.retry("source", "instance", "k"));
});
