// SPDX-License-Identifier: MIT
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { ShadowDriver, LaunchRejected, DeliveryRejected, type ShadowAdapters, type ShadowDriverOptions } from '../src/main/bot/shadow/driver.ts';
import { Uncertain } from '../src/main/bot/shadow/effects.ts';
import { openShadowStore } from '../src/main/bot/shadow/store.ts';
import { ticketOutcome, type Trigger } from '../src/main/bot/core/model.ts';
import type { Candidate, DomainEvent, Policy } from '../src/main/bot/core/ports.ts';
import type { WorkerToken } from '../src/main/bot/shadow/engine.ts';
import { createShadowPorts, stopControlKey, workerBindingKey } from '../src/main/bot/shadow/ports.ts';
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function trigger(id = 'input', thread = 'chat'): Trigger {
  return { id, source: 'fake', threads: [{ source: 'fake', id: thread }], actor: { source: 'fake', id: 'person' }, human: true,
    at: new Date(1000).toISOString(), text: id, channel: { source: 'fake', thread, address: { room: thread } }, meta: {} };
}
const policy = (): Policy => ({ version: 'v1', paused: false, evalTimeoutMs: 60000,
  gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true });
function fixture(t: TestContext, adapters: ShadowAdapters = {}, options: Partial<ShadowDriverOptions> = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'vivi-driver-')), file = join(dir, 'shadow.db'); const store = openShadowStore(file);
  let now = 1000, configured = true; const calls: string[] = [], candidates: Candidate[] = [], tokens: WorkerToken[] = [], events: DomainEvent[] = [];
  const fake: ShadowAdapters = { assessment: async c => { candidates.push(c); calls.push('assessment'); },
    launch: async (_t, _a, token) => { tokens.push(token); calls.push('launch'); }, delivery: async () => { calls.push('delivery'); },
    relay: async () => { calls.push('relay'); }, notice: async () => { calls.push('notice'); }, stop: async () => { calls.push('stop'); }, release: async () => { calls.push('release'); },
    source: { enabled: () => true, allowed: () => true, send: async () => { calls.push('reply'); return 'sent'; } }, ...adapters };
  const driver = new ShadowDriver(store, { policy, scope: { scope: () => ({ listened: true, observed: false }) }, now: () => now,
    configured: () => configured, intervalMs: false, leaseMs: 1000, owner: 'driver-test', onEvent: e => events.push(e), ...options }, fake);
  t.after(async () => { await driver.stop({ abort: true }); store.close(); rmSync(dir, { recursive: true, force: true }); });
  const accept = async (id = 'input', thread = 'chat') => {
    driver.receive(trigger(id, thread)); await driver.idle(); const candidate = driver.engine.main.candidate(id); assert.ok(candidate);
    const result = driver.engine.main.decide(id, { evalId: candidate.evalId, kind: 'accept', title: 'work', scope: 'small', reason: 'explicit', acknowledgement: 'accepted' });
    assert.ok(result.ticketId); return result.ticketId;
  };
  return { dir, file, store, driver, fake, calls, candidates, tokens, events, accept, configure: (value: boolean) => { configured = value; }, time: (at: number) => { now = at; } };
}

test('real Core closed loop dispatches all six effects while delivery, read, idle and report remain distinct', async t => {
  const f = fixture(t); f.driver.start(); const id = await f.accept();
  assert.equal(f.candidates.length, 1); assert.equal(f.store.tickets.list().length, 1);
  await f.driver.idle(); const token = f.driver.engine.currentBinding(id)!; assert.deepEqual(token, f.tokens[0]);
  f.driver.receive({ ...trigger('followup'), human: false }); await f.driver.idle();
  const delivered = f.store.tickets.get(id)!; const raw = delivered.inputs.filter(i => i.kind === 'trigger'); assert.ok(raw.length);
  assert.deepEqual(delivered.undelivered, []); for (const input of raw) { assert.equal(input.deliveredTo, token.assignmentId); assert.equal(input.readAt, null); }
  assert.equal(delivered.ended, undefined); assert.equal(f.driver.engine.worker.turnEnded(token), true); await f.driver.idle(); assert.equal(f.store.tickets.get(id)?.ended, undefined);
  assert.equal(f.driver.engine.worker.read(token, raw.map(i => i.id)), true); for (const input of f.store.tickets.get(id)!.inputs) if (input.kind === 'trigger') assert.ok(input.readAt);
  assert.equal(f.driver.engine.worker.report(token, { state: 'ready', summary: 'verified complete' })?.id, id); await f.driver.idle();
  assert.equal(ticketOutcome(f.store.tickets.get(id)!), 'completed'); f.driver.engine.main.reply({ purpose: 'result', ticketId: id, text: 'done' }); await f.driver.idle();
  for (const kind of ['assessment', 'launch', 'delivery', 'reply', 'relay', 'notice']) assert.ok(f.calls.includes(kind), `${kind} was not dispatched`);
  assert.ok(f.calls.includes('release')); assert.ok(f.events.some(e => e.type === 'ticket.ended'));
});

test('unconfigured setup also retains already accepted launch and reply intents', async t => {
  const f = fixture(t); f.configure(false); f.driver.receive(trigger()); f.driver.engine.evaluateDue();
  const candidate = f.driver.engine.main.candidate('input')!;
  const result = f.driver.engine.main.decide('input', { evalId: candidate.evalId, kind: 'accept', title: 'offline', scope: 'small', reason: 'explicit', acknowledgement: 'queued' });
  const ticket = f.store.tickets.get(result.ticketId!)!; f.driver.start(); await f.driver.idle();
  assert.ok(!f.calls.includes('launch')); assert.ok(!f.calls.includes('reply')); assert.equal(f.store.effects.get('launch', ticket.assignments[0]!.id)?.status, 'pending');
  assert.ok(f.store.receipts.waiting().length); f.configure(true); await f.driver.idle(); assert.ok(f.calls.includes('launch')); assert.ok(f.calls.includes('reply'));
});

test('recover reconstructs missing controls and dispatches them while paused and unconfigured', async t => {
  const f = fixture(t); const ports = createShadowPorts(f.store, () => 1000); ports.assessor.release!('old-eval');
  f.store.db.run("DELETE FROM vivi_effects WHERE kind='control'"); f.configure(false); f.driver.setPaused(true); f.driver.start(); await f.driver.idle();
  assert.deepEqual(f.calls, ['release']); assert.equal(f.store.get<{ status: string }>('shadow:release:old-eval')?.status, 'done');
  f.driver.recover(); await f.driver.idle(); assert.deepEqual(f.calls, ['release']);
});

test('assessment completion delivers candidate only and never invents an accept decision', async t => {
  const f = fixture(t); f.driver.start(); f.driver.receive(trigger()); await f.driver.idle();
  assert.equal(f.candidates.length, 1); assert.equal(f.store.tickets.list().length, 0); assert.ok(f.driver.engine.main.candidate('input'));
  assert.equal(f.store.effects.get('assessment', f.candidates[0]!.evalId)?.status, 'done'); assert.ok(!f.calls.includes('launch'));
});

for (const rejection of ['launch', 'delivery'] as const) test(`known ${rejection} rejection commits failure without fake delivery/read`, async t => {
  const f = fixture(t, rejection === 'launch' ? { launch: async () => { throw new LaunchRejected('cannot launch'); } } : { delivery: async () => { throw new DeliveryRejected('cannot deliver'); } });
  f.driver.start(); const id = await f.accept(); await f.driver.idle();
  if (rejection === 'delivery') { f.driver.receive({ ...trigger('followup'), human: false }); await f.driver.idle(); }
  const ticket = f.store.tickets.get(id)!;
  assert.ok(ticket.inputs.every(i => i.kind !== 'trigger' || !i.readAt));
  if (rejection === 'launch') { assert.equal(f.driver.engine.currentBinding(id), undefined); assert.equal(ticket.assignments.at(-1)?.state, 'pending'); assert.equal(ticket.assignments.at(-1)?.report?.state, 'failed'); assert.equal(f.store.effects.get('launch', ticket.assignments.at(-1)!.id)?.status, 'done'); }
  else { assert.ok(ticket.undelivered.length); assert.match(ticket.delivery?.error ?? '', /cannot deliver/); assert.equal(f.store.effects.get('delivery', id)?.status, 'done'); }
});

test('unconfigured setup retains pending assessment and starts no external execution', async t => {
  const f = fixture(t); f.configure(false); f.driver.start(); f.driver.receive(trigger()); await f.driver.idle();
  assert.deepEqual(f.calls, []); assert.deepEqual(f.store.threads.get('fake:chat')?.pending, ['input']); assert.equal(f.store.tickets.list().length, 0);
  f.configure(true); await f.driver.idle(); assert.equal(f.candidates.length, 1); assert.ok(f.driver.engine.main.candidate('input'));
});

test('durable pause survives a new owner; resume alone dispatches retained intake', async t => {
  const f = fixture(t); f.driver.setPaused(true); f.driver.start(); f.driver.receive(trigger()); await f.driver.idle(); assert.deepEqual(f.calls, []);
  await f.driver.stop(); const reopened = openShadowStore(f.file); let calls = 0;
  const driver = new ShadowDriver(reopened, { policy, scope: { scope: () => ({ listened: true, observed: false }) }, now: () => 1000, intervalMs: false }, { assessment: async () => { calls++; } });
  try { driver.start(); await driver.idle(); assert.equal(driver.paused(), true); assert.equal(calls, 0); assert.ok(reopened.triggers.get('input'));
    driver.setPaused(false); await driver.idle(); assert.equal(calls, 1); assert.equal(driver.paused(), false);
  } finally { await driver.stop({ abort: true }); reopened.close(); }
});

test('pause setter outer SQL rollback leaves durable pause and queued work unchanged', async t => {
  const f = fixture(t); assert.throws(() => f.store.atomic(() => { f.driver.setPaused(true); throw new Error('abort pause'); }), /abort pause/);
  assert.equal(f.driver.paused(), false); f.driver.start(); f.driver.receive(trigger()); await f.driver.idle(); assert.equal(f.candidates.length, 1);
});

test('unknown launch result remains uncertain across reopening and never automatically relaunches', async t => {
  let launches = 0; const f = fixture(t, { launch: async () => { launches++; throw new Uncertain('remote launch unknown'); } });
  f.driver.start(); const id = await f.accept(); await f.driver.idle(); const assignment = f.store.tickets.get(id)!.assignments.at(-1)!;
  assert.equal(f.store.effects.get('launch', assignment.id)?.status, 'uncertain'); assert.equal(f.driver.engine.currentBinding(id), undefined); await f.driver.stop();
  const reopened = openShadowStore(f.file), driver = new ShadowDriver(reopened, { policy, scope: { scope: () => ({ listened: true, observed: false }) }, now: () => 100000, intervalMs: false }, { launch: async () => { launches++; } });
  try { driver.start(); await driver.idle(); driver.recover(); await driver.idle(); assert.equal(launches, 1); assert.equal(reopened.effects.get('launch', assignment.id)?.status, 'uncertain'); }
  finally { await driver.stop({ abort: true }); reopened.close(); }
});

for (const abort of [false, true]) test(`stop abort=${abort} waits for actual handler completion and immediately rejects receive`, async t => {
  const entered = gate(), release = gate(); let completed = false;
  const f = fixture(t, { assessment: async () => { entered.resolve(); await release.promise; completed = true; } });
  f.driver.start(); f.driver.receive(trigger()); await entered.promise; let drained = false; const stop = f.driver.stop({ abort }).then(() => { drained = true; });
  assert.throws(() => f.driver.receive(trigger('late')), /stopping/); assert.equal(f.store.triggers.get('late'), undefined); assert.throws(() => f.driver.setPaused(false), /stopping/);
  await Promise.resolve(); await Promise.resolve(); assert.equal(drained, false); assert.equal(completed, false);
  release.resolve(); await stop; assert.equal(completed, true); assert.equal(drained, true); assert.throws(() => f.driver.start(), /cannot restart/);
  const evaluation = f.store.threads.get('fake:chat')!.evaluating!;
  assert.equal(f.store.effects.get('assessment', evaluation.id)?.status, abort ? 'uncertain' : 'done');
});

test('Stop control carries original Assignment token even after retry launches a replacement', async t => {
  const entered = gate(), release = gate(); const controls: unknown[] = [];
  const f = fixture(t, { stop: async control => { controls.push(control); entered.resolve(); await release.promise; } });
  f.driver.start(); const id = await f.accept(); await f.driver.idle(); const old = f.driver.engine.currentBinding(id)!;
  f.driver.engine.worker.report(old, { state: 'failed', summary: 'retry needed' }); f.time(1001); f.driver.engine.people.retryTicket(id);
  await entered.promise; await f.driver.effects.idle('launch'); const current = f.driver.engine.currentBinding(id)!; assert.ok(current); assert.notEqual(current.assignmentId, old.assignmentId);
  assert.equal(controls.length, 1); assert.deepEqual(controls[0], f.store.get(stopControlKey(id, old.assignmentId)));
  const control = controls[0] as { assignmentId: string; binding: WorkerToken }; assert.equal(control.assignmentId, old.assignmentId); assert.deepEqual(control.binding, old);
  release.resolve(); await f.driver.idle(); assert.deepEqual(f.driver.engine.currentBinding(id), current); assert.equal(f.driver.engine.worker.report(old, { state: 'ready', summary: 'late' }), undefined);
});

test('Release control remains tied to old evaluation after reevaluation', async t => {
  const entered = gate(), release = gate(); const released: string[] = [];
  const f = fixture(t, { release: async control => { released.push(control.evalId); entered.resolve(); await release.promise; } });
  f.driver.start(); f.driver.receive(trigger()); await f.driver.idle(); const old = f.driver.engine.main.candidate('input')!;
  f.driver.engine.main.decide('input', { evalId: old.evalId, kind: 'unavailable', reason: 'offline' }); await entered.promise;
  f.driver.engine.people.reevaluate('input'); await f.driver.passes.pump(); await f.driver.effects.idle('assessment'); const current = f.driver.engine.main.candidate('input')!;
  assert.notEqual(current.evalId, old.evalId); release.resolve(); await f.driver.idle(); assert.deepEqual(released, [old.evalId]); assert.equal(f.driver.engine.main.candidate('input')?.evalId, current.evalId);
});

for (const mutation of ['generation', 'lease'] as const) test(`late launch ${mutation} cannot bind or deliver old external success`, async t => {
  const entered = gate(), release = gate(); const f = fixture(t, { launch: async () => { entered.resolve(); await release.promise; } });
  f.driver.start(); const id = await f.accept(); await entered.promise; const assignment = f.store.tickets.get(id)!.assignments.at(-1)!;
  if (mutation === 'generation') f.store.effects.enqueue('launch', assignment.id, { ticketId: 'other', assignmentId: assignment.id }, 1000);
  else { f.time(2000); f.driver.recover(); }
  release.resolve(); await f.driver.idle(); assert.equal(f.driver.engine.currentBinding(id), undefined); assert.equal(f.store.get(workerBindingKey(id)), undefined);
  assert.equal(f.store.tickets.get(id)?.assignments.at(-1)?.state, 'pending'); assert.ok(!f.calls.includes('delivery'));
});

for (const target of ['ticket', 'effect'] as const) test(`launch ${target} SQL ABORT rolls back binding, events and settlement; no second external launch`, async t => {
  let calls = 0, launchLimit = 0; const prepared = gate();
  const f = fixture(t, { launch: async () => { calls++; prepared.resolve(); } }, { limits: { launch: () => launchLimit } }); f.driver.start();
  const id = await f.accept(); const assignment = f.store.tickets.get(id)!.assignments.at(-1)!;
  f.store.db.exec(target === 'ticket' ? "CREATE TRIGGER fail_launch BEFORE UPDATE ON vivi_tickets BEGIN SELECT RAISE(ABORT,'launch abort'); END"
    : "CREATE TRIGGER fail_launch BEFORE UPDATE ON vivi_effects WHEN NEW.kind='launch' AND NEW.status='done' BEGIN SELECT RAISE(ABORT,'launch abort'); END");
  launchLimit = 1; f.driver.effects.kick(); await prepared.promise; await f.driver.idle(); assert.equal(calls, 1); assert.equal(f.store.tickets.get(id)?.assignments.at(-1)?.state, 'pending'); assert.equal(f.store.get(workerBindingKey(id)), undefined);
  assert.equal(f.store.effects.get('launch', assignment.id)?.status, 'uncertain'); assert.ok(!f.events.some(e => e.type === 'assignment.started'));
  f.store.db.exec('DROP TRIGGER fail_launch'); f.time(10000); f.driver.recover(); await f.driver.idle(); assert.equal(calls, 1);
});

test('receive SQL ABORT rolls back intake and emits no externally visible event', async t => {
  const f = fixture(t); f.driver.start(); f.store.db.exec("CREATE TRIGGER fail_intake BEFORE INSERT ON vivi_triggers BEGIN SELECT RAISE(ABORT,'intake abort'); END");
  assert.throws(() => f.driver.receive(trigger()), /intake abort/); await f.driver.idle(); assert.equal(f.store.triggers.get('input'), undefined); assert.deepEqual(f.events, []); assert.deepEqual(f.calls, []);
});

for (const mode of ['before-launch', 'after-launch'] as const) test(`real child crash ${mode} reopens uncertain without any automatic launch`, async t => {
  const f = fixture(t), journal = join(f.dir, 'external.jsonl');
  const child = spawnSync(process.execPath, [fileURLToPath(new URL('./fixtures/vivi-driver-crash.ts', import.meta.url)), f.file, journal, mode], { encoding: 'utf8', timeout: 10000 });
  assert.equal(child.error, undefined); assert.equal(child.status, mode === 'before-launch' ? 81 : 82, child.stderr);
  const ticket = f.store.tickets.list()[0]!; assert.ok(ticket); const assignment = ticket.assignments.at(-1)!;
  assert.equal(f.store.effects.get('launch', assignment.id)?.status, 'running'); assert.equal(f.store.get(workerBindingKey(ticket.id)), undefined);
  f.time(2000); f.driver.start(); await f.driver.idle(); assert.equal(f.store.effects.get('launch', assignment.id)?.status, 'uncertain');
  assert.ok(!f.calls.includes('launch')); assert.equal(f.store.tickets.get(ticket.id)?.assignments.at(-1)?.state, 'pending');
  if (mode === 'after-launch') assert.deepEqual(JSON.parse(readFileSync(journal, 'utf8')), { ticketId: ticket.id, assignmentId: assignment.id });
});
