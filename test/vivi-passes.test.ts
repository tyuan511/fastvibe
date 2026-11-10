// SPDX-License-Identifier: MIT
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowPasses } from '../src/main/bot/shadow/passes.ts';
import { ShadowEffects } from '../src/main/bot/shadow/effects.ts';
import { ShadowEngine } from '../src/main/bot/shadow/engine.ts';
import { openShadowStore } from '../src/main/bot/shadow/store.ts';
import type { Trigger } from '../src/main/bot/core/model.ts';
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function trigger(id = 't'): Trigger { return { id, source: 'fake', threads: [{ source: 'fake', id: 'chat' }], actor: { source: 'fake', id: 'person' }, human: true, at: new Date(1000).toISOString(), text: id, meta: {} }; }
function fixture(t: TestContext, opts: { beforePass?: () => void | Promise<void>; intervalMs?: number | false } = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vivi-passes-')), store = openShadowStore(join(dir, 'shadow.db'));
  const effects = new ShadowEffects(store, { now: () => 1000 });
  const engine = new ShadowEngine(store, { now: () => 1000, policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }), scope: { scope: () => ({ listened: true, observed: false }) } });
  let configured = true, closing = false, evaluations = 0, recoveries = 0;
  const passes = new ShadowPasses({ engine: { receive: tr => engine.sources.receive(tr), evaluateDue: () => { evaluations++; engine.evaluateDue(); } }, effects,
    configured: () => configured, closing: () => closing, recover: () => { recoveries++; }, beforePass: opts.beforePass }, { now: () => 1000, intervalMs: opts.intervalMs ?? false });
  t.after(async () => { await passes.stop(); await effects.drain({ abort: true }); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, engine, effects, passes, evaluations: () => evaluations, recoveries: () => recoveries, configure: (value: boolean) => { configured = value; }, close: () => { closing = true; } };
}

test('periodic start is idempotent; stop waits for pass and start never reopens it', async t => {
  let calls = 0; const entered = gate(), release = gate();
  const f = fixture(t, { intervalMs: 10, beforePass: async () => { calls++; if (calls === 1) { entered.resolve(); await release.promise; } } });
  f.passes.start(); f.passes.start(); await entered.promise; let stopped = false; const stop = f.passes.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false); release.resolve(); await stop;
  assert.equal(f.evaluations(), 0); assert.equal(calls, 1); f.passes.start(); await delay(30); await f.passes.pump(); assert.equal(calls, 1); assert.equal(f.passes.health().state, 'stopped');
});

test('periodic passes actually recur and cease after stop', async t => {
  const twice = gate(); let calls = 0; const f = fixture(t, { intervalMs: 5, beforePass: () => { if (++calls === 2) twice.resolve(); } });
  f.passes.start(); await Promise.race([twice.promise, delay(1000).then(() => { throw new Error('timer did not run'); })]); await f.passes.stop();
  const count = calls; await delay(20); assert.ok(count >= 2); assert.equal(calls, count);
});

test('concurrent pumps coalesce into exactly one followup without overlapping work', async t => {
  const entered = gate(), release = gate(); let calls = 0, active = 0, max = 0;
  const f = fixture(t, { beforePass: async () => { calls++; max = Math.max(max, ++active); if (calls === 1) { entered.resolve(); await release.promise; } active--; } });
  const first = f.passes.pump(); await entered.promise; const rest = Array.from({ length: 20 }, () => f.passes.pump());
  assert.ok(rest.every(p => p === rest[0])); release.resolve(); await Promise.all([first, ...rest]);
  assert.equal(calls, 2); assert.equal(f.evaluations(), 2); assert.equal(f.recoveries(), 2); assert.equal(max, 1);
});

test('pass health retains exact failure and a successful pump restores ready', async t => {
  let fail = true; const f = fixture(t, { beforePass: () => { if (fail) throw new Error('health failure'); } });
  await assert.rejects(f.passes.pump(), /health failure/); assert.equal(f.passes.health().state, 'error'); assert.match(f.passes.health().detail, /health failure/); assert.equal(f.evaluations(), 0);
  const copy = f.passes.health(); copy.state = 'ready'; assert.equal(f.passes.health().state, 'error');
  fail = false; await f.passes.pump(); assert.equal(f.passes.health().state, 'ready'); assert.equal(f.evaluations(), 1);
});

test('unconfigured setup stores Trigger without evaluating or consuming queue', async t => {
  const f = fixture(t); f.configure(false); assert.equal(f.passes.receive(trigger()), 'stored'); await f.passes.pump(); await f.passes.idle();
  assert.equal(f.evaluations(), 0); assert.equal(f.store.triggers.get('t')?.text, 't'); assert.deepEqual(f.store.threads.get('fake:chat')?.pending, ['t']);
  f.configure(true); await f.passes.pump(); assert.ok(f.engine.main.candidate('t')); assert.equal(f.passes.receive(trigger()), 'duplicate');
});

for (const state of ['closing', 'stopped'] as const) test(`${state} rejects Trigger before any durable mutation`, async t => {
  const f = fixture(t); if (state === 'closing') f.close(); else await f.passes.stop();
  assert.throws(() => f.passes.receive(trigger()), /stopping/); assert.equal(f.store.triggers.get('t'), undefined); await f.passes.pump(); assert.equal(f.evaluations(), 0);
});

test('closing during awaited pre-pass prevents evaluation and recovery', async t => {
  const entered = gate(), release = gate(); const f = fixture(t, { beforePass: async () => { entered.resolve(); await release.promise; } });
  const pump = f.passes.pump(); await entered.promise; f.close(); release.resolve(); await pump; assert.equal(f.evaluations(), 0); assert.equal(f.recoveries(), 0);
});

test('idle means dispatchable tasks empty and never ends a live Ticket', async t => {
  const f = fixture(t); f.passes.receive(trigger()); await f.passes.pump(); const candidate = f.engine.main.candidate('t')!;
  const decision = f.engine.main.decide('t', { evalId: candidate.evalId, kind: 'accept', title: 'work', scope: 'small', reason: 'explicit' });
  const before = f.store.tickets.get(decision.ticketId!)!; assert.equal(before.ended, undefined);
  await f.passes.idle(); assert.deepEqual(f.store.tickets.get(before.id), before); assert.equal(f.store.effects.get('launch', before.assignments[0]!.id)?.status, 'pending');
});
