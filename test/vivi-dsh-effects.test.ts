// SPDX-License-Identifier: MIT
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { ShadowEffects, Later, Uncertain, effectRequestId, type EffectCommit } from "../src/main/bot/shadow/effects.ts";
import { openShadowStore, type EffectRecord, type ShadowStore } from "../src/main/bot/shadow/store.ts";

function fixture(t: TestContext) {
  const dir = mkdtempSync(join(tmpdir(), "vivi-dsh-effects-"));
  const file = join(dir, "shadow.db");
  const stores: ShadowStore[] = [], effects: ShadowEffects[] = [];
  let now = 1000;
  const connect = () => { const s = openShadowStore(file); stores.push(s); return s; };
  const store = connect();
  const scheduler = (s = store, options: ConstructorParameters<typeof ShadowEffects>[1] = {}) => {
    const e = new ShadowEffects(s, { now: () => now, leaseMs: 1000, ...options }); effects.push(e); return e;
  };
  t.after(async () => {
    await Promise.all(effects.map(e => e.drain({ abort: true })));
    for (const s of stores) s.close();
    rmSync(dir, { recursive: true, force: true });
  });
  return { store, file, connect, scheduler, time: (value: number) => { now = value; },
    enqueue: (key = "a", payload: unknown = { version: 0 }) => store.effects.enqueue("launch", key, payload, now) };
}
function gate<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>(done => { resolve = done; });
  return { promise, resolve };
}
const tick = async () => { for (let i = 0; i < 8; i++) await Promise.resolve(); };

test("claims and fact commits are atomic, durable and exactly settled", async t => {
  const f = fixture(t), e = f.scheduler();
  f.enqueue(); let captured!: EffectRecord;
  e.handle("launch", async ctx => {
    captured = ctx.claim;
    assert.equal(f.connect().effects.get("launch", "a")!.status, "running");
    assert.deepEqual(e.attempt(ctx.claim), ctx.claim);
    assert.equal(ctx.requestId, effectRequestId(ctx.claim));
    return claim => { assert.equal(claim.claimToken, captured.claimToken); f.store.set("fact", true); };
  });
  e.start(); await e.idle();
  assert.equal(f.store.get("fact"), true);
  assert.equal(f.store.effects.get("launch", "a")!.status, "done");
  assert.equal(f.connect().get("fact"), true);
  assert.deepEqual(e.attempt(captured), captured);
 });

for (const result of [false, undefined] as const) test(`commit result ${result} settles domain validity`, async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue();
  e.handle("launch", async () => () => result); e.start(); await e.idle();
  assert.equal(f.store.effects.get("launch", "a")!.status, result === false ? "cancelled" : "done");
});

test("false commit rolls back callback facts, enqueues and afterCommit actions before cancelling", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let wakeups = 0;
  e.handle("launch", async () => claim => {
    f.store.set("rejected-fact", true);
    f.store.effects.enqueue("reply", "rejected-reply", { claim: claim.key }, 1000);
    f.store.afterCommit(() => { wakeups++; });
    return false;
  });
  e.start(); await e.idle();
  assert.equal(f.store.get("rejected-fact"), undefined);
  assert.equal(f.store.effects.get("reply", "rejected-reply"), undefined);
  assert.equal(wakeups, 0);
  assert.equal(f.store.effects.get("launch", "a")!.status, "cancelled");
});

test("commit failure rolls back fact mutations and becomes uncertain", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue();
  e.handle("launch", async () => () => { f.store.set("must-rollback", true); throw new Error("fact failure"); });
  e.start(); await e.idle();
  assert.equal(f.store.get("must-rollback"), undefined);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  assert.equal(e.health("launch").failures, 0);
});

test("engine-style completion may settle inside commit without a second settlement", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let settlements = 0;
  const settle = f.store.effects.settle;
  f.store.effects.settle = (...args) => { settlements++; return settle(...args); };
  e.handle("launch", async () => claim => { assert.equal(settle(claim, "done", 1000), true); f.store.set("fact", 1); });
  e.start(); await e.idle(); assert.equal(settlements, 0); assert.equal(f.store.get("fact"), 1);
});

for (const failure of [false, true]) test(`new payload fences old ${failure ? "failure" : "commit"} and runs new generation`, async t => {
  const f = fixture(t), e = f.scheduler(); const old = gate<void>(); let entered!: EffectRecord; let calls = 0, commits = 0;
  f.enqueue();
  e.handle("launch", async ctx => {
    calls++;
    if (calls === 1) { entered = ctx.claim; await old.promise; if (failure) throw new Error("old failed"); }
    return () => { commits++; f.store.set("committed", ctx.claim.payload); };
  });
  e.start(); await tick(); f.enqueue("a", { version: 1 });
  assert.deepEqual(e.attempt(f.store.effects.get("launch", "a")!)!.payload, { version: 0 });
  old.resolve(); await e.idle();
  assert.equal(calls, 2); assert.equal(commits, 1);
  assert.equal(f.store.effects.get("launch", "a")!.generation, 1);
  assert.deepEqual(f.store.get("committed"), { version: 1 });
  assert.deepEqual(e.attempt(entered)!.payload, { version: 0 });
});

test("ABA payload changes still fence by generation", async t => {
  const f = fixture(t), e = f.scheduler(), wait = gate<void>(); let first = true, staleCommit = false;
  f.enqueue("a", "A");
  e.handle("launch", async () => {
    if (first) { first = false; await wait.promise; return () => { staleCommit = true; }; }
  }); e.start(); await tick(); f.enqueue("a", "B"); f.enqueue("a", "A"); wait.resolve(); await e.idle();
  assert.equal(staleCommit, false); assert.equal(f.store.effects.get("launch", "a")!.generation, 2);
});

test("expired lease fences success and requires explicit reconciliation", async t => {
  const f = fixture(t), e = f.scheduler(), wait = gate<void>(); let committed = false, calls = 0;
  f.enqueue(); e.handle("launch", async () => { calls++; await wait.promise; return () => { committed = true; }; });
  e.start(); await tick(); f.time(2000); e.pulse(); await tick();
  const expected = f.store.effects.get("launch", "a")!; assert.equal(expected.status, "uncertain");
  wait.resolve(); await e.idle(); assert.equal(committed, false); assert.equal(calls, 1);
  assert.equal(e.reconcile(expected, "done"), true); assert.equal(e.reconcile(expected, "retry"), false);
  assert.equal(f.store.effects.get("launch", "a")!.status, "done");
});

test("stale claim token cannot commit or reconcile a replacement attempt", async t => {
  const f = fixture(t), e = f.scheduler(), old = gate<void>(), fresh = gate<void>(); let first!: EffectRecord, calls = 0, stale = false;
  f.enqueue();
  e.handle("launch", async ctx => {
    calls++;
    if (calls === 1) { first = ctx.claim; await old.promise; return () => { stale = true; }; }
    await fresh.promise;
  });
  e.start(); await tick(); f.time(2000); e.pulse(); await tick();
  const uncertain = f.store.effects.get("launch", "a")!;
  assert.equal(e.reconcile(uncertain, "retry"), true); await tick();
  assert.equal(calls, 2); assert.notEqual(f.store.effects.get("launch", "a")!.claimToken, first.claimToken);
  old.resolve(); await tick(); assert.equal(stale, false);
  assert.equal(f.store.effects.get("launch", "a")!.status, "running");
  assert.equal(e.reconcile(uncertain, "done"), false);
  fresh.resolve(); await e.idle(); assert.equal(f.store.effects.get("launch", "a")!.status, "done");
});

for (const limit of [1, 2]) test(`independent connections enforce global limit ${limit} and no duplicate claims`, async t => {
  const f = fixture(t), a = f.scheduler(), b = f.scheduler(f.connect()), wait = gate<void>();
  for (const key of ["a", "b", "c"]) f.enqueue(key);
  const started: string[] = [];
  const run = async (ctx: { claim: EffectRecord }) => { started.push(ctx.claim.key); await wait.promise; };
  a.handle("launch", run, { limit }); b.handle("launch", run, { limit }); a.start(); b.start(); await tick();
  assert.equal(started.length, limit); assert.equal(new Set(started).size, limit);
  assert.equal(f.store.db.get<{ n: number }>("SELECT COUNT(*) n FROM dsh_effects WHERE status='running'")!.n, limit);
  wait.resolve(); await Promise.all([a.idle(), b.idle()]);
  assert.deepEqual([...started].sort(), ["a", "b", "c"]);
});

test("ordered blocks behind not-due and uncertain oldest rows across connections", async t => {
  const f = fixture(t), e = f.scheduler(), other = f.scheduler(f.connect());
  f.enqueue("a"); f.enqueue("b"); let calls = 0;
  e.handle("launch", async () => { calls++; throw new Later(); }, { ordered: true, limit: 8 });
  other.handle("launch", async () => { calls++; }, { ordered: true });
  e.start(); await e.idle(); other.start(); await other.idle(); assert.equal(calls, 1);
  f.time(3000); f.store.atomic(() => { const c = f.store.effects.claim("launch", "a", "crashed", 3000, 100)!; f.store.set("manual", c); });
  f.time(3100); other.pulse(); await other.idle(); assert.equal(calls, 1);
  assert.equal(f.store.effects.get("launch", "b")!.status, "pending");
});

test("unordered skips delayed rows and zero limit holds without claiming", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue("a"); f.enqueue("b"); let limit = 0; const keys: string[] = [];
  f.store.db.run("UPDATE dsh_effects SET due=5000 WHERE key='a'");
  e.handle("launch", async ctx => { keys.push(ctx.claim.key); }, { limit: () => limit });
  e.start(); await e.idle(); assert.deepEqual(keys, []); limit = 1; e.kick(); await e.idle(); assert.deepEqual(keys, ["b"]);
});

test("Later uses initial delay without failure count, attempts do not determine failures", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let later = true;
  e.handle("launch", async () => { if (later) throw new Later(); throw new Error("ordinary"); }); e.start();
  for (const now of [1000, 3000, 5000, 7000]) { f.time(now); await e.idle(); assert.equal(e.health("launch").failures, 0); }
  assert.equal(f.store.effects.get("launch", "a")!.attempts, 4);
  later = false; f.time(9000); await e.idle();
  assert.equal(e.health("launch").failures, 1); assert.equal(f.store.effects.get("launch", "a")!.due, 11000);
});

for (const quiet of [false, true]) test(`failures back off to 60s, health threshold and quiet=${quiet}`, async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); e.handle("launch", async () => { throw new Error("failure"); }, { quiet }); e.start();
  let now = 1000;
  for (const [i, delay] of [2000, 4000, 8000, 16000, 32000, 60000, 60000].entries()) {
    f.time(now); await e.idle(); const row = f.store.effects.get("launch", "a")!;
    assert.equal(row.due, now + delay); assert.equal(row.status, "pending");
    assert.equal(e.health("launch").failures, i + 1);
    assert.equal(e.health("launch").state, !quiet && i >= 2 ? "error" : "ready"); now += delay;
  }
});

for (const fault of ["limit", "database"] as const) test(`quiet does not suppress scheduler ${fault} errors`, async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let broken = true, calls = 0;
  if (fault === "database") f.store.db.exec(`CREATE TEMP TRIGGER reject_claim BEFORE UPDATE ON dsh_effects
    WHEN NEW.status='running' BEGIN SELECT RAISE(ABORT, 'scheduler database failure'); END`);
  e.handle("launch", async () => { calls++; }, {
    quiet: true, limit: () => { if (fault === "limit" && broken) throw new Error("scheduler limit failure"); return 1; },
  });
  e.start(); await e.idle();
  const health = e.health("launch");
  assert.equal(health.state, "error"); assert.equal(health.failures, 0); assert.equal(health.uncertain, 0);
  assert.match(health.detail, new RegExp(`scheduler ${fault} failure`));
  assert.equal(calls, 0); assert.equal(f.store.effects.get("launch", "a")!.attempts, 0);
  broken = false;
  if (fault === "database") f.store.db.exec("DROP TRIGGER reject_claim");
  await e.idle(); assert.equal(calls, 1); assert.equal(e.health("launch").state, "ready");
});

for (const quiet of [false, true]) test(`uncertain health survives reopen and clears only after reconciliation, quiet=${quiet}`, async t => {
  const f = fixture(t); let store = f.store, e = f.scheduler(store); let calls = 0;
  f.enqueue();
  e.handle("launch", async () => { calls++; throw new Uncertain("unknown external write"); }, { quiet });
  e.start(); await e.idle();
  const expected = store.effects.get("launch", "a")!;
  const before = e.health("launch");
  assert.equal(before.state, "error"); assert.equal(before.uncertain, 1); assert.equal(before.failures, 0);
  assert.equal(before.since, 1000); assert.match(before.detail, /1 unknown, reconciliation required/);
  await e.drain(); store.close(); f.time(10000); store = f.connect(); e = f.scheduler(store);
  e.handle("launch", async () => { calls++; }, { quiet }); e.start(); await e.idle();
  const reopened = e.health("launch");
  assert.equal(reopened.state, "error"); assert.equal(reopened.uncertain, 1); assert.equal(reopened.since, 1000);
  assert.equal(reopened.detail, before.detail); assert.equal(calls, 1);
  assert.equal(e.reconcile({ ...expected, claimToken: expected.claimToken + 1 }, "done"), false);
  assert.equal(e.health("launch").state, "error");
  assert.equal(e.reconcile(expected, "done"), true); await e.idle();
  const settled = e.health("launch");
  assert.equal(settled.state, "ready"); assert.equal(settled.uncertain, 0); assert.equal(settled.waiting, 0);
  assert.equal(settled.since, undefined); assert.doesNotMatch(settled.detail, /unknown|since/); assert.equal(calls, 1);
});

test("health since is the earliest queued time across pending, running and uncertain rows", async t => {
  const f = fixture(t), e = f.scheduler();
  f.time(500); f.enqueue("finished"); f.store.effects.cancelPending("launch", "finished");
  f.time(900); f.enqueue("running");
  f.time(0); f.enqueue("pending");
  f.time(700); f.enqueue("unknown-a");
  f.time(800); f.enqueue("unknown-b");
  f.time(1000);
  e.handle("launch", async () => {}, { limit: 0, quiet: true }); e.start(); await e.idle();
  f.store.effects.claim("launch", "running", "other", 1000, 1000);
  for (const key of ["unknown-a", "unknown-b"]) {
    const claim = f.store.effects.claim("launch", key, "other", 1000, 1000)!;
    f.store.effects.settle(claim, "uncertain", 1000);
  }
  const health = e.health("launch");
  assert.equal(health.state, "error"); assert.equal(health.waiting, 4); assert.equal(health.uncertain, 2);
  assert.equal(health.since, 0); assert.match(health.detail, /2 unknown, reconciliation required; since 0/);
  f.store.effects.cancelPending("launch", "pending");
  assert.equal(e.health("launch").since, 700);
  assert.match(e.health("launch").detail, /since 700/);
});

test("new generation has independent failure budget; successful row clears health", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let fail = true;
  e.handle("launch", async () => { if (fail) throw new Error("x"); }); e.start(); await e.idle();
  f.enqueue("a", "new"); fail = false; await e.idle();
  assert.equal(e.health("launch").failures, 0); assert.equal(e.health("launch").waiting, 0);
});

test("retry requestId stable while claim token changes; payload generation changes identity", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); const ids: string[] = [], claims: EffectRecord[] = [];
  e.handle("launch", async ctx => { ids.push(ctx.requestId); claims.push(ctx.claim); if (ids.length === 1) throw new Later(); });
  e.start(); await e.idle(); f.time(3000); await e.idle();
  assert.equal(ids[0], ids[1]); assert.notEqual(claims[0]!.claimToken, claims[1]!.claimToken);
  f.enqueue(); await e.idle(); assert.notEqual(ids[1], ids[2]);
  assert.deepEqual(e.attempt(claims[0]!), claims[0]); assert.deepEqual(e.attempt(claims[1]!), claims[1]);
});

test("abort drain preserves unknown attempt and waits for underlying handler before returning", async t => {
  const f = fixture(t), e = f.scheduler(), wait = gate<void>(); let committed = false, drained = false; let signal!: AbortSignal;
  f.enqueue(); e.handle("launch", async ctx => {
    signal = ctx.signal; await wait.promise;
    // A handler can still access SQL while unwinding; drain must keep the store alive.
    assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
    f.store.set("handler-unwound", true);
    return () => { committed = true; };
  });
  e.start(); await tick(); const done = e.drain({ abort: true }).then(() => { drained = true; });
  await tick();
  assert.equal(signal.aborted, true); assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  assert.equal(drained, false); assert.equal(f.store.get("handler-unwound"), undefined);
  wait.resolve(); await done; assert.equal(committed, false); assert.equal(drained, true);
  assert.equal(f.store.get("handler-unwound"), true);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
});

test("normal drain waits for known success, leaves queued work for next start", async t => {
  const f = fixture(t), e = f.scheduler(), wait = gate<void>(); f.enqueue("a"); f.enqueue("b"); let calls = 0, drained = false;
  e.handle("launch", async () => { calls++; await wait.promise; return () => { f.store.set("fact", true); }; });
  e.start(); await tick(); const done = e.drain().then(() => { drained = true; }); await tick(); assert.equal(drained, false);
  wait.resolve(); await done; assert.equal(f.store.get("fact"), true); assert.equal(calls, 1);
  assert.equal(f.store.effects.get("launch", "b")!.status, "pending");
  e.start(); await e.idle(); assert.equal(calls, 2);
});

test("uncertain survives close/reopen and old generation reconciliation preserves new payload", async t => {
  const f = fixture(t); let s = f.store; let e = f.scheduler(s); f.enqueue("a", "old"); let claim!: EffectRecord;
  e.handle("launch", async ctx => { claim = ctx.claim; throw new Uncertain("unknown write"); }); e.start(); await e.idle();
  s.effects.enqueue("launch", "a", "new", 1000); const stale = s.effects.get("launch", "a")!;
  await e.drain(); s.close(); s = f.connect(); e = f.scheduler(s); let calls = 0;
  e.handle("launch", async () => { calls++; }); e.start(); await e.idle(); assert.equal(calls, 0);
  assert.deepEqual(e.attempt(stale), claim); assert.equal(e.reconcile(claim, "done"), false);
  assert.equal(e.reconcile(stale, "done"), true); assert.equal(e.reconcile(stale, "done"), false);
  await e.idle(); assert.equal(calls, 1); assert.equal(s.effects.get("launch", "a")!.generation, 1);
  assert.equal(s.effects.get("launch", "a")!.status, "done");
});

for (const outcome of ["retry", "done", "cancelled"] as const) test(`explicit uncertain reconciliation ${outcome} is CAS and never performs IO`, async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let calls = 0;
  e.handle("launch", async () => { calls++; throw new Uncertain(); }); e.start(); await e.idle(); await e.drain();
  const row = f.store.effects.get("launch", "a")!;
  assert.equal(e.reconcile({ ...row, claimToken: row.claimToken + 1 }, outcome), false);
  assert.equal(e.reconcile({ ...row, seq: row.seq + 1 }, outcome), false);
  assert.equal(e.reconcile(row, outcome), true); assert.equal(calls, 1);
  assert.equal(f.store.effects.get("launch", "a")!.status, outcome === "retry" ? "pending" : outcome);
});

test("idle(kind) ignores other kind tasks; all writes stay isolated from handler mutation", async t => {
  const f = fixture(t), e = f.scheduler(), wait = gate<void>(); f.enqueue(); f.store.effects.enqueue("reply", "r", {}, 1000);
  e.handle("launch", async ctx => { (ctx.claim.payload as { version: number }).version = 999; await wait.promise; });
  e.handle("reply", async () => {}); e.start(); await e.idle("reply");
  assert.equal(f.store.effects.get("launch", "a")!.status, "running");
  assert.deepEqual(e.attempt(f.store.effects.get("launch", "a")!)!.payload, { version: 0 });
  wait.resolve(); await e.idle();
});

test("process exit after claim retains immutable attempt; restart expires it without replay", async t => {
  const f = fixture(t); f.enqueue("a", "original");
  const storeModule = new URL("../src/main/bot/shadow/store.ts", import.meta.url).href;
  const effectsModule = new URL("../src/main/bot/shadow/effects.ts", import.meta.url).href;
  const child = spawnSync(process.execPath, ["--input-type=module", "-e", `
    import { openShadowStore } from ${JSON.stringify(storeModule)};
    import { ShadowEffects } from ${JSON.stringify(effectsModule)};
    const store = openShadowStore(${JSON.stringify(f.file)});
    const effects = new ShadowEffects(store, { now: () => 1000, owner: 'crashed', leaseMs: 1000 });
    effects.handle('launch', async () => { process.exit(0); });
    effects.start();
  `], { encoding: "utf8", timeout: 10_000 });
  assert.equal(child.status, 0, child.stderr);
  const running = f.store.effects.get("launch", "a")!;
  assert.equal(running.status, "running");
  f.enqueue("a", "replacement");
  const e = f.scheduler(f.connect()); let calls = 0;
  e.handle("launch", async () => { calls++; }); e.start(); await e.idle();
  assert.equal(calls, 0); assert.deepEqual(e.attempt(running), running);
  f.time(2000); e.pulse(); await e.idle(); assert.equal(calls, 0);
  const uncertain = f.store.effects.get("launch", "a")!;
  assert.equal(uncertain.status, "uncertain"); assert.deepEqual(e.attempt(uncertain), running);
  assert.equal(e.reconcile(uncertain, "done"), true);
  await e.idle(); assert.equal(calls, 1); assert.equal(f.store.effects.get("launch", "a")!.status, "done");
});

test("running snapshot is insufficient for uncertain reconciliation even with matching generation", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let running!: EffectRecord;
  e.handle("launch", async ctx => { running = ctx.claim; throw new Uncertain(); }); e.start(); await e.idle();
  assert.equal(e.reconcile(running, "retry"), false);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  assert.equal(e.reconcile(f.store.effects.get("launch", "a")!, "cancelled"), true);
});

test("commit and engine settlement roll back together when completion fails", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue();
  e.handle("launch", async () => claim => {
    f.store.set("uncommitted-fact", true);
    assert.equal(f.store.effects.settle(claim, "done", 1000), true);
    throw new Error("transaction must rollback settlement too");
  }); e.start(); await e.idle();
  assert.equal(f.store.get("uncommitted-fact"), undefined);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  assert.equal(e.health("launch").failures, 0);
});

test("ordered running oldest row blocks later keys even with spare global capacity", async t => {
  const f = fixture(t), a = f.scheduler(), b = f.scheduler(f.connect()), wait = gate<void>();
  f.enqueue("a"); f.enqueue("b"); const keys: string[] = [];
  const run = async (ctx: { claim: EffectRecord }) => { keys.push(ctx.claim.key); await wait.promise; };
  a.handle("launch", run, { ordered: true, limit: 5 }); b.handle("launch", run, { ordered: true, limit: 5 });
  a.start(); b.start(); await tick(); assert.deepEqual(keys, ["a"]);
  wait.resolve(); await Promise.all([a.idle(), b.idle()]); assert.deepEqual(keys, ["a", "b"]);
});

test("public failures counts only ordinary errors of current generation and resets after success", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let action: "error" | "later" | "success" = "error";
  e.handle("launch", async () => { if (action === "error") throw new Error("ordinary"); if (action === "later") throw new Later(); });
  assert.equal(e.failures("launch", "missing"), 0); assert.equal(e.failures("launch", "a"), 0);
  e.start(); await e.idle(); assert.equal(e.failures("launch", "a"), 1);
  action = "later"; f.time(3000); await e.idle(); assert.equal(e.failures("launch", "a"), 1);
  action = "error"; f.time(5000); await e.idle(); assert.equal(e.failures("launch", "a"), 2);
  f.time(9000); await e.idle(); assert.equal(e.failures("launch", "a"), 3);
  action = "success"; f.time(17000); await e.idle(); assert.equal(e.failures("launch", "a"), 0);
  f.enqueue(); assert.equal(e.failures("launch", "a"), 0);
  action = "error"; await e.idle(); assert.equal(e.failures("launch", "a"), 1);
  f.enqueue("a", "new generation"); assert.equal(e.failures("launch", "a"), 0);
  assert.equal(f.connect().effects.get("launch", "a")!.generation, 2);
});

test("failure counts persist across connections and restarts", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue();
  e.handle("launch", async () => { throw new Error("persist failure"); }); e.start(); await e.idle(); await e.drain();
  const otherStore = f.connect(), other = f.scheduler(otherStore);
  assert.equal(other.failures("launch", "a"), 1);
  f.store.close(); const reopened = f.scheduler(f.connect()); assert.equal(reopened.failures("launch", "a"), 1);
});

test("future-due retries wait for explicit pulse and idle returns without clearing work", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let calls = 0;
  e.handle("launch", async () => { if (++calls === 1) throw new Later(); }); e.start(); await e.idle(); await tick();
  assert.equal(calls, 1); assert.equal(f.store.effects.get("launch", "a")!.status, "pending");
  f.time(3000); await tick(); assert.equal(calls, 1);
  e.pulse(); await tick(); await e.idle(); assert.equal(calls, 2);
});

test("drain reentered synchronously from limit never claims or launches after shutdown", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let calls = 0, limits = 0;
  let drained: Promise<void> | undefined;
  e.handle("launch", async () => { calls++; f.store.set("late-handler", true); }, {
    limit: () => { limits++; drained = e.drain(); return 1; },
  });
  e.start(); await tick(); assert.ok(drained); await drained;
  const row = f.store.effects.get("launch", "a")!;
  assert.equal(row.status, "pending"); assert.equal(row.attempts, 0);
  assert.equal(limits, 1); assert.equal(calls, 0);
  assert.equal(f.store.get("late-handler"), undefined);
  f.store.close(); await tick(); assert.equal(calls, 0);
});

for (const expired of [false, true]) test(`drain reentered from claim afterCommit releases unstarted claim, expired=${expired}`, async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let calls = 0;
  let drained: Promise<void> | undefined, captured: EffectRecord | undefined;
  const claim = f.store.effects.claim;
  f.store.effects.claim = (...args) => {
    const row = claim(...args);
    if (row) {
      captured = row;
      f.store.afterCommit(() => {
        // The claim and its immutable snapshot must already be durably visible.
        const other = f.connect();
        assert.equal(other.effects.get("launch", "a")!.status, "running");
        assert.deepEqual(e.attempt(row), row);
        if (expired) f.time(2000);
        drained = e.drain();
      });
    }
    return row;
  };
  e.handle("launch", async () => { calls++; f.store.set("late-handler", true); });
  e.start(); await tick(); assert.ok(drained); await drained; assert.ok(captured);
  const row = f.store.effects.get("launch", "a")!;
  assert.equal(row.status, expired ? "uncertain" : "pending");
  assert.equal(row.claimToken, captured.claimToken); assert.equal(row.attempts, 1);
  assert.equal(row.leaseOwner, undefined); assert.deepEqual(e.attempt(captured), captured);
  assert.equal(calls, 0); assert.equal(f.store.get("late-handler"), undefined);
  // A fresh dispatcher can claim valid returned work; expired work needs reconciliation.
  f.store.effects.claim = claim;
  const next = f.scheduler(); next.handle("launch", async () => { calls++; });
  next.start(); await next.idle(); await next.drain();
  assert.equal(calls, expired ? 0 : 1);
  assert.equal(f.store.effects.get("launch", "a")!.status, expired ? "uncertain" : "done");
  f.store.close(); await tick(); assert.equal(calls, expired ? 0 : 1);
});

test("unstarted and drained dispatchers never claim; duplicate handlers and invalid options reject", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue();
  e.handle("launch", async () => {}); e.kick(); await e.idle(); assert.equal(f.store.effects.get("launch", "a")!.attempts, 0);
  assert.throws(() => e.handle("launch", async () => {}));
  assert.throws(() => e.handle("reply", async () => {}, { retry: [0, 10] }));
  assert.throws(() => e.handle("reply", async () => {}, { limit: -1 }));
  assert.throws(() => f.scheduler(f.store, { leaseMs: 0 }));
  await e.drain(); e.kick(); await e.idle(); assert.equal(f.store.effects.get("launch", "a")!.attempts, 0);
});

for (const state of ["empty", "future", "running", "uncertain"] as const) {
  test(`limit is not evaluated without an executable ordered head: ${state}`, async t => {
    const f = fixture(t), e = f.scheduler(); let limits = 0;
    if (state !== "empty") {
      f.enqueue("a"); f.enqueue("b");
      if (state === "future") f.store.db.run("UPDATE dsh_effects SET due=5000 WHERE key='a'");
      else {
        const claim = f.store.effects.claim("launch", "a", "other", 1000, 1000)!;
        if (state === "uncertain") f.store.effects.settle(claim, "uncertain", 1000);
      }
    }
    e.handle("launch", async () => { assert.fail("blocked head must not run"); }, {
      ordered: true, limit: () => { limits++; throw new Error("limit must not be queried"); },
    });
    e.start(); await e.idle();
    assert.equal(limits, 0); assert.equal(e.health("launch").state, state === "uncertain" ? "error" : "ready");
  });
}

test("unordered with only future rows does not evaluate limit", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let limits = 0;
  f.store.db.run("UPDATE dsh_effects SET due=5000");
  e.handle("launch", async () => {}, { limit: () => { limits++; return 1; } });
  e.start(); await e.idle(); assert.equal(limits, 0);
  f.time(5000); await e.idle(); assert.equal(limits, 1);
});

for (const engineSettles of [false, true]) {
  test(`lease expiry inside commit rolls back domain SQL including engine settlement=${engineSettles}`, async t => {
    const f = fixture(t), e = f.scheduler(); f.enqueue(); let calls = 0;
    e.handle("launch", async () => claim => {
      calls++; f.store.set("expired-fact", true);
      if (engineSettles) assert.equal(f.store.effects.settle(claim, "done", 1000), true);
      f.time(2000);
    });
    e.start(); await e.idle();
    assert.equal(f.connect().get("expired-fact"), undefined);
    assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
    f.time(10000); e.pulse(); await e.idle(); assert.equal(calls, 1);
  });
}

test("final clock after dispatcher settlement still fences expired lease and rolls back", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue();
  const settle = f.store.effects.settle;
  f.store.effects.settle = (...args) => {
    const result = settle(...args);
    if (args[1] === "done") f.time(2000);
    return result;
  };
  e.handle("launch", async () => () => { f.store.set("last-clock-fact", true); });
  e.start(); await e.idle();
  assert.equal(f.connect().get("last-clock-fact"), undefined);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
});

test("owner mutation inside commit rolls back domain SQL and owner change", async t => {
  const f = fixture(t), e = f.scheduler(f.store, { owner: "original" }); f.enqueue();
  e.handle("launch", async () => () => {
    f.store.set("wrong-owner-fact", true);
    f.store.db.run("UPDATE dsh_effects SET lease_owner='replacement' WHERE key='a'");
  });
  e.start(); await e.idle();
  assert.equal(f.connect().get("wrong-owner-fact"), undefined);
  const row = f.store.effects.get("launch", "a")!;
  assert.equal(row.status, "uncertain");
  assert.equal(e.attempt(row)!.leaseOwner, "original");
});

for (const field of ["seq", "generation", "claim_token"] as const) {
  test(`engine done with changed ${field} rolls back all facts`, async t => {
    const f = fixture(t), e = f.scheduler(); f.enqueue();
    e.handle("launch", async () => claim => {
      f.store.set("invalid-done", true);
      assert.equal(f.store.effects.settle(claim, "done", 1000), true);
      f.store.db.run(`UPDATE dsh_effects SET ${field}=${field}+1 WHERE key='a'`);
    });
    e.start(); await e.idle();
    assert.equal(f.connect().get("invalid-done"), undefined);
    const row = f.store.effects.get("launch", "a")!;
    assert.equal(row.status, "uncertain"); assert.equal(row.generation, 0);
    assert.deepEqual(e.attempt(row)!.seq, row.seq);
  });
}

test("successful external send followed by SQLABORT is uncertain and never automatically resent", async t => {
  const f = fixture(t), e = f.scheduler(); let sends = 0;
  f.store.effects.enqueue("reply", "message", {}, 1000);
  f.store.db.exec(`CREATE TEMP TRIGGER reject_reply_settlement BEFORE UPDATE ON dsh_effects
    WHEN NEW.kind='reply' AND NEW.status='done'
    BEGIN SELECT RAISE(ABORT, 'forced SQLABORT'); END`);
  e.handle("reply", async () => {
    sends++;
    return () => { f.store.set("sent-domain-fact", true); };
  });
  e.start(); await e.idle();
  assert.equal(sends, 1); assert.equal(f.connect().get("sent-domain-fact"), undefined);
  const row = f.store.effects.get("reply", "message")!;
  assert.equal(row.status, "uncertain"); assert.match(row.error, /forced SQLABORT/);
  assert.equal(e.failures("reply", "message"), 0);
  f.store.db.exec("DROP TRIGGER reject_reply_settlement");
  f.time(100000); e.pulse(); await e.idle(); assert.equal(sends, 1);
  await e.drain();
  const restarted = f.scheduler(f.connect());
  restarted.handle("reply", async () => { sends++; }); restarted.start(); await restarted.idle();
  assert.equal(sends, 1);
});

test("async commit return is rejected, rolls back synchronous facts and stays uncertain", async t => {
  const f = fixture(t), e = f.scheduler(); f.enqueue(); let calls = 0;
  e.handle("launch", async () => {
    calls++;
    return (async () => { f.store.set("async-fact", true); }) as unknown as EffectCommit;
  });
  e.start(); await e.idle();
  assert.equal(f.connect().get("async-fact"), undefined);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  f.time(10000); e.pulse(); await e.idle(); assert.equal(calls, 1);
});

test("abort drain waits even when underlying handler eventually rejects", async t => {
  const f = fixture(t), e = f.scheduler(), wait = gate<void>(); f.enqueue(); let drained = false;
  e.handle("launch", async () => { await wait.promise; throw new Error("late rejection"); });
  e.start(); await tick(); const done = e.drain({ abort: true }).then(() => { drained = true; });
  await tick(); assert.equal(drained, false);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  wait.resolve(); await done; assert.equal(drained, true);
  assert.equal(f.store.effects.get("launch", "a")!.status, "uncertain");
  assert.equal(e.failures("launch", "a"), 0);
});
