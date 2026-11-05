import assert from 'node:assert/strict';
import { afterEach, test } from 'node:test';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { ShadowEngine, type WorkerToken } from '../src/main/bot/shadow/engine.ts';
import { openShadowStore, type ShadowStore, type EffectKind } from '../src/main/bot/shadow/store.ts';
import { followupOwners, ticketOutcome } from '../src/main/bot/core/model.ts';
import type { Policy, DomainEvent } from '../src/main/bot/core/ports.ts';
import type { Trigger } from '../src/main/bot/core/model.ts';

const stores = new Set<ShadowStore>();
const directories: string[] = [];
afterEach(() => { for (const s of stores) s.close(); stores.clear(); for (const d of directories) rmSync(d, { recursive: true, force: true }); directories.length = 0; });
function database() { const d = mkdtempSync(join(tmpdir(), 'vivi-dsh-engine-')); directories.push(d); return join(d, 'shadow.db'); }
function trigger(id: string, thread = 't1', overrides: Partial<Trigger> = {}): Trigger {
  return { id, source: 'chat', threads: [{ source: 'chat', id: thread }], actor: { source: 'chat', id: 'alice' }, human: true,
    at: '2026-09-23T00:00:00.000Z', text: `message ${id}`, channel: { source: 'chat', thread, address: { message: id } }, meta: {}, ...overrides };
}
function harness(file = ':memory:') {
  const store = openShadowStore(file); stores.add(store);
  let now = Date.parse('2026-09-23T00:00:00.000Z');
  let version = 'v1';
  const events: DomainEvent[] = []; let wakes = 0;
  const policy: Policy = {
    get version() { return version; }, paused: false, evalTimeoutMs: 60_000,
    gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice'
      ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
      : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
    revalidate: () => version !== 'revoked', admitsInferred: rules => rules.length > 0,
  };
  const engine = new ShadowEngine(store, { policy: () => policy, scope: { scope: t => t.meta.blocked ? { listened: false, reason: 'blocked' } : { listened: true, observed: false } },
    now: () => now, onEvent: e => events.push(e), wake: () => { wakes++; } });
  const claim = (kind: EffectKind, key?: string) => {
    const effect = key ? store.effects.get(kind, key) : store.effects.due(kind, now)[0];
    assert.ok(effect, `missing ${kind} intent`);
    const result = store.effects.claim(kind, effect.key, 'manual-driver', now, 30_000);
    assert.ok(result, `unclaimable ${kind} intent`); return result;
  };
  function accept(id = '1', thread = 't1', acknowledgement = 'accepted') {
    engine.sources.receive(trigger(id, thread)); engine.evaluateDue();
    const candidate = engine.main.candidate(id)!; assert.ok(candidate);
    assert.equal(engine.completeAssessment(claim('assessment', candidate.evalId)), true);
    const decision = engine.main.decide(id, { evalId: candidate.evalId, kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement });
    assert.ok(decision.ticketId); return store.tickets.get(decision.ticketId)!;
  }
  function launch(ticketId: string) {
    const ticket = store.tickets.get(ticketId)!;
    const token = engine.completeLaunch(claim('launch', ticket.assignments.at(-1)!.id)); assert.ok(token);
    engine.sources.receive(trigger(`context:${token.assignmentId}`, store.triggers.get(ticket.origin.triggerId)!.threads[0]!.id, { human: false }));
    return token;
  }
  function deliver(token: WorkerToken) { return engine.completeDelivery(claim('delivery', token.ticketId), token); }
  return { store, engine, events, claim, accept, launch, deliver, policy, wakes: () => wakes, now: () => now, tick: (ms = 1) => { now += ms; }, version: (v: string) => { version = v; } };
}
function snapshot(store: ShadowStore) {
  return ['dsh_triggers', 'dsh_dispositions', 'dsh_threads', 'dsh_decisions', 'dsh_tickets', 'dsh_assignments', 'dsh_effects', 'dsh_outbox', 'dsh_kv', 'dsh_session_receipts']
    .map(table => [table, store.db.all(`SELECT * FROM ${table} ORDER BY rowid`)]);
}

test('manual fake closed loop persists assessment, launch, delivery, read, report, result and completions', () => {
  const h = harness(); const ticket = h.accept(); const token = h.launch(ticket.id);
  assert.equal(h.deliver(token), true);
  const delivered = h.store.tickets.get(ticket.id)!;
  assert.deepEqual(delivered.undelivered, []);
  assert.equal(h.engine.worker.read(token, delivered.inputs.map(i => i.id)), true);
  assert.equal(h.engine.worker.turnEnded(token), true);
  const ready = h.engine.worker.report(token, { state: 'ready', summary: 'done' })!;
  assert.equal(ticketOutcome(ready), 'completed');
  const result = h.engine.main.reply({ purpose: 'result', ticketId: ticket.id, text: 'done' });
  assert.equal(h.engine.completeMessage(h.claim('reply', result.id)), true);
  assert.equal(h.store.receipts.get(result.id)?.status, 'sent');
  for (const kind of ['relay', 'notice', 'reply'] as const) for (const pending of h.store.effects.due(kind, h.now())) {
    const claim = h.claim(kind, pending.key); assert.equal(h.engine.completeMessage(claim), true); assert.equal(h.engine.completeMessage(claim), false);
  }
  assert.ok(h.events.some(e => e.type === 'ticket.created')); assert.ok(h.wakes() > 0);
});

test('lease expiring during synchronous completion rolls back facts, binding, events and settlement', () => {
  const h = harness(); const ticket = h.accept();
  const claim = h.claim('launch', ticket.assignments.at(-1)!.id);
  const before = snapshot(h.store); const events = h.events.length; const wakes = h.wakes();
  const save = h.store.tickets.save;
  h.store.tickets.save = current => { save(current); h.tick(30_001); };
  try { assert.throws(() => h.engine.completeLaunch(claim), /所有权已变化/); }
  finally { h.store.tickets.save = save; }
  assert.deepEqual(snapshot(h.store), before);
  assert.equal(h.store.tickets.get(ticket.id)!.assignments.at(-1)!.state, 'pending');
  assert.equal(h.store.effects.get('launch', claim.key)!.status, 'running');
  assert.equal(h.events.length, events); assert.equal(h.wakes(), wakes);
});

test('source filtering, intake duplicates and accept batch identity create one ticket', () => {
  const h = harness();
  assert.equal(h.engine.sources.receive(trigger('blocked', 'no', { meta: { blocked: true } })), 'filtered');
  assert.equal(h.engine.sources.receive(trigger('1')), 'stored'); assert.equal(h.engine.sources.receive(trigger('1')), 'duplicate');
  h.engine.sources.receive(trigger('2')); h.engine.evaluateDue();
  const c = h.engine.main.candidate('1')!; assert.deepEqual(c.triggers.map(t => t.id), ['1', '2']);
  const outcome = { evalId: c.evalId, kind: 'accept' as const, title: 'batch', scope: 'small', reason: 'requested' };
  const d = h.engine.main.decide('1', outcome);
  assert.equal(h.engine.main.decide('2', { ...outcome, evalId: undefined }).ticketId, d.ticketId);
  assert.equal(h.store.tickets.list().length, 1);
  assert.equal(h.store.db.all('SELECT * FROM dsh_accepted_triggers').length, 2);
});

test('old policy and replaced evaluations cannot accept or complete stale assessment', () => {
  const h = harness(); h.engine.sources.receive(trigger('1')); h.engine.evaluateDue();
  const c = h.engine.main.candidate('1')!; const old = h.claim('assessment', c.evalId);
  h.version('v2'); h.engine.policyChanged('v1', 'v2'); h.engine.evaluateDue();
  assert.equal(h.engine.completeAssessment(old), false);
  assert.throws(() => h.engine.main.decide('1', { evalId: c.evalId, kind: 'accept', title: 'bad', scope: 'bad', reason: 'stale' }));
  const next = h.engine.main.candidate('1')!; assert.notEqual(next.evalId, c.evalId);
  h.version('v3');
  assert.equal(h.engine.main.decide('1', { evalId: next.evalId, kind: 'accept', title: 'bad', scope: 'bad', reason: 'stale policy' }).kind, 'unavailable');
  assert.equal(h.store.tickets.list().length, 0);
});

test('main note, waiting status and policy effects queue durable delivery inputs', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  assert.equal(h.engine.main.requestStatus(t.id), false);
  h.engine.worker.report(token, { state: 'waiting', summary: 'waiting' }); h.tick();
  assert.equal(h.engine.main.requestStatus(t.id), true);
  h.engine.main.note(t.id, 'context fact'); h.tick(); h.version('v2');
  h.engine.policyChanged('v1', 'v2', new Map([[t.id, { requesterAllowed: false as const }]]));
  const current = h.store.tickets.get(t.id)!;
  assert.ok(current.inputs.some(i => i.kind === 'note' && i.text === 'context fact'));
  assert.ok(current.inputs.some(i => i.kind === 'text'));
  assert.ok(current.inputs.some(i => i.kind === 'policy-changed'));
  assert.equal(h.store.effects.get('delivery', t.id)?.status, 'pending');
});

test('owner followups stay with workers until handback; context-only follows grant no ownership', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  h.engine.sources.receive(trigger('followup'));
  assert.deepEqual(followupOwners(trigger('followup'), h.store), [t.id]);
  assert.throws(() => h.engine.main.decide('followup', { kind: 'ignore', reason: 'not main owned' }));
  assert.equal(h.engine.worker.handback(token, 'followup', 'separate request'), true);
  assert.deepEqual(followupOwners(trigger('followup'), h.store), []);
  h.engine.evaluateDue(); assert.ok(h.engine.main.candidate('followup'));
  assert.equal(h.engine.worker.followForContext(token, { source: 'chat', id: 'context' }), true);
  assert.equal(h.engine.worker.followForContext(token, { source: 'chat', id: 'context' }), false);
  h.engine.sources.receive(trigger('context-event', 'context'));
  assert.deepEqual(followupOwners(trigger('context-event', 'context'), h.store), []);
  assert.throws(() => h.engine.worker.reply(token, { purpose: 'acknowledgement', ticketId: t.id, triggerId: 'context-event', text: 'forbidden' }));
  h.engine.worker.markUnrelated(token, 'chat:context', 'irrelevant');
  assert.ok(!h.store.threads.get('chat:context')!.subscriptions.includes(t.id));
});

test('attach routes another thread to the ticket and unsubscribe removes subscriptions', () => {
  const h = harness(); const t = h.accept(); h.launch(t.id);
  h.engine.sources.receive(trigger('other', 'other')); h.engine.evaluateDue();
  h.engine.main.attach(t.id, 'other', 'routing note');
  assert.equal(h.engine.main.candidate('other'), undefined);
  assert.ok(h.store.tickets.get(t.id)!.inputs.some(i => i.kind === 'trigger' && i.triggerId === 'other' && i.note === 'routing note'));
  assert.equal(h.engine.people.unsubscribe('chat:other'), true); assert.equal(h.engine.people.unsubscribe('chat:other'), false);
});

test('ready report waits for bound own Follow closure, context follow does not delay completion', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  h.engine.sources.bindThread(t.id, { source: 'chat', id: 'pr' }, true);
  h.engine.worker.followForContext(token, { source: 'chat', id: 'context' });
  assert.equal(h.engine.worker.report(token, { state: 'ready', summary: 'ready for merge' })!.ended, undefined);
  h.engine.sources.threadClosed({ source: 'chat', id: 'pr' }, 'merged', new Date(h.now()).toISOString());
  assert.equal(ticketOutcome(h.store.tickets.get(t.id)!), 'merged');
});

test('ack preserves first message, attention replacement withdraws pending reply, answer needs worker report', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  const ack = h.engine.worker.reply(token, { purpose: 'acknowledgement', ticketId: t.id, triggerId: '1', text: 'replacement' })!;
  assert.equal(ack.reused, true); assert.equal(h.store.receipts.get(ack.id)?.text, 'accepted');
  h.engine.worker.report(token, { state: 'blocked', summary: 'need help', question: 'which?', askedBy: '1' });
  const attention = h.engine.main.reply({ purpose: 'attention', ticketId: t.id, question: 'which?', text: 'which?' });
  h.tick(); h.engine.worker.report(token, { state: 'progress', summary: 'resolved', question: null });
  assert.equal(h.store.effects.get('reply', attention.id)?.status, 'cancelled');
  assert.throws(() => h.engine.main.reply({ purpose: 'result', ticketId: t.id, text: 'premature' }));
  h.engine.sources.receive(trigger('question'));
  assert.throws(() => h.engine.main.reply({ purpose: 'answer', ticketId: t.id, triggerId: 'question', text: 'premature' }));
  h.engine.worker.report(token, { state: 'progress', summary: 'answer', answers: 'question' });
  const answer = h.engine.worker.reply(token, { purpose: 'answer', ticketId: t.id, triggerId: 'question', text: 'answer' })!;
  assert.equal(h.store.receipts.get(answer.id)?.text, 'answer');
});

test('reevaluate and dismiss close unavailable decision commands', () => {
  const h = harness(); h.engine.sources.receive(trigger('1')); h.engine.evaluateDue();
  const c = h.engine.main.candidate('1')!;
  const d = h.engine.main.decide('1', { evalId: c.evalId, kind: 'unavailable', reason: 'offline' });
  assert.equal(h.engine.people.dismiss(d.id).dismissed, true);
  assert.equal(h.engine.people.reevaluate('1'), true); h.engine.evaluateDue();
  const next = h.engine.main.candidate('1')!;
  assert.notEqual(next.evalId, c.evalId);
  assert.equal(h.engine.completeAssessment(h.claim('assessment', next.evalId)), true);
  assert.throws(() => h.engine.main.decide('1', { evalId: c.evalId, kind: 'accept', title: 'stale', scope: 'bad', reason: 'old eval' }));
  assert.equal(h.engine.main.decide('1', { evalId: next.evalId, kind: 'ignore', reason: 'new assessment' }).evalId, next.evalId);
});

test('frozen-clock reevaluation after reopening retains distinct identities and rejects old outcomes', () => {
  const file = database(); const h = harness(file);
  h.engine.sources.receive(trigger('1')); h.engine.evaluateDue(); const first = h.engine.main.candidate('1')!;
  h.engine.main.decide('1', { evalId: first.evalId, kind: 'unavailable', reason: 'offline' });
  h.store.close(); stores.delete(h.store);
  const recovered = harness(file);
  recovered.engine.people.reevaluate('1'); recovered.engine.evaluateDue();
  const next = recovered.engine.main.candidate('1')!; assert.notEqual(next.evalId, first.evalId);
  assert.throws(() => recovered.engine.main.decide('1', { evalId: first.evalId, kind: 'accept', title: 'old', scope: 'bad', reason: 'stale' }));
  assert.equal(recovered.engine.completeAssessment(recovered.claim('assessment', next.evalId)), true);
});

for (const action of ['stop', 'retry'] as const) test(`${action} fences every old worker callback and delivery completion`, () => {
  const h = harness(); const t = h.accept(); const old = h.launch(t.id);
  const delivery = h.claim('delivery', t.id);
  if (action === 'stop') h.engine.people.stopTicket(t.id, 'user stop');
  else { h.engine.worker.report(old, { state: 'failed', summary: 'failed' }); h.tick(); h.engine.people.retryTicket(t.id); }
  const before = snapshot(h.store);
  assert.equal(h.engine.completeDelivery(delivery, old), false);
  assert.equal(h.engine.worker.report(old, { state: 'ready', summary: 'late' }), undefined);
  assert.equal(h.engine.worker.read(old, t.inputs.map(i => i.id)), false);
  assert.equal(h.engine.worker.turnEnded(old), false);
  assert.equal(h.engine.worker.deliveryFailed(old, 'late error', delivery), false);
  assert.equal(h.engine.worker.interrupted(old), false);
  assert.equal(h.engine.worker.reply(old, { purpose: 'result', ticketId: t.id, text: 'late result' }), undefined);
  assert.equal(h.engine.worker.handback(old, '1', 'late'), false);
  assert.equal(h.engine.worker.followForContext(old, { source: 'chat', id: 'late' }), false);
  assert.equal(h.engine.worker.markUnrelated(old, 'chat:t1', 'late'), false);
  // Invalid completion may release its own effect lease, but never alter domain facts.
  const after = snapshot(h.store);
  assert.deepEqual(after.filter(([name]) => name !== 'dsh_effects'), before.filter(([name]) => name !== 'dsh_effects'));
  if (action === 'retry') { const next = h.launch(t.id); assert.notEqual(next.assignmentId, old.assignmentId); }
});

test('cross-assignment forged tokens cannot report, read, deliver or reply for another ticket', () => {
  const h = harness(); const a = h.accept('1', 'a'); const ta = h.launch(a.id); h.deliver(ta);
  const b = h.accept('2', 'b'); const tb = h.launch(b.id);
  const forged = { ...ta, assignmentId: tb.assignmentId };
  const delivery = h.claim('delivery', b.id);
  const before = snapshot(h.store);
  assert.equal(h.engine.completeDelivery(delivery, forged), false);
  assert.equal(h.engine.worker.report(forged, { state: 'ready', summary: 'forged' }), undefined);
  assert.equal(h.engine.worker.read(forged, b.inputs.map(i => i.id)), false);
  assert.throws(() => h.engine.worker.reply(ta, { purpose: 'acknowledgement', ticketId: b.id, triggerId: '2', text: 'forged' }), /另一个 Ticket/);
  assert.deepEqual(snapshot(h.store), before);
});

test('worker token generation and claimToken are checked independently without changing any durable state', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  const before = snapshot(h.store);
  for (const forged of [{ ...token, generation: token.generation + 1 }, { ...token, claimToken: token.claimToken + 1 }, { ...token, ticketId: 'missing' }]) {
    assert.equal(h.engine.worker.report(forged, { state: 'ready', summary: 'forged' }), undefined);
    assert.equal(h.engine.worker.read(forged, t.inputs.map(i => i.id)), false);
    assert.equal(h.engine.worker.turnEnded(forged), false);
    assert.equal(h.engine.worker.interrupted(forged), false);
    assert.equal(h.engine.worker.handback(forged, '1', 'forged'), false);
    assert.equal(h.engine.worker.followForContext(forged, { source: 'chat', id: 'forged' }), false);
    assert.equal(h.engine.worker.markUnrelated(forged, 'chat:t1', 'forged'), false);
  }
  assert.deepEqual(snapshot(h.store), before);
});

test('generation, owner and expired completion claims cannot mutate domain', () => {
  const h = harness(); const t = h.accept(); const assignment = t.assignments.at(-1)!;
  const old = h.claim('launch', assignment.id);
  const before = h.store.tickets.get(t.id);
  assert.equal(h.engine.completeLaunch({ ...old, leaseOwner: 'forged-owner' }), undefined);
  assert.deepEqual(h.store.tickets.get(t.id), before);
  h.store.effects.enqueue('launch', old.key, old.payload, h.now());
  assert.equal(h.engine.completeLaunch(old), undefined);
  assert.deepEqual(h.store.tickets.get(t.id), before);
  assert.equal(h.store.effects.get('launch', old.key)?.status, 'pending');
  const current = h.claim('launch', old.key); h.tick(30_001);
  assert.equal(h.engine.completeLaunch(current), undefined);
  assert.deepEqual(h.store.tickets.get(t.id), before);
});

test('failed launch and failed delivery are durable and human retry starts a fresh assignment', () => {
  const h = harness(); const t = h.accept(); const claim = h.claim('launch');
  assert.equal(h.engine.failLaunch(claim, 'cannot launch'), true);
  assert.equal(h.engine.failLaunch(claim, 'duplicate'), false);
  assert.equal(h.store.tickets.get(t.id)!.assignments.at(-1)!.report?.state, 'failed');
  h.tick(); h.engine.people.retryTicket(t.id); const token = h.launch(t.id); h.deliver(token);
  h.engine.main.note(t.id, 'delivery retry');
  assert.equal(h.engine.worker.deliveryFailed(token, 'cannot deliver', h.claim('delivery', t.id)), true);
  assert.equal(h.store.tickets.get(t.id)?.delivery?.error, 'cannot deliver');
});

for (const point of ['intake', 'accept', 'report'] as const) test(`SQL ABORT during ${point} rolls back facts, effects, events and wakes`, () => {
  const h = harness();
  let run: () => unknown;
  if (point === 'intake') run = () => h.store.atomic(() => { h.engine.sources.receive(trigger('1')); h.engine.evaluateDue(); });
  else if (point === 'accept') {
    h.engine.sources.receive(trigger('1')); h.engine.evaluateDue(); const c = h.engine.main.candidate('1')!;
    run = () => h.engine.main.decide('1', { evalId: c.evalId, kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' });
  } else {
    const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
    run = () => h.engine.worker.report(token, { state: 'progress', summary: 'must rollback', answers: '1' });
  }
  const kind = point === 'report' ? 'relay' : point === 'intake' ? 'assessment' : 'launch';
  h.store.db.exec(`CREATE TRIGGER fail_intent BEFORE INSERT ON dsh_effects WHEN NEW.kind='${kind}' BEGIN SELECT RAISE(ABORT,'forced engine failure'); END`);
  const before = snapshot(h.store), count = h.events.length, wakes = h.wakes();
  assert.throws(run, /forced engine failure/);
  assert.deepEqual(snapshot(h.store), before);
  assert.equal(h.events.length, count); assert.equal(h.wakes(), wakes);
});

test('launch completion failure rolls back binding, Assignment, delivery and completion settlement together', () => {
  const h = harness(); const t = h.accept();
  h.engine.sources.receive(trigger('before-launch-input'));
  const claim = h.claim('launch');
  h.store.db.exec("CREATE TRIGGER fail_launch_delivery BEFORE INSERT ON dsh_effects WHEN NEW.kind='delivery' BEGIN SELECT RAISE(ABORT,'forced completion failure'); END");
  const before = snapshot(h.store), events = h.events.length, wakes = h.wakes();
  assert.throws(() => h.engine.completeLaunch(claim), /forced completion failure/);
  assert.deepEqual(snapshot(h.store), before); assert.equal(h.events.length, events); assert.equal(h.wakes(), wakes);
  h.store.db.exec('DROP TRIGGER fail_launch_delivery');
  const token = h.engine.completeLaunch(claim); assert.ok(token); assert.equal(h.deliver(token), true);
});

test('people stop notice failure rolls back ended facts, stop control and observer notifications', () => {
  const h = harness(); const t = h.accept(); h.launch(t.id);
  h.store.db.exec("CREATE TRIGGER fail_stop_notice BEFORE INSERT ON dsh_effects WHEN NEW.kind='notice' BEGIN SELECT RAISE(ABORT,'forced stop failure'); END");
  const before = snapshot(h.store), events = h.events.length, wakes = h.wakes();
  assert.throws(() => h.engine.people.stopTicket(t.id, 'user request'), /forced stop failure/);
  assert.deepEqual(snapshot(h.store), before); assert.equal(h.events.length, events); assert.equal(h.wakes(), wakes);
});

test('launch failure followed by human input requeues the same pending Assignment with a new generation', () => {
  const h = harness(); const t = h.accept(); const original = h.claim('launch');
  assert.equal(h.engine.failLaunch(original, 'temporary launch failure'), true);
  const failed = h.store.effects.get('launch', original.key)!; assert.equal(failed.status, 'done');
  h.tick(); h.engine.sources.receive(trigger('human-recovery'));
  const pending = h.store.tickets.get(t.id)!;
  assert.equal(pending.assignments.length, 1); assert.equal(pending.assignments[0]!.state, 'pending');
  const replacement = h.store.effects.get('launch', original.key)!;
  assert.equal(replacement.status, 'pending'); assert.equal(replacement.generation, original.generation + 1);
  assert.equal(h.engine.completeLaunch(original), undefined);
  const token = h.launch(t.id); assert.equal(token.assignmentId, original.key); assert.equal(h.deliver(token), true);
});

test('worker reads only inputs delivered to its current Assignment', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id);
  const input = h.store.tickets.get(t.id)!.inputs[0]!;
  assert.equal(h.engine.worker.read(token, [input.id]), false);
  assert.equal(h.engine.worker.read(token, ['missing']), false);
  assert.equal(h.deliver(token), true);
  assert.equal(h.engine.worker.read(token, [input.id]), true);
  const read = h.store.tickets.get(t.id)!.inputs.find(i => i.id === input.id)!;
  assert.ok(read.kind === 'trigger' && read.readAt);
});

test('same Assignment delivery update across connections fences old success and failure claims', () => {
  const file = database(); const h = harness(file); const t = h.accept(); const token = h.launch(t.id);
  const old = h.claim('delivery', t.id); const other = harness(file);
  other.engine.main.note(t.id, 'new generation');
  assert.equal(other.store.effects.get('delivery', t.id)?.status, 'running');
  assert.equal(other.store.effects.claim('delivery', t.id, 'second-owner', h.now(), 30_000), undefined);
  const before = h.store.tickets.get(t.id);
  assert.equal(h.engine.worker.deliveryFailed(token, 'obsolete failure', old), false);
  assert.equal(h.engine.completeDelivery(old, token), false);
  assert.deepEqual(h.store.tickets.get(t.id), before);
  assert.equal(h.store.effects.get('delivery', t.id)?.status, 'pending');
  const current = h.claim('delivery', t.id);
  assert.equal(h.engine.completeDelivery(current, token), true);
  assert.equal(h.engine.worker.deliveryFailed(token, 'late duplicate', current), false);
  assert.equal(h.store.tickets.get(t.id)?.delivery, undefined);
});

test('stop before launch and invalid completion tokens preserve the complete durable snapshot', () => {
  const h = harness(); const t = h.accept(); const launch = h.claim('launch');
  h.engine.people.stopTicket(t.id);
  const before = snapshot(h.store);
  assert.equal(h.engine.completeLaunch(launch), undefined);
  assert.equal(h.engine.failLaunch(launch, 'late'), false);
  assert.deepEqual(snapshot(h.store), before);
  assert.ok(h.store.get(`shadow:stop:${JSON.stringify([t.id, launch.key])}`));
  assert.ok(h.store.effects.due('notice', h.now()).length > 0);
});

test('interrupted busy worker persists recovery launch and rejects the old binding', () => {
  const h = harness(); const t = h.accept(); const old = h.launch(t.id); h.deliver(old);
  assert.equal(h.engine.worker.interrupted(old), true);
  const restarted = h.store.tickets.get(t.id)!;
  assert.equal(restarted.assignments.length, 2);
  assert.ok(restarted.inputs.some(i => i.kind === 'text' && i.text.includes('host restarted')));
  assert.equal(h.engine.worker.report(old, { state: 'ready', summary: 'late' }), undefined);
  assert.ok(h.store.effects.get('launch', restarted.assignments.at(-1)!.id));
});

test('ordinary progress stays quiet, worker followup and answer reports enqueue relays', () => {
  const h = harness(); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  assert.deepEqual(h.store.effects.due('relay', h.now()), []);
  h.engine.worker.report(token, { state: 'progress', summary: 'quiet progress' });
  assert.deepEqual(h.store.effects.due('relay', h.now()), []);
  h.engine.sources.receive(trigger('owned-question'));
  const followup = h.store.effects.get('relay', 'followup:owned-question')!; assert.ok(followup);
  assert.equal(JSON.parse((followup.payload as { text: string }).text).kind, 'follow_up');
  h.tick(); h.engine.worker.report(token, { state: 'progress', summary: 'answer reported', answers: 'owned-question' });
  assert.equal(h.store.effects.due('relay', h.now()).length, 2);
});

test('quiet Main commands suppress self notices while people requeue and unsubscribe persist notices', () => {
  const h = harness(); const t = h.accept(); h.launch(t.id);
  assert.deepEqual(h.store.effects.due('notice', h.now()), []);
  h.engine.main.note(t.id, 'context');
  assert.deepEqual(h.store.effects.due('notice', h.now()), []);
  assert.equal(h.engine.people.unsubscribe('chat:t1'), true);
  assert.ok(h.store.effects.due('notice', h.now()).length > 0);
});

test('second connection and notifications observe only the outer transaction commit', () => {
  const file = database(); const h = harness(file); const other = harness(file);
  h.store.atomic(() => {
    h.engine.sources.receive(trigger('1')); h.engine.evaluateDue();
    assert.ok(h.store.triggers.get('1')); assert.equal(other.store.triggers.get('1'), undefined);
    assert.deepEqual(other.store.threads.list(), []); assert.equal(h.events.length, 0); assert.equal(h.wakes(), 0);
  });
  assert.ok(other.store.triggers.get('1')); assert.equal(other.store.effects.due('assessment', h.now()).length, 1);
  assert.ok(h.events.length > 0); assert.ok(h.wakes() > 0);
});

test('report and relay survive reopen together; duplicate callbacks cannot repeat completed effect', () => {
  const file = database(); const h = harness(file); const t = h.accept(); const token = h.launch(t.id); h.deliver(token);
  h.engine.worker.report(token, { state: 'waiting', summary: 'persistent report' });
  const pending = h.store.effects.due('relay', h.now()); assert.equal(pending.length, 1);
  h.store.close(); stores.delete(h.store);
  const recovered = harness(file);
  assert.equal(recovered.store.tickets.get(t.id)!.assignments.at(-1)!.report?.summary, 'persistent report');
  const claim = recovered.claim('relay', pending[0]!.key);
  assert.equal(recovered.engine.completeMessage(claim), true);
  assert.equal(recovered.engine.completeMessage(claim), false);
  assert.equal(recovered.store.effects.due('relay', recovered.now()).length, 0);
});

for (const phase of ['report-before', 'report-after'] as const) test(`real child exit ${phase} commits report and relay as one unit`, () => {
  const file = database();
  const child = spawnSync(process.execPath, [new URL('./fixtures/vivi-dsh-engine-crash.ts', import.meta.url).pathname, file, phase], { encoding: 'utf8' });
  assert.equal(child.status, phase === 'report-before' ? 53 : 54, child.stderr);
  const h = harness(file); const ticket = h.store.tickets.list()[0]!;
  assert.ok(ticket); assert.equal(ticket.assignments.at(-1)!.state, 'running');
  const relay = h.store.effects.due('relay', h.now());
  if (phase === 'report-before') {
    assert.equal(ticket.assignments.at(-1)!.report, undefined); assert.deepEqual(relay, []);
  } else {
    assert.equal(ticket.assignments.at(-1)!.report?.summary, 'crash-persisted report'); assert.equal(relay.length, 1);
    const claim = h.claim('relay', relay[0]!.key);
    assert.equal(h.engine.completeMessage(claim), true); assert.equal(h.engine.completeMessage(claim), false);
    assert.deepEqual(h.store.effects.due('relay', h.now()), []);
  }
});

for (const phase of ['before', 'after'] as const) test(`real child exit ${phase} commit recovers domain facts and durable intents together`, () => {
  const file = database();
  const child = spawnSync(process.execPath, [new URL('./fixtures/vivi-dsh-engine-crash.ts', import.meta.url).pathname, file, phase], { encoding: 'utf8' });
  assert.equal(child.status, phase === 'before' ? 51 : 52, child.stderr);
  const h = harness(file);
  if (phase === 'before') {
    assert.equal(h.store.triggers.get('crash-trigger'), undefined); assert.deepEqual(h.store.tickets.list(), []);
    for (const kind of ['launch', 'reply', 'notice', 'assessment'] as const) assert.deepEqual(h.store.effects.due(kind, h.now()), []);
  } else {
    assert.ok(h.store.triggers.get('crash-trigger')); assert.equal(h.store.tickets.list().length, 1);
    const t = h.store.tickets.list()[0]!; const token = h.launch(t.id); assert.equal(h.deliver(token), true);
    assert.equal(h.store.effects.due('launch', h.now()).length, 0);
    assert.equal(h.engine.completeLaunch(h.store.effects.get('launch', token.assignmentId)!), undefined);
    const ack = h.store.receipts.waiting().find(r => r.kind === 'acknowledgement')!; assert.ok(ack);
    const claim = h.claim('reply', ack.id); assert.equal(h.engine.completeMessage(claim), true); assert.equal(h.engine.completeMessage(claim), false);
  }
});
