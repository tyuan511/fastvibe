// SPDX-License-Identifier: MIT
import { writeFileSync } from 'node:fs';
import { ShadowDriver } from '../../src/main/bot/shadow/driver.ts';
import { openShadowStore } from '../../src/main/bot/shadow/store.ts';
const [file, journal, mode] = process.argv.slice(2);
if (!file || !journal || !['before-launch', 'after-launch'].includes(mode!)) throw new Error('Invalid crash fixture arguments');
const store = openShadowStore(file);
const driver = new ShadowDriver(store, { now: () => 1000, leaseMs: 1000, intervalMs: false,
  policy: () => ({ version: 'v1', paused: false, evalTimeoutMs: 60000, gate: () => ({ admissible: true, strength: 'explicit', basis: { via: 'listed' } }), revalidate: () => true, admitsInferred: () => true }),
  scope: { scope: () => ({ listened: true, observed: false }) },
}, { assessment: async () => {}, launch: async (ticket, assignment) => {
  if (mode === 'before-launch') process.exit(81);
  writeFileSync(journal, JSON.stringify({ ticketId: ticket.id, assignmentId: assignment.id }), { flush: true }); process.exit(82);
}, release: async () => {}, source: { enabled: () => true, allowed: () => true, send: async () => 'sent' } });
driver.start(); driver.receive({ id: 'crash', source: 'fake', threads: [{ source: 'fake', id: 'chat' }], actor: { source: 'fake', id: 'person' }, human: true, at: new Date(1000).toISOString(), text: 'crash', meta: {} });
await driver.idle(); const candidate = driver.engine.main.candidate('crash')!;
driver.engine.main.decide('crash', { evalId: candidate.evalId, kind: 'accept', title: 'crash', scope: 'small', reason: 'explicit' });
await driver.idle(); throw new Error('Crash window was not reached');
