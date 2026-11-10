// SPDX-License-Identifier: MIT
// Ported from dsh-superagent/repo tests/stage.spec.ts
// at 8c32a9dc5d72c033816c6a8110b37f40cf94fba4.
// Copyright (c) 2026 DeepSeek Harness Team. See ../src/main/bot/core/LICENSE.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { canRetry, ticketStage, type Assignment, type ReportState, type Ticket, type TicketStage } from '../src/main/bot/core/index.ts';

const assignment = (overrides: Partial<Assignment> = {}): Assignment => ({ id: 'a', state: 'running', createdAt: '', ...overrides });
const reported = (state: ReportState, overrides: Partial<Assignment> = {}) => assignment({ report: { state, summary: '', at: '' }, ...overrides });
const ticket = (overrides: Partial<Ticket> = {}): Ticket => ({ id: 't', title: 'x', decisionId: 'd', mandate: { strength: 'explicit', policyVersion: 'v', basis: { via: 'listed' }, actor: { source: 'feishu', id: 'ou' }, scope: '' },
  channels: [], assignments: [assignment()], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'x', triggerIds: ['x'] }, ...overrides });
const attention = { id: 'q', question: '?' };
/** A person's message that reached the Ticket after its report. */
const answered = { inputs: [{ id: 'i', kind: 'trigger' as const, triggerId: 'e', at: 'later', human: true as const }] };
const reportedAt = (state: ReportState) => reported(state, { report: { state, summary: '', at: 'earlier' } });
const ended = { at: '', by: 'executor' as const, reason: 'closed', outcome: 'closed' as const };

// The rows of the upstream docs/003 table, in order; the first matching row wins.
describe('ticketStage', () => {
  const cases: [string, Ticket, TicketStage][] = [
    ['an undelivered Input', ticket({ delivery: { error: 'offline', at: '' } }), { stage: 'person', action: 'delivery' }],
    ['delivery before answer and review', ticket({ delivery: { error: 'offline', at: '' }, attention, assignments: [reported('ready')] }), { stage: 'person', action: 'delivery' }],
    ['an Attention', ticket({ attention }), { stage: 'person', action: 'answer' }],
    ['answer before review', ticket({ attention, assignments: [reported('ready')] }), { stage: 'person', action: 'answer' }],
    ['answer before a failure', ticket({ attention, assignments: [reported('failed')] }), { stage: 'person', action: 'answer' }],
    ['a ready Report', ticket({ assignments: [reported('ready')] }), { stage: 'person', action: 'review' }],
    ['a ready Report of an ended Assignment', ticket({ assignments: [reported('ready', { state: 'ended' })] }), { stage: 'person', action: 'review' }],
    ['a blocked Report', ticket({ assignments: [reported('blocked')] }), { stage: 'person', action: 'blocked' }],
    ['a failed Report', ticket({ assignments: [reported('failed')] }), { stage: 'person', action: 'failed' }],
    ['a blocked Report a person answered since', ticket({ ...answered, assignments: [reportedAt('blocked')] }), { stage: 'working' }],
    ['no Assignment', ticket({ assignments: [] }), { stage: 'working', action: 'queued' }],
    ['a pending Assignment', ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] }), { stage: 'working', action: 'queued' }],
    ['a waiting Report', ticket({ assignments: [reported('waiting')] }), { stage: 'idle' }],
    ['an ended Assignment', ticket({ assignments: [assignment({ state: 'ended' })] }), { stage: 'idle' }],
    ['a running Assignment', ticket(), { stage: 'working' }],
    ['a progress Report', ticket({ assignments: [reported('progress')] }), { stage: 'working' }],
    ['an ended Ticket', ticket({ ended, attention, assignments: [reported('failed')] }), { stage: 'ended' }],
  ];
  for (const [name, value, stage] of cases) it(name, () => assert.deepStrictEqual(ticketStage(value), stage));
});

describe('canRetry', () => {
  const cases: [string, boolean, Ticket][] = [
    ['a failed open Ticket', true, ticket({ assignments: [reported('failed')] })],
    ['a blocked open Ticket', true, ticket({ assignments: [reported('blocked')] })],
    ['a failed Ticket that also awaits an answer', true, ticket({ attention, assignments: [reported('failed')] })],
    ['a blocked Ticket whose Input is undelivered', true, ticket({ delivery: { error: 'offline', at: '' }, assignments: [reported('blocked')] })],
    ['a failed Ticket that ended', false, ticket({ ended, assignments: [reported('failed')] })],
    ['a Ticket retried already, whose new Assignment is pending', false, ticket({ assignments: [reported('failed', { state: 'ended' }), assignment({ state: 'pending' })] })],
    ['a ready Ticket', false, ticket({ assignments: [reported('ready')] })],
    ['a running Ticket', false, ticket()],
    ['a Ticket without an Assignment', false, ticket({ assignments: [] })],
    // A new Assignment would only interrupt a worker that already received the person's message.
    ['a failed Ticket a person answered since', false, ticket({ ...answered, assignments: [reportedAt('failed')] })],
    ['a failed Ticket whose delivery of a person\'s answer failed', true, ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] })],
    ['a working Ticket whose Input could not be delivered', true, ticket({ delivery: { error: 'offline', at: '' } })],
    ['an ended Ticket whose Input could not be delivered', false, ticket({ ended, delivery: { error: 'offline', at: '' } })],
  ];
  for (const [name, expected, value] of cases) it(`${name}: ${expected}`, () => assert.strictEqual(canRetry(value), expected));
  it('offers a retry in each person stage a new Assignment remedies', () => {
    const delivery = ticket({ ...answered, delivery: { error: 'offline', at: '' }, assignments: [reportedAt('failed')] });
    assert.deepStrictEqual(ticketStage(delivery), { stage: 'person', action: 'delivery' });
    assert.strictEqual(canRetry(delivery), true);
  });
});
