import { openShadowStore } from '../../src/main/bot/shadow/store.ts';
import { ShadowEngine } from '../../src/main/bot/shadow/engine.ts';

// Exit directly inside the real command transaction/afterCommit, leaving SQLite WAL recovery to the parent.
const [file, phase] = process.argv.slice(2);
if (!file || !['before', 'after', 'report-before', 'report-after'].includes(phase!)) throw new Error('invalid engine crash arguments');
const store = openShadowStore(file);
const now = Date.parse('2026-09-23T00:00:00.000Z');
const engine = new ShadowEngine(store, {
  now: () => now,
  scope: { scope: () => ({ listened: true, observed: false }) },
  policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60_000,
    gate: t => t.human && t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : { admissible: false, reason: 'not fixture member' },
    revalidate: () => true, admitsInferred: () => false }),
});
store.atomic(() => {
  engine.sources.receive({ id: 'crash-trigger', source: 'chat', threads: [{ source: 'chat', id: 'crash' }],
    actor: { source: 'chat', id: 'alice' }, human: true, at: new Date(now).toISOString(), text: 'crash request',
    channel: { source: 'chat', thread: 'crash', address: {} }, meta: {} });
  engine.evaluateDue();
  const candidate = engine.main.candidate('crash-trigger')!;
  engine.main.decide('crash-trigger', { evalId: candidate.evalId, kind: 'accept', title: 'crash work', scope: 'fixture', reason: 'requested', acknowledgement: 'accepted once' });
  store.afterCommit(() => { if (phase === 'after') process.exit(52); });
  if (phase === 'before') process.exit(51);
});
if (phase!.startsWith('report-')) {
  const ticket = store.tickets.list()[0]!;
  const launch = store.effects.claim('launch', ticket.assignments[0]!.id, 'crash-driver', now, 30_000)!;
  const token = engine.completeLaunch(launch)!;
  store.atomic(() => {
    engine.worker.report(token, { state: 'waiting', summary: 'crash-persisted report' });
    store.afterCommit(() => { if (phase === 'report-after') process.exit(54); });
    if (phase === 'report-before') process.exit(53);
  });
}
throw new Error('crash boundary was not reached');
