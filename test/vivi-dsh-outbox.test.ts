// SPDX-License-Identifier: MIT
import test, { type TestContext } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ShadowEffects, Uncertain } from '../src/main/bot/shadow/effects.ts';
import { ShadowOutbox, type ShadowMessageSource } from '../src/main/bot/shadow/outbox.ts';
import { openShadowStore } from '../src/main/bot/shadow/store.ts';
import type { OutboundMessage } from '../src/main/bot/core/ports.ts';

function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
function message(id = 'm', ticketId = 'ticket', thread = 'chat'): OutboundMessage {
  return { id, ticketId, kind: 'reply', text: `first ${id}`, channel: { source: 'fake', thread, address: { room: thread } } };
}
function fixture(t: TestContext, source: Partial<ShadowMessageSource> = {}, paused?: () => boolean) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-outbox-')), file = join(dir, 'shadow.db');
  const store = openShadowStore(file); let now = 1000; const sent: string[] = [];
  const effects = new ShadowEffects(store, { now: () => now, leaseMs: 1000, owner: 'outbox-test' });
  const outbox = new ShadowOutbox(store, effects, { enabled: () => true, allowed: () => true, send: async m => { sent.push(m.id); return 'sent'; }, ...source }, { now: () => now, paused });
  t.after(async () => { await effects.drain({ abort: true }); store.close(); rmSync(dir, { recursive: true, force: true }); });
  return { store, file, effects, outbox, sent, time: (value: number) => { now = value; }, run: async () => { effects.start(); await effects.idle(); } };
}

test('first message is immutable across duplicate sends and durable sent receipts are terminal', async t => {
  const f = fixture(t); f.outbox.send(message()); const before = f.store.effects.get('reply', 'm');
  f.outbox.send({ ...message(), text: 'replacement', channel: { ...message().channel, address: { room: 'other' } } });
  assert.deepEqual(f.store.effects.get('reply', 'm'), before); assert.equal(f.store.receipts.get('m')?.text, 'first m');
  await f.run(); f.outbox.withdraw('m'); f.outbox.send({ ...message(), text: 'late' }); await f.effects.idle();
  assert.equal(f.outbox.status('m'), 'sent'); assert.deepEqual(f.sent, ['m']); assert.equal(f.store.receipts.get('m')?.text, 'first m');
});

for (const mode of ['gone', 'ignored'] as const) test(`${mode} drops once with durable reason and never resends`, async t => {
  let calls = 0; const f = fixture(t, { allowed: () => mode !== 'ignored', send: async () => { calls++; return 'gone'; } });
  f.outbox.send(message()); await f.run(); f.outbox.send(message()); f.outbox.withdraw('m'); await f.effects.idle();
  assert.equal(f.outbox.status('m'), 'dropped'); assert.equal(calls, mode === 'ignored' ? 0 : 1);
  assert.equal(f.store.receipts.get('m')?.dropped?.reason, mode === 'ignored' ? 'channelIgnored' : 'channelGone');
});

for (const mode of ['missing', 'waiting', 'paused'] as const) test(`${mode} preserves queue without counting ordinary failures`, async t => {
  let available = false, calls = 0; const f = fixture(t, { enabled: () => mode !== 'missing' || available,
    send: async () => { calls++; return mode === 'waiting' && !available ? 'waiting' : 'sent'; } }, () => mode === 'paused' && !available);
  f.outbox.send(message()); await f.run();
  assert.equal(f.outbox.status('m'), 'pending'); assert.equal(f.effects.failures('reply', 'm'), 0); assert.equal(calls, mode === 'waiting' ? 1 : 0);
  available = true; f.time(6000); f.effects.kick(); await f.effects.idle(); assert.equal(f.outbox.status('m'), 'sent');
});

test('same Ticket and channel cannot overtake until predecessor has three failures; other namespaces proceed', async t => {
  const calls: string[] = []; const f = fixture(t, { send: async m => { calls.push(m.id); if (m.id === 'first') throw new Error('definitely not sent'); return 'sent'; } });
  for (const m of [message('first'), message('second'), message('other-ticket', 'other'), message('other-channel', 'ticket', 'other')]) f.outbox.send(m);
  await f.run(); assert.deepEqual(calls, ['first', 'other-ticket', 'other-channel']); assert.equal(f.outbox.status('second'), 'pending');
  f.time(6000); await f.effects.idle(); assert.equal(f.effects.failures('reply', 'first'), 2); assert.equal(f.outbox.status('second'), 'pending');
  f.time(16000); await f.effects.idle(); assert.equal(f.effects.failures('reply', 'first'), 3); assert.equal(f.outbox.status('second'), 'sent');
  assert.deepEqual(calls, ['first', 'other-ticket', 'other-channel', 'first', 'first', 'second']);
});

test('uncertain predecessor blocks same namespace indefinitely while unrelated messages send', async t => {
  const calls: string[] = []; const f = fixture(t, { send: async m => { calls.push(m.id); if (m.id === 'first') throw new Uncertain('lost ack'); return 'sent'; } });
  f.outbox.send(message('first')); f.outbox.send(message('second')); f.outbox.send(message('other', 'other'));
  await f.run(); for (const at of [10000, 1000000]) { f.time(at); f.effects.pulse(); await f.effects.idle(); }
  assert.deepEqual(calls, ['first', 'other']); assert.equal(f.outbox.status('second'), 'pending'); assert.equal(f.store.effects.get('reply', 'first')?.status, 'uncertain');
});

test('withdraw of queued message removes unsent receipt and cancels intent without sending', async t => {
  const f = fixture(t); f.outbox.send(message()); f.outbox.withdraw('m'); await f.run();
  assert.equal(f.outbox.status('m'), undefined); assert.equal(f.store.effects.get('reply', 'm')?.status, 'cancelled'); assert.deepEqual(f.sent, []);
});

for (const result of ['sent', 'gone', 'not-sent', 'unknown'] as const) test(`running withdrawal preserves unknown send until explicit ${result} evidence`, async t => {
  const entered = gate(), release = gate(); let calls = 0;
  const f = fixture(t, { send: async () => { calls++; entered.resolve(); await release.promise; throw new Uncertain('remote unknown'); } });
  f.outbox.send(message()); f.effects.start(); await entered.promise;
  f.outbox.withdraw('m'); assert.equal(f.outbox.status('m'), 'pending'); assert.equal(f.store.get('shadow:withdraw:m'), true);
  release.resolve(); await f.effects.idle(); const expected = f.store.effects.get('reply', 'm')!;
  assert.equal(expected.status, 'uncertain'); f.outbox.withdraw('m'); assert.equal(f.outbox.status('m'), 'pending');
  assert.equal(f.outbox.reconcile(expected, result), result !== 'unknown'); await f.effects.idle();
  assert.equal(calls, 1); assert.equal(f.outbox.status('m'), result === 'sent' ? 'sent' : result === 'unknown' ? 'pending' : 'dropped');
  assert.equal(f.store.effects.get('reply', 'm')?.status, result === 'unknown' ? 'uncertain' : result === 'not-sent' ? 'cancelled' : 'done');
  if (result === 'gone' || result === 'not-sent') assert.equal(f.store.receipts.get('m')?.dropped?.reason, result === 'gone' ? 'channelGone' : 'withdrawn');
  if (result !== 'unknown') assert.equal(f.outbox.reconcile(expected, 'sent'), false);
});

test('withdraw while a real send succeeds preserves sent fact', async t => {
  const entered = gate(), release = gate(); const f = fixture(t, { send: async () => { entered.resolve(); await release.promise; return 'sent'; } });
  f.outbox.send(message()); f.effects.start(); await entered.promise; f.outbox.withdraw('m'); release.resolve(); await f.effects.idle();
  assert.equal(f.outbox.status('m'), 'sent'); assert.equal(f.store.effects.get('reply', 'm')?.status, 'done');
});

test('not-sent evidence permits one explicit retry with stable request identity', async t => {
  const ids: string[] = []; const f = fixture(t, { send: async (_m, ctx) => { ids.push(ctx.requestId); if (ids.length === 1) throw new Uncertain('lost'); return 'sent'; } });
  f.outbox.send(message()); await f.run(); const old = f.store.effects.get('reply', 'm')!;
  assert.equal(f.outbox.reconcile(old, 'not-sent'), true); await f.effects.idle(); assert.equal(f.outbox.status('m'), 'sent'); assert.equal(ids.length, 2); assert.equal(ids[0], ids[1]);
});

for (const target of ['receipt', 'effect'] as const) test(`${target} SQL ABORT rolls back sent and settle together; no automatic duplicate send`, async t => {
  let calls = 0; const f = fixture(t, { send: async () => { calls++; return 'sent'; } }); f.outbox.send(message());
  f.store.db.exec(target === 'receipt' ? "CREATE TRIGGER fail_commit BEFORE UPDATE ON dsh_outbox WHEN NEW.status='sent' BEGIN SELECT RAISE(ABORT,'commit abort'); END"
    : "CREATE TRIGGER fail_commit BEFORE UPDATE ON dsh_effects WHEN NEW.status='done' BEGIN SELECT RAISE(ABORT,'commit abort'); END");
  await f.run(); assert.equal(f.outbox.status('m'), 'pending'); const expected = f.store.effects.get('reply', 'm')!; assert.equal(expected.status, 'uncertain');
  f.time(90000); f.effects.pulse(); await f.effects.idle(); assert.equal(calls, 1);
  f.store.db.exec('DROP TRIGGER fail_commit'); assert.equal(f.outbox.reconcile(expected, 'sent'), true); await f.effects.idle(); assert.equal(calls, 1); assert.equal(f.outbox.status('m'), 'sent');
});

for (const mutation of ['lease', 'payload', 'receipt'] as const) test(`late ${mutation} changes reject old success or reconciliation`, async t => {
  const entered = gate(), release = gate(); let calls = 0, paused = false;
  const f = fixture(t, { send: async () => { calls++; entered.resolve(); await release.promise; return 'sent'; } }, () => paused);
  f.outbox.send(message()); f.effects.start(); await entered.promise; const claim = f.store.effects.get('reply', 'm')!;
  if (mutation === 'lease') { f.time(2000); f.effects.pulse(); }
  else if (mutation === 'payload') f.store.effects.enqueue('reply', 'm', { replacement: true }, 1000);
  else { const receipt = f.store.receipts.get('m')!; f.store.db.run('UPDATE dsh_outbox SET data=? WHERE id=?', JSON.stringify({ ...receipt, text: 'changed' }), 'm'); f.time(2000); f.effects.pulse(); }
  paused = true; release.resolve(); await f.effects.idle(); assert.equal(f.outbox.status('m'), 'pending'); assert.equal(calls, 1);
  assert.equal(f.outbox.reconcile({ ...claim, status: 'uncertain' }, 'sent'), mutation === 'lease');
  if (mutation === 'receipt') assert.equal(f.outbox.reconcile(f.store.effects.get('reply', 'm')!, 'sent'), false);
});

test('same Ticket and thread on different Sources do not block one another', async t => {
  const calls: string[] = []; const f = fixture(t, { send: async m => { calls.push(m.id); if (m.id === 'first') throw new Uncertain('unknown'); return 'sent'; } });
  f.outbox.send(message('first')); const other = message('other'); other.channel.source = 'another-source'; f.outbox.send(other); await f.run();
  assert.deepEqual(calls, ['first', 'other']); assert.equal(f.outbox.status('other'), 'sent');
});

test('reopened owner uses durable attempt to reconcile sent without repeating Source.send', async t => {
  let calls = 0; const f = fixture(t, { send: async () => { calls++; throw new Uncertain('lost ack'); } });
  f.outbox.send(message()); await f.run(); await f.effects.drain();
  const reopened = openShadowStore(f.file), effects = new ShadowEffects(reopened, { now: () => 100000, owner: 'new-owner' });
  const outbox = new ShadowOutbox(reopened, effects, { enabled: () => true, allowed: () => true, send: async () => { calls++; return 'sent'; } });
  try { effects.start(); await effects.idle(); assert.equal(calls, 1); const expected = reopened.effects.get('reply', 'm')!;
    assert.equal(expected.status, 'uncertain'); assert.equal(outbox.reconcile(expected, 'sent'), true); await effects.idle(); assert.equal(calls, 1); assert.equal(outbox.status('m'), 'sent');
  } finally { await effects.drain({ abort: true }); reopened.close(); }
});

test('enqueue SQL ABORT rolls back first message as well as effect', async t => {
  const f = fixture(t); f.store.db.exec("CREATE TRIGGER fail_enqueue BEFORE INSERT ON dsh_effects BEGIN SELECT RAISE(ABORT,'enqueue abort'); END");
  assert.throws(() => f.outbox.send(message()), /enqueue abort/); assert.equal(f.outbox.status('m'), undefined); assert.equal(f.store.effects.get('reply', 'm'), undefined);
  await f.run(); assert.deepEqual(f.sent, []);
});
