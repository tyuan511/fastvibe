// SPDX-License-Identifier: MIT
// Ported from dsh-superagent/repo tests/core-engine.spec.ts
// at 8c32a9dc5d72c033816c6a8110b37f40cf94fba4.
// Copyright (c) 2026 DeepSeek Harness Team. See ../src/main/bot/core/LICENSE.
// Only the test runner, mock inspection and assertion syntax are adapted.
// The same upstream cases can also verify M2's SQLite repository via
// FASTVIBE_VIVI_TEST_REPOSITORY=sqlite; every database is isolated in memory.
import assert from 'node:assert/strict';
import { afterEach, describe, it, mock } from 'node:test';
import { openShadowStore, type ShadowStore } from '../src/main/bot/shadow/store.ts';
import { assertMatches, assertContains, assertProperty, assertThrows, assertCallCount, assertCall, resetCalls, subset, any, anything, arrayContaining, stringContaining } from './fixtures/vivi-test.ts';
import { Engine, MemoryRepositories, UserError, followupOwners, key, runningAssignment, ticketOutcome, ticketStage, waitsForPerson } from "../src/main/bot/core/index.ts";
import type { Assessor, Assignment, Candidate, EngineOptions, Executor, OutboundMessage, Outcome, Policy, Ticket, Trigger } from "../src/main/bot/core/index.ts";
const stores = new Set<ShadowStore>();
afterEach(() => { for (const store of stores) store.close(); stores.clear(); });
const member = { source: 'chat', id: 'alice' };
const guest = { source: 'chat', id: 'guest' };
function trigger(id: string, overrides: Partial<Trigger> = {}): Trigger {
    return { id, source: 'chat', threads: [{ source: 'chat', id: 't1' }], actor: member, human: true, at: `2026-09-23T00:00:${id.padStart(2, '0')}Z`, text: `message ${id}`, channel: { source: 'chat', thread: 't1', address: { message: id } }, meta: {}, ...overrides };
}
interface Hooks {
    emit?: (event: {
        type: string;
        data: Record<string, unknown>;
    }) => void;
    prepareTicket?: EngineOptions['prepareTicket'];
}
function harness(policyOverrides: Partial<Policy> = {}, { emit, prepareTicket }: Hooks = {}) {
    const repo = process.env.FASTVIBE_VIVI_TEST_REPOSITORY === 'sqlite' ? openShadowStore() : new MemoryRepositories();
    if ('close' in repo) stores.add(repo);
    const outbox: OutboundMessage[] = [];
    const withdrawn: string[] = [];
    const requests: Candidate[] = [];
    const assessor: Assessor = { request: mock.fn(candidate => { requests.push(candidate); }), release: mock.fn((_evalId: string) => {}) };
    const launches: [
        Ticket,
        Assignment
    ][] = [];
    const deliveries = new Set<string>();
    /** Inputs the Executor handed to a running assignment, as [ticket id, input id]. */
    const delivered: [
        string,
        string
    ][] = [];
    const executor: Executor = {
        start: mock.fn((ticket, assignment) => { launches.push([ticket, assignment]); }), deliver: mock.fn(ticket => { deliveries.add(ticket.id); }), stop: mock.fn(),
    };
    let version = 'v1', paused = false;
    const policy: Policy = {
        get version() { return version; }, get paused() { return paused; }, evalTimeoutMs: 60000,
        gate: (t, thread) => !t.human ? { admissible: false, reason: 'not human' } : t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } } : thread.subscriptions.length ? { admissible: true, strength: 'inferred', basis: { via: 'followup' } } : { admissible: false, reason: 'not a member' },
        revalidate: () => version !== 'revoked',
        admitsInferred: rules => rules.length > 0,
        ...policyOverrides,
    };
    let clock = 0;
    const scope: EngineOptions['scope'] = { scope: t => t.meta.blocked ? { listened: false, reason: 'chat not allowed' } : { listened: true, observed: false } };
    const queued: EngineOptions['outbox'] = {
        send: message => { if (!outbox.some(item => item.id === message.id))
            outbox.push(message); },
        status: id => outbox.some(item => item.id === id) ? 'pending' : undefined,
        withdraw: id => { withdrawn.push(id); },
    };
    const engine = new Engine({ repo, scope, policy: () => policy, assessor, executor, outbox: queued,
        ...emit ? { emit } : {}, ...prepareTicket ? { prepareTicket } : {}, now: () => new Date(Date.UTC(2026, 8, 23, 0, 0, clock)).toISOString() });
    /** Simulate the executor starting queued assignments (unless `launch` is false) and delivering pending ticket inputs. */
    function settle({ launch = true } = {}) {
        for (;;) {
            const next = launch ? launches.shift() : undefined;
            if (next) {
                engine.assignmentStarted(next[0].id, next[1].id);
                continue;
            }
            const [ticketId] = deliveries;
            if (ticketId === undefined)
                return;
            deliveries.delete(ticketId);
            const ticket = repo.tickets.get(ticketId)!;
            const assignment = runningAssignment(ticket);
            if (ticket.ended || !assignment)
                continue;
            for (const inputId of ticket.undelivered) {
                delivered.push([ticketId, inputId]);
                engine.inputsDelivered(ticketId, assignment.id, [inputId]);
            }
        }
    }
    const pump = () => { engine.evaluateDue(); settle(); };
    /** Simulate the worker's Session taking the delivered Trigger Inputs it has not yet read into a step. */
    const read = (ticketId: string) => engine.inputsRead(ticketId, repo.tickets.get(ticketId)!.inputs.flatMap(input => input.kind === 'trigger' && input.readAt === null ? [input.id] : []));
    const decide = (candidate: Candidate, outcome: Outcome) => engine.decide(candidate.triggers[0]!.id, { ...outcome, evalId: candidate.evalId });
    return { repo, engine, outbox, withdrawn, requests, assessor, executor, delivered, settle, pump, read, decide,
        setVersion: (value: string) => { version = value; }, setPaused: (value: boolean) => { paused = value; }, tick: (seconds: number) => { clock += seconds; } };
}
function accepted(h: ReturnType<typeof harness>, id = '1', thread = 't1') {
    h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }));
    h.pump();
    const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' });
    h.settle();
    return decision;
}
describe('intake', () => {
    it('stores a trigger once and records source filtering', () => {
        const h = harness();
        assert.strictEqual(h.engine.receive(trigger('1')), 'stored');
        assert.strictEqual(h.engine.receive(trigger('1')), 'duplicate');
        assert.strictEqual(h.engine.receive(trigger('2', { meta: { blocked: true } })), 'filtered');
        assertMatches(h.repo.triggers.disposition('2')?.filtered, { code: 'chat not allowed' });
        assertMatches(h.repo.threads.get('chat:t1')?.pending, ['1']);
    });
    it('records correlation for a trigger on several threads and evaluates only on the primary one', () => {
        const h = harness();
        h.engine.receive(trigger('1', { threads: [{ source: 'gh', id: 'pr-7' }, { source: 'gh', id: 'run-9' }] }));
        assertMatches(h.repo.threads.get('gh:pr-7'), { pending: ['1'], correlated: ['gh:run-9'] }, true);
        assertMatches(h.repo.threads.get('gh:run-9'), { pending: [], correlated: ['gh:pr-7'] }, true);
    });
});
describe('eval', () => {
    it('ignores at the gate without an assessor when nothing is admissible', async () => {
        const h = harness();
        h.engine.receive(trigger('1', { human: false }));
        h.pump();
        assertCallCount(h.assessor.request, 0);
        assertMatches(h.repo.decisions.byThread('chat:t1'), [subset({ kind: 'ignore', triggerIds: ['1'] })]);
        assert.notStrictEqual(h.repo.triggers.disposition('1')?.decisionId, undefined);
    });
    it('releases the assessor\'s state for every eval that ends, decided or not', async () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' });
        assertCall(h.assessor.release, [h.requests[0]!.evalId], "once");
    });
    it('serializes evals per thread and debounces triggers that arrive meanwhile', async () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        h.engine.receive(trigger('2'));
        h.engine.receive(trigger('3'));
        h.pump();
        assert.strictEqual(h.requests.length, 1);
        assertMatches(h.repo.threads.get('chat:t1')?.pending, ['2', '3']);
        h.decide(h.requests[0]!, { kind: 'ignore', reason: 'chatter' });
        h.pump();
        assertMatches(h.requests[1]!.triggers.map(t => t.id), ['2', '3']);
        assert.strictEqual(h.requests[1]!.strength, 'explicit');
    });
    it('accept creates a ticket with a mandate, subscribes the thread, queues the acknowledgement and starts an assignment', async () => {
        const h = harness();
        const decision = accepted(h);
        const ticket = h.repo.tickets.get(decision.ticketId!)!;
        assertMatches(ticket, { title: 'Fix', mandate: { strength: 'explicit', policyVersion: 'v1', basis: { via: 'listed' }, actor: member, scope: 'small' }, channels: [trigger('1').channel],
            origin: { triggerId: '1', triggerIds: ['1'] } }, true);
        assertProperty(ticket, 'ended', true);
        assertMatches(ticket.assignments, [subset({ state: 'running', startedAt: any(String) })]);
        assertMatches(h.repo.threads.get('chat:t1')?.subscriptions, [ticket.id]);
        assertMatches(h.outbox, [{ id: key('ack', '1'), channel: trigger('1').channel, text: 'ok', kind: 'acknowledgement', ticketId: ticket.id }]);
        assertCallCount(h.executor.start, 1);
    });
    it('refuses to decide an eval that a later eval replaced, and decides the later one', async () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        const first = h.requests[0]!;
        h.setVersion('v2');
        h.engine.policyChanged('v1', 'v2');
        h.pump();
        const second = h.requests[1]!;
        assertThrows(() => h.decide(first, { kind: 'ignore', reason: 'chatter' }), 'has finished or a later eval replaced it');
        assertMatches(h.decide(second, { kind: 'ignore', reason: 'chatter' }), { kind: 'ignore', evalId: second.evalId }, true);
    });
    it('records an accept with its ticket, subscriptions and acknowledgement together, or none of them', async () => {
        const h = harness({}, { prepareTicket: () => { throw new Error('No directory for the ticket'); } });
        h.engine.receive(trigger('1'));
        h.pump();
        const evalId = h.requests[0]!.evalId;
        assertThrows(() => h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested', acknowledgement: 'ok' }), 'No directory');
        assertMatches(h.repo.decisions.byThread('chat:t1'), []);
        assertMatches(h.repo.tickets.list(), []);
        assertMatches(h.repo.threads.get('chat:t1'), { evaluating: { id: evalId }, subscriptions: [] }, true);
        assertMatches(h.outbox, []);
    });
    it('records unavailable when the policy version changed during assessment', async () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        h.setVersion('v2');
        const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'x', scope: 'x', reason: 'x' });
        assert.strictEqual(decision.kind, 'unavailable');
        assertMatches(h.repo.tickets.list(), []);
    });
    it('starts every pending eval in one step, so a second pump starts none of them again', () => {
        const h = harness();
        for (const [id, thread] of [['1', 'A'], ['2', 'B']] as const)
            h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: thread }] }));
        assert.strictEqual(h.engine.evaluateDue(), undefined);
        h.engine.evaluateDue();
        assertMatches(h.requests.map(candidate => candidate.thread.key), ['chat:A', 'chat:B']);
    });
    it('counts an Eval\'s deadline from its delivery, queues its Triggers again twice when it expires, then records it unavailable', async () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        // A candidate the assessor's Session has not taken does not expire.
        h.tick(600);
        h.pump();
        assert.strictEqual(h.engine.candidate('1')?.evalId, h.requests[0]!.evalId);
        const deliver = () => { h.engine.candidateDelivered(h.requests.at(-1)!.evalId); };
        deliver();
        h.tick(59);
        h.pump();
        assert.strictEqual(h.requests.length, 1);
        // Expired, it records nothing and queues the Trigger for a fresh Eval, twice.
        h.tick(2);
        h.pump();
        assertMatches(h.repo.decisions.byThread('chat:t1'), []);
        assertCall(h.assessor.release, [h.requests[0]!.evalId], "some");
        assertMatches(h.requests.map(item => item.triggers.map(each => each.id)), [['1'], ['1']]);
        deliver();
        h.tick(61);
        h.pump();
        assert.strictEqual(h.requests.length, 3);
        // The third expiry is recorded unavailable.
        deliver();
        h.tick(61);
        h.pump();
        assertMatches(h.repo.decisions.byThread('chat:t1'), [subset({ kind: 'unavailable', reason: [{ code: 'timeout' }] })]);
        assertMatches(h.repo.threads.get('chat:t1'), { pending: [] }, true);
        assertProperty(h.repo.threads.get('chat:t1'), 'evaluating', true);
        assertProperty(h.repo.threads.get('chat:t1'), 'expired', true);
    });
});
describe('subscription fan-out', () => {
    it('delivers a person\'s later message on a subscribed thread to the live ticket as context, and not to Eval', async () => {
        const h = harness();
        const decision = accepted(h);
        const requests = h.requests.length;
        h.engine.receive(trigger('2', { actor: guest }));
        h.pump();
        const ticket = h.repo.tickets.get(decision.ticketId!)!;
        assertMatches(ticket.inputs, [subset({ kind: 'trigger', triggerId: '2' })]);
        assertMatches(ticket.undelivered, []);
        assertMatches(h.delivered, [[ticket.id, ticket.inputs[0]!.id]]);
        assertMatches(h.repo.triggers.disposition('2'), { fanout: [ticket.id], at: any(String) });
        // No Eval, so no Decision and no timeout, and the Thread's queue stays free for a new request.
        assertMatches([h.requests.length, h.repo.threads.get('chat:t1')!.pending, h.repo.decisions.byThread('chat:t1').length], [requests, [],
            1]);
        h.tick(600);
        h.engine.evaluateDue();
        assert.strictEqual(h.repo.decisions.byThread('chat:t1').length, 1);
        // A bot's message there still goes to Eval, which the gate does not admit.
        h.engine.receive(trigger('3', { human: false }));
        h.pump();
        assertMatches(h.repo.decisions.byThread('chat:t1').at(-1), { kind: 'ignore', triggerIds: ['3'] }, true);
    });
    it('keeps inputs undelivered until an assignment is running, and asks to launch one whose launch failed again', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        const decision = h.decide(h.requests[0]!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' });
        h.settle({ launch: false });
        h.engine.receive(trigger('2'));
        h.engine.evaluateDue();
        h.settle({ launch: false });
        const ticket = h.repo.tickets.get(decision.ticketId!)!;
        assert.strictEqual(ticket.undelivered.length, 1);
        assertCallCount(h.executor.deliver, 0);
        assertCallCount(h.executor.start, 2);
        h.engine.assignmentStarted(ticket.id, ticket.assignments[0]!.id);
        h.settle();
        assertMatches(h.delivered, [[ticket.id, ticket.undelivered[0]!]]);
    });
    it('does not hand a bot\'s message to an ended ticket, and still assesses it', async () => {
        const h = harness();
        const decision = accepted(h);
        h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' });
        h.engine.receive(trigger('2', { human: false }));
        h.pump();
        // The Executor reads its threads again when it resumes, so bots and CI neither wake nor queue on an ended ticket.
        assertMatches(h.repo.tickets.get(decision.ticketId!), { ended: anything(), undelivered: [] }, true);
        assertCallCount(h.executor.start, 1);
    });
    it('resumes once however often it pumps, with the resume note ahead of the message, and drops what waited when the policy no longer holds the mandate', async () => {
        const h = harness();
        const decision = accepted(h);
        h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' });
        h.setVersion('revoked');
        h.engine.receive(trigger('2', { actor: guest }));
        h.pump();
        assertMatches(h.repo.tickets.get(decision.ticketId!), { ended: anything(), undelivered: [] }, true);
        h.setVersion('v1');
        h.pump();
        assert.notStrictEqual(h.repo.tickets.get(decision.ticketId!)!.ended, undefined);
        h.engine.receive(trigger('3', { actor: guest }));
        h.pump();
        h.pump();
        const ticket = h.repo.tickets.get(decision.ticketId!)!;
        assert.strictEqual(ticket.assignments.length, 2);
        assert.strictEqual(ticket.inputs.filter(input => input.kind === 'resumed').length, 1);
    });
    it('takes delivery reports only from the assignment that still runs the open ticket', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const assignment = h.repo.tickets.get(ticketId)!.assignments[0]!.id;
        h.engine.receive(trigger('2'));
        const input = key('input', ticketId, 'trigger', '2');
        h.engine.deliveryFailed(ticketId, assignment, 'Session busy');
        assertMatches(h.repo.tickets.get(ticketId)!.delivery, { error: 'Session busy' }, true);
        h.engine.deliveryFailed(ticketId, 'another', 'other');
        h.engine.inputsDelivered(ticketId, 'another', [input]);
        assertMatches(h.repo.tickets.get(ticketId), { undelivered: [input], delivery: { error: 'Session busy' } }, true);
        h.engine.inputsDelivered(ticketId, assignment, [input]);
        assertMatches(h.repo.tickets.get(ticketId)!.undelivered, []);
        assertProperty(h.repo.tickets.get(ticketId), 'delivery', true);
        h.engine.receive(trigger('3'));
        h.engine.stopTicket(ticketId);
        h.engine.deliveryFailed(ticketId, assignment, 'late');
        assertMatches(h.repo.tickets.get(ticketId), { ended: anything(), undelivered: [] }, true);
        assertProperty(h.repo.tickets.get(ticketId), 'delivery', true);
    });
    it('unsubscribing a thread stops fan-out until a new decision subscribes it', async () => {
        const h = harness();
        const decision = accepted(h);
        assert.strictEqual(h.engine.unsubscribe('chat:t1'), true);
        h.engine.receive(trigger('2'));
        h.pump();
        assertMatches(h.repo.tickets.get(decision.ticketId!)!.inputs, []);
    });
    it('lets an Executor drop a thread attached to its ticket, keeping the thread\'s other tickets, but not its own threads', async () => {
        const events: {
            type: string;
            data: Record<string, unknown>;
        }[] = [];
        const h = harness({}, { emit: event => events.push(event) });
        const first = accepted(h).ticketId!;
        const second = accepted(h, '2', 't2').ticketId!;
        h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }));
        // A follow-up of the second ticket goes to the first only once the second's worker hands it back.
        h.engine.handback(second, '3', 'It is about the first fix');
        h.engine.attach(first, '3');
        assertMatches(h.repo.threads.get('chat:t2')!.subscriptions, [second, first]);
        h.engine.markUnrelated(first, 'chat:t2', 'about another fix');
        assertMatches(h.repo.threads.get('chat:t2')!.subscriptions, [second]);
        assertMatches(events.filter(event => event.type === 'thread.unsubscribed').map(event => event.data), [{ threadKey: 'chat:t2', ticketId: first, by: 'executor', reason: 'about another fix' }]);
        assertThrows(() => h.engine.markUnrelated(first, 'chat:t2', 'again'), new UserError('notFollowing'));
        assertThrows(() => h.engine.markUnrelated(first, 'chat:t1', 'its own'), new UserError('sourceThread'));
        h.engine.bindThread(first, { source: 'gh', id: 'pr-9' }, true);
        assertThrows(() => h.engine.markUnrelated(first, 'gh:pr-9', 'its PR'), new UserError('followedThread'));
    });
});
describe('resume and stop', () => {
    async function ended(h: ReturnType<typeof harness>, by: 'executor' | 'human') {
        const decision = accepted(h);
        if (by === 'executor')
            h.engine.report(decision.ticketId!, { state: 'ready', summary: 'done' });
        else
            h.engine.stopTicket(decision.ticketId!);
        return decision.ticketId!;
    }
    it('resumes an ended ticket on any person\'s message on its thread, under the same mandate and without a Decision', async () => {
        const h = harness();
        const ticketId = await ended(h, 'executor');
        const decisions = h.repo.decisions.byThread('chat:t1').length;
        // It resumes as the message arrives, before any Eval of it.
        h.engine.receive(trigger('2', { actor: guest }));
        assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
        h.pump();
        const ticket = h.repo.tickets.get(ticketId)!;
        assert.strictEqual(ticket.assignments.length, 2);
        assert.strictEqual(ticket.mandate.policyVersion, 'v1');
        assertMatches(ticket.inputs.map(input => input.kind), ['trigger', 'resumed']);
        assertCallCount(h.executor.start, 2);
        // The message still reaches Eval as a follow-up, but no reopen Decision is needed or possible.
        assert.strictEqual(h.repo.decisions.byThread('chat:t1').filter(decision => decision.kind !== 'ignore').length, decisions);
    });
    it('resumes an ended ticket an earlier version left with a person\'s message waiting, on the next pass', async () => {
        const h = harness();
        const ticketId = await ended(h, 'executor');
        h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }));
        const stored = h.repo.tickets.get(ticketId)!;
        const input = { id: 'waiting', kind: 'trigger' as const, triggerId: '2', at: stored.updatedAt, human: true as const };
        h.repo.tickets.save({ ...stored, inputs: [...stored.inputs, input], undelivered: ['waiting'] });
        h.pump();
        assertMatches(h.repo.tickets.get(ticketId), { inputs: arrayContaining([subset({ kind: 'resumed' })]) }, true);
        assertProperty(h.repo.tickets.get(ticketId), 'ended', true);
    });
    it('resumes an ended ticket at once when a person attaches a message to it', async () => {
        const h = harness();
        const ticketId = await ended(h, 'executor');
        h.engine.receive(trigger('2', { actor: guest, threads: [{ source: 'chat', id: 'elsewhere' }] }));
        const subject = h.engine.attach(ticketId, '2');
        assertMatches(subject, { assignments: [anything(), subset({ state: 'pending' })] }, true);
        assertProperty(subject, 'ended', true);
    });
    it('keeps a ticket a person stopped ended: the stop withdrew its mandate', async () => {
        const h = harness();
        const ticketId = await ended(h, 'human');
        assertCallCount(h.executor.stop, 1);
        h.engine.receive(trigger('2'));
        h.pump();
        assertMatches(h.repo.tickets.get(ticketId), { ended: subset({ by: 'human' }) }, true);
        assertCallCount(h.executor.start, 1);
    });
    it('keeps a ticket ended when its mandate no longer passes the current policy', async () => {
        const h = harness();
        const ticketId = await ended(h, 'executor');
        h.setVersion('revoked');
        h.engine.receive(trigger('2'));
        h.pump();
        assert.notStrictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
    });
    it('stops a live ticket only on an explicit instruction and ends it by the human', async () => {
        const h = harness();
        const decision = accepted(h);
        // Follow-ups that reached the ticket: the gate judges them when the main Session acts on one, a guest's as inferred.
        h.engine.receive(trigger('2', { actor: guest }));
        h.pump();
        assertMatches(h.engine.decide('2', { kind: 'stop', ticketId: decision.ticketId!, reason: 'x' }), { kind: 'ignore',
            strength: 'inferred', reason: [{ code: 'stopNotExplicit' }] }, true);
        h.engine.receive(trigger('3'));
        h.pump();
        assert.strictEqual(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'human said stop' }).kind, 'stop');
        assertMatches(h.repo.tickets.get(decision.ticketId!), { ended: subset({ by: 'human' }) }, true);
        assertCallCount(h.executor.stop, 1);
    });
});
describe('follow-ups', () => {
    it('takes a follow-up an older version queued out of the queue without a Decision, and keeps one sent to Eval again', () => {
        const h = harness();
        accepted(h);
        h.engine.receive(trigger('2', { actor: guest }));
        h.engine.receive(trigger('3', { actor: guest }));
        // As an older version left them: both queued for Eval; a person sent the second there again.
        const thread = h.repo.threads.get('chat:t1')!;
        h.repo.threads.save({ ...thread, pending: ['2', '3'] });
        h.engine.reevaluate('3');
        h.pump();
        assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['3']);
        assertMatches(h.repo.threads.get('chat:t1')!.pending, []);
        assertMatches(h.repo.decisions.byThread('chat:t1').flatMap(decision => decision.triggerIds), ['1']);
    });
    it('decides a follow-up in a gate-only Eval beside the Eval its Thread has in progress, which goes on', () => {
        const h = harness();
        const decision = accepted(h);
        h.engine.receive(trigger('2', { actor: guest }));
        h.engine.reevaluate('2');
        h.pump();
        const evaluating = h.repo.threads.get('chat:t1')!.evaluating!;
        h.engine.receive(trigger('3'));
        assertMatches(h.engine.decide('3', { kind: 'stop', ticketId: decision.ticketId!, reason: 'stop it' }), { kind: 'stop',
            triggerIds: ['3'] }, true);
        assertMatches(h.repo.threads.get('chat:t1')!.evaluating, evaluating);
        assertMatches(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' }), { kind: 'ignore', triggerIds: ['2'] }, true);
    });
    it('leaves the Thread free for a later request that reaches no ticket', () => {
        const h = harness();
        const decision = accepted(h);
        h.engine.receive(trigger('2', { actor: guest }));
        h.pump();
        h.engine.stopTicket(decision.ticketId!, 'not needed');
        // The follow-up held no Eval while the ticket decided it, so the next request is assessed at once rather than after a
        // timeout, together with the follow-up, which the stop let go of before its worker took it up.
        h.engine.receive(trigger('3'));
        h.pump();
        assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['2', '3']);
    });
});
describe('hand-back', () => {
    it('queues a message that reached a ticket for a fresh Eval with the gate\'s strength, once per ticket, and keeps the subscription', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.receive(trigger('2'));
        h.engine.receive(trigger('3', { actor: guest }));
        h.pump();
        assert.strictEqual(h.engine.handback(ticketId, '2', 'A new request'), true);
        h.pump();
        assertMatches(h.requests.at(-1), { strength: 'explicit', triggers: [{ id: '2' }] }, true);
        assertMatches(h.repo.triggers.disposition('2')!.handbacks, [{ ticketId, reason: 'A new request', at: any(String) }]);
        h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'chat' });
        assertThrows(() => h.engine.handback(ticketId, '2', 'Again'), new UserError('handedBack'));
        assert.strictEqual(h.engine.handback(ticketId, '3', 'A guest asks for more'), true);
        h.pump();
        assertMatches(h.requests.at(-1), { strength: 'inferred', triggers: [{ id: '3' }] }, true);
        assertContains(h.repo.threads.get('chat:t1')!.subscriptions, ticketId, false, false);
        // Only a message that reached the ticket can go back.
        h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }));
        assertThrows(() => h.engine.handback(ticketId, '4', 'Not mine'), new UserError('notReached'));
    });
    it('queues again no message the ticket did not decide: one a person sent to Eval, a bot\'s, or one on a Thread followed for context', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' });
        h.engine.receive(trigger('2'));
        h.engine.reevaluate('2');
        h.engine.receive(trigger('3', { human: false }));
        h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] }));
        h.pump();
        for (const candidate of h.requests.slice(-2))
            h.decide(candidate, { kind: 'ignore', reason: 'chat' });
        // Each went to Eval without the ticket, and its Decision stands.
        for (const id of ['2', '3', '4'])
            assert.strictEqual(h.engine.handback(ticketId, id, 'Not this ticket'), false);
        assertMatches([h.repo.threads.get('chat:t1')!.pending, h.repo.threads.get('chat:issue')!.pending], [[], []]);
        // The hand-back is recorded all the same, so the main Session does not attach the message back.
        assertMatches(h.repo.triggers.disposition('4')!.handbacks, [{ ticketId, reason: 'Not this ticket', at: any(String) }]);
        assertThrows(() => h.engine.attach(ticketId, '4'), new UserError('handedBackHere'));
    });
    it('leaves a message the main Session attached to a ticket to its worker, whose hand-back sends it to Eval', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] }));
        h.pump();
        h.engine.attach(ticketId, '2');
        h.settle();
        // Routed to the ticket, it is not new work as well.
        assertThrows(() => h.engine.decide('2', { kind: 'accept', title: 'Y', scope: 'small', reason: 'requested' }), new UserError('workerDecides', { tickets: ticketId }));
        assert.strictEqual(h.engine.handback(ticketId, '2', 'Asks for another change'), true);
        assertMatches(h.repo.threads.get('chat:x')!.pending, ['2']);
    });
});
describe('context threads and notes', () => {
    it('fans a Thread followed for context out to the live ticket, resumes no ended ticket from it, unless it was attached', async () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        assert.strictEqual(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' }), true);
        assert.strictEqual(h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' }), false);
        h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'issue' }] }));
        h.settle();
        assertMatches(h.repo.tickets.get(ticketId)!.inputs.map(input => input.kind === 'trigger' && input.triggerId), ['2']);
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 'issue' }] }));
        assert.notStrictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
        // Attached by the main Session, the Thread is the ticket's own, and a person's later message there resumes it.
        h.engine.attach(ticketId, '3');
        h.settle();
        assertMatches(h.repo.threads.get('chat:issue'), { context: [] }, true);
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        assert.notStrictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
        h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'issue' }] }));
        assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
    });
    it('counts a message on a Thread a ticket follows only for context as none of its follow-ups, and lifts no block with it', () => {
        const h = harness();
        const owner = accepted(h).ticketId!;
        const follower = accepted(h, '2', 'other').ticketId!;
        h.engine.followForContext(follower, { source: 'chat', id: 't1' });
        h.engine.receive(trigger('3', { actor: guest }));
        h.pump();
        assertMatches(h.repo.triggers.disposition('3'), { fanout: [owner, follower], context: [follower] }, true);
        assertMatches(h.repo.tickets.get(follower)!.inputs.at(-1), { triggerId: '3', context: true }, true);
        // On the follower's own Thread no longer: a message reaching only it goes to Eval, with the guest's that the stopped owner
        // let go of.
        h.engine.stopTicket(owner, 'done');
        h.engine.report(follower, { state: 'blocked', summary: 'needs a decision' });
        h.engine.receive(trigger('4'));
        h.pump();
        assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['3', '4']);
        assert.strictEqual(waitsForPerson(h.repo.tickets.get(follower)!), true);
    });
    it('sends a message to Eval when the ticket it reached cannot resume and only a ticket following its Thread for context is left', () => {
        const h = harness();
        const owner = accepted(h).ticketId!;
        const follower = accepted(h, '2', 'other').ticketId!;
        h.engine.followForContext(follower, { source: 'chat', id: 't1' });
        h.engine.report(owner, { state: 'ready', summary: 'done' });
        h.setVersion('revoked');
        h.engine.receive(trigger('3'));
        h.setVersion('v1');
        h.pump();
        assertMatches(h.repo.triggers.disposition('3'), { fanout: [follower], context: [follower] }, true);
        assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['3']);
    });
    it('gives an open ticket\'s worker a note as an Input of its own, held like automatic Input, and refuses one for an ended ticket', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        assertMatches(h.engine.note(ticketId, 'The other ticket renamed the API').inputs.at(-1), { kind: 'note',
            text: 'The other ticket renamed the API' }, true);
        // A worker that reported blocked waits for a person: a note does not wake it.
        h.settle();
        h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' });
        const note = h.engine.note(ticketId, 'Ticket B changed the schema').inputs.at(-1)!;
        h.settle();
        assertContains(h.delivered.map(([, id]) => id), note.id, false, true);
        assertContains(h.repo.tickets.get(ticketId)!.inputs, note, true, false);
        h.engine.stopTicket(ticketId, 'done');
        assertThrows(() => h.engine.note(ticketId, 'Too late'), new UserError('ticketEnded'));
    });
});
describe('follow-up owners', () => {
    const accept = { kind: 'accept' as const, title: 'Y', scope: 'small', reason: 'requested' };
    const decides = (...tickets: string[]) => new UserError('workerDecides', { tickets: tickets.join(', ') });
    it('lets the main Session take a follow-up as new work once it stopped the ticket on it', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        // "Stop this, and do Y instead": the stop ends the ticket that decided the message, so the request is the main Session's.
        h.engine.receive(trigger('2'));
        h.settle();
        assertThrows(() => h.engine.decide('2', accept), decides(ticketId));
        assert.strictEqual(h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' }).kind, 'stop');
        // At the same moment, the accept is a Decision of its own beside the stop's.
        assertMatches(h.engine.decide('2', accept), { kind: 'accept', triggerIds: ['2'] }, true);
        assertMatches(h.repo.decisions.byThread('chat:t1').filter(item => item.triggerIds.includes('2')).map(item => item.kind), ['stop',
            'accept']);
    });
    it('sends a follow-up its worker never received to Eval when the ticket ends, by a report or a stop', () => {
        for (const end of ['report', 'stop'] as const) {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            h.engine.receive(trigger('2'));
            assert.strictEqual(h.repo.tickets.get(ticketId)!.undelivered.length, 1);
            if (end === 'report')
                h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
            else
                h.engine.stopTicket(ticketId, 'not needed');
            assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
            h.pump();
            assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['2']);
        }
    });
    it('sends a follow-up its worker got since its last report to Eval when the ticket ends, unless it acknowledged it', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'progress', summary: 'working' });
        // The worker acknowledges one of two messages, and its final report was on its way before it took up the other.
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.engine.receive(trigger('3'));
        h.settle();
        h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' });
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['3']);
        // The ticket no longer counts as having reached it, so its candidate names no ticket that gave no reason.
        assertMatches([h.repo.triggers.disposition('2')!.fanout, h.repo.triggers.disposition('3')!.fanout], [[ticketId], []]);
    });
    it('keeps a ticket open after its pull request merged while its worker is on a person\'s message it took up after its last report', () => {
        for (const taken of [true, false]) {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true);
            h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' });
            // A person asks for one more change, which the worker takes up or has not yet, and the pull request merges meanwhile.
            h.tick(1);
            h.engine.receive(trigger('2'));
            h.settle();
            if (taken)
                h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' });
            h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z');
            // One it has not taken up leaves the merge to end the ticket, and goes to Eval.
            assertMatches([h.repo.tickets.get(ticketId)!.ended?.outcome, h.repo.threads.get('chat:t1')!.pending], taken ? [undefined, []]
                : ['merged', ['2']]);
            // The worker's ready report ends it as the pull request did.
            if (taken)
                h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
            assertMatches(h.repo.tickets.get(ticketId)!.ended, { outcome: 'merged' }, true);
        }
    });
    it('gives a follow-up its ended ticket let go to that ticket again when the main Session attaches it there', () => {
        for (const resumed of [false, true]) {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            // The ticket ends before its worker took up a person's message, which goes to Eval; a later message may resume it.
            h.engine.report(ticketId, { state: 'progress', summary: 'working' });
            h.tick(1);
            h.engine.receive(trigger('2'));
            h.settle();
            h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
            if (resumed) {
                h.tick(1);
                h.engine.receive(trigger('3'));
            }
            h.pump();
            h.tick(1);
            h.engine.attach(ticketId, '2');
            h.settle();
            // Its worker gets the message again, and an ended ticket resumes for it.
            const copies = h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2');
            assertContains(h.delivered, [ticketId, copies[1]?.id], true, false);
            assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
            assertMatches(followupOwners(trigger('2'), h.repo), [ticketId]);
        }
    });
    it('wakes an ended ticket for a message attached to it that its worker read only for context or before its last report', () => {
        for (const read of ['context', 'report'] as const) {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            if (read === 'context')
                h.engine.followForContext(ticketId, { source: 'chat', id: 'issue' });
            h.tick(1);
            h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: read === 'context' ? 'issue' : 't1' }] }));
            h.settle();
            // The worker reports after reading it and drops the ticket; a person sends a follow-up it had to Eval from the panel.
            h.tick(1);
            h.engine.report(ticketId, { state: 'progress', summary: 'read it' });
            h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
            if (read === 'report')
                h.engine.reevaluate('2');
            h.pump();
            h.tick(1);
            h.engine.attach(ticketId, '2');
            h.settle();
            assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
            assertMatches(followupOwners(h.repo.triggers.get('2')!, h.repo), [ticketId]);
        }
    });
    it('counts a question the final report answers as taken up, so it does not come back as a candidate beside its answer', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.engine.report(ticketId, { state: 'ready', summary: 'It reads the config.', answers: '2' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, []);
        assertMatches(h.repo.triggers.disposition('2'), { fanout: [ticketId], acked: [ticketId] }, true);
    });
    it('sends to Eval a message attached after its Eval was unavailable, once its ticket ends without taking it up', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 'x' }] }));
        h.pump();
        h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' });
        h.tick(1);
        h.engine.attach(ticketId, '2');
        h.settle();
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        assertMatches(h.repo.threads.get('chat:x')!.pending, ['2']);
    });
    it('counts an acknowledgement an earlier version queued without recording it on the message as taking the message up', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'progress', summary: 'working' });
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.outbox.push({ id: key('ack', '2'), channel: trigger('2').channel!, text: 'On it', kind: 'acknowledgement', ticketId });
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        assertMatches([h.repo.threads.get('chat:t1')!.pending, h.repo.triggers.disposition('2')!.fanout], [[], [ticketId]]);
    });
    it('counts a message that resumed a ticket as taken up by the report that ends it again, unlike one that came later', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'ready', summary: 'done' });
        // A person's thanks resumes the ticket, and its worker takes it into a step first, a moment after its Assignment started,
        // as the Executor delivers it; a request comes while it reports that nothing is left.
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.tick(1);
        h.engine.assignmentStarted(ticketId, h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id);
        h.tick(1);
        h.settle();
        h.read(ticketId);
        h.tick(1);
        h.engine.receive(trigger('3'));
        h.settle();
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['3']);
    });
    it('sends a follow-up its ticket let go to Eval after a stop on it was refused, but not the one a stop ended it on', () => {
        // A guest's stop is refused, and the worker drops the ticket; a member's stop ends it, and the main Session, which stopped
        // it, decides the rest of the message itself.
        for (const actor of [guest, member]) {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            h.engine.receive(trigger('2', { actor }));
            h.engine.decide('2', { kind: 'stop', ticketId, reason: 'asked to stop' });
            if (actor === guest)
                h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
            assertMatches(h.repo.threads.get('chat:t1')!.pending, actor === guest ? ['2'] : []);
        }
    });
    it('sends the message a stop ended a ticket on to Eval once another ticket it reached ends without taking it up', () => {
        const h = harness();
        const stopped = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!;
        h.engine.bindThread(other, { source: 'chat', id: 't1' }, false);
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.engine.decide('2', { kind: 'stop', ticketId: stopped, reason: 'asked to stop' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, []);
        h.engine.report(other, { state: 'dropped', summary: 'nothing to do' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
    });
    it('hands the follow-ups on a thread a worker found unrelated back to Eval, with its reason', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const elsewhere = { threads: [{ source: 'chat', id: 'x' }] };
        h.engine.receive(trigger('2', elsewhere));
        h.pump();
        h.engine.attach(ticketId, '2');
        h.settle();
        h.engine.receive(trigger('3', elsewhere));
        h.settle();
        assertThrows(() => h.engine.decide('3', accept), decides(ticketId));
        // The worker finds the attached thread is not its ticket's, and answers nothing there: the message the main Session
        // attached goes back with the later one, and each candidate says why.
        h.engine.markUnrelated(ticketId, 'chat:x', 'about something else');
        assertMatches(h.repo.threads.get('chat:x')!.pending, ['2', '3']);
        assertMatches(h.repo.triggers.disposition('3')!.handbacks, [{ ticketId, reason: 'about something else', at: any(String) }]);
        h.pump();
        assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['2', '3']);
    });
    it('keeps a follow-up two tickets reached with the one that did not hand it back, and queues it once neither decides it', () => {
        const h = harness();
        const first = accepted(h).ticketId!;
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.engine.handback(first, '2', 'another change');
        h.pump();
        const second = h.decide(h.requests.at(-1)!, accept).ticketId!;
        h.settle();
        h.tick(1);
        h.engine.receive(trigger('3'));
        h.settle();
        assertMatches(h.repo.triggers.disposition('3')!.fanout, [first, second]);
        assert.strictEqual(h.engine.handback(first, '3', 'for the other ticket'), false);
        assertMatches(h.repo.threads.get('chat:t1')!.pending, []);
        // The main Session may neither take nor dismiss it while the second ticket's worker decides it.
        assertThrows(() => h.engine.decide('3', accept), decides(second));
        assertThrows(() => h.engine.decide('3', { kind: 'ignore', reason: 'chat' }), decides(second));
        assert.strictEqual(h.engine.handback(second, '3', 'neither ticket'), true);
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['3']);
    });
    it('lets an Eval an earlier version started on a follow-up decide it', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.receive(trigger('2'));
        h.settle();
        const thread = h.repo.threads.get('chat:t1')!;
        h.repo.threads.save({ ...thread, evaluating: { id: 'e-legacy', threadKey: 'chat:t1', triggerIds: ['2'], strength: 'explicit',
                actor: member, basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '2026-09-23T00:00:00Z', deadline: '2026-09-24T00:00:00Z' } });
        assertMatches(followupOwners(trigger('2'), h.repo), []);
        assertMatches(h.engine.decide('2', { kind: 'ignore', reason: 'chat', evalId: 'e-legacy' }), { kind: 'ignore',
            triggerIds: ['2'] }, true);
        assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
    });
});
describe('interrupted assignments', () => {
    it('starts an Assignment interrupted mid-work again with a note, and hands one that waits what waits for it', () => {
        const h = harness();
        const interrupted = accepted(h).ticketId!;
        const first = h.repo.tickets.get(interrupted)!.assignments[0]!;
        const waiting = accepted(h, '2', 't2').ticketId!;
        h.engine.report(waiting, { state: 'waiting', summary: 'done for now' });
        h.engine.receive(trigger('3', { threads: [{ source: 'chat', id: 't2' }] }));
        resetCalls(h.executor.start);
        resetCalls(h.executor.deliver);
        // The Executor reports each Assignment that was running; a fact about one that no longer runs is dropped.
        for (const id of [interrupted, waiting])
            h.engine.assignmentInterrupted(id, runningAssignment(h.repo.tickets.get(id)!)!.id);
        h.engine.assignmentInterrupted(interrupted, first.id);
        const ticket = h.repo.tickets.get(interrupted)!;
        assertMatches(ticket.assignments, [subset({ id: first.id, state: 'ended', endedReason: 'hostRestarted' }), subset({ state: 'pending' })]);
        assertMatches(ticket.inputs, [subset({ kind: 'text', text: stringContaining('The host restarted') })]);
        assertMatches(ticket.undelivered, [ticket.inputs[0]!.id]);
        assertCall(h.executor.start, [subset({ id: interrupted }), ticket.assignments[1]], "once");
        // A worker that waits keeps its Session and gets what waits for it.
        assert.strictEqual(h.repo.tickets.get(waiting)!.assignments.length, 1);
        assertCall(h.executor.deliver, [subset({ id: waiting }), subset({ state: 'running' })], "once");
    });
    it('starts again a worker that reported but then got a person\'s message, which it was working on', () => {
        const h = harness();
        const other = accepted(h, '2', 't2').ticketId!;
        h.engine.report(other, { state: 'waiting', summary: 'done for now' });
        h.tick(1);
        h.engine.receive(trigger('3', { actor: guest, threads: [{ source: 'chat', id: 't2' }] }));
        h.settle();
        const running = runningAssignment(h.repo.tickets.get(other)!)!;
        assert.strictEqual(running.deliveredAt! > running.report!.at, true);
        h.engine.assignmentInterrupted(other, running.id);
        assertMatches(h.repo.tickets.get(other)!.assignments.map(item => item.state), ['ended', 'pending']);
    });
});
describe('pause', () => {
    it('lets no Eval expire while processing is paused, and moves its deadline on by the pause\'s length', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        h.engine.candidateDelivered(h.requests[0]!.evalId);
        const deadline = Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline);
        h.tick(30);
        h.setPaused(true);
        h.pump();
        // Paused past the deadline, the Eval waits.
        h.tick(300);
        h.pump();
        assert.notStrictEqual(h.engine.candidate('1'), undefined);
        h.setPaused(false);
        h.pump();
        assert.strictEqual(Date.parse(h.repo.threads.get('chat:t1')!.evaluating!.deadline), deadline + 300000);
        h.tick(29);
        h.pump();
        assert.notStrictEqual(h.engine.candidate('1'), undefined);
        // Expired, it queues the Trigger again for a fresh Eval.
        h.tick(1);
        h.pump();
        assert.notStrictEqual(h.engine.candidate('1')?.evalId, h.requests[0]!.evalId);
        assertMatches(h.repo.decisions.byThread('chat:t1'), []);
    });
});
describe('policy change', () => {
    it('tells only the live tickets a change bears on how it does, and restarts in-flight evals under the new version', async () => {
        const h = harness();
        const decision = accepted(h);
        const other = accepted(h, '3', 't3').ticketId!;
        h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] }));
        h.pump();
        const effect = { rules: [{ id: 'copy', name: 'Copy', change: 'changed' as const, instruction: 'Fix typos only.' }] };
        h.setVersion('v2');
        h.engine.policyChanged('v1', 'v2', new Map([[decision.ticketId!, effect]]));
        assertMatches(h.repo.tickets.get(decision.ticketId!)!.inputs, [subset({ kind: 'policy-changed', from: 'v1', to: 'v2', effect })]);
        assertMatches(h.repo.tickets.get(other)!.inputs.filter(input => input.kind === 'policy-changed'), []);
        assertMatches(h.repo.decisions.byThread('chat:t2'), [subset({ kind: 'unavailable', reason: [{ code: 'policyChanged' }] })]);
        assertMatches(h.repo.threads.get('chat:t2')?.pending, ['2']);
        h.pump();
        assertMatches(h.requests.at(-1), { policyVersion: 'v2', triggers: [subset({ id: '2' })] }, true);
        const told = h.repo.tickets.get(decision.ticketId!)!.inputs.find(input => input.kind === 'policy-changed')!;
        assertMatches(h.delivered, [[decision.ticketId, told.id]]);
    });
    it('does not start evals while paused', async () => {
        const h = harness({ paused: true });
        h.engine.receive(trigger('1'));
        h.pump();
        assertCallCount(h.assessor.request, 0);
    });
});
describe('worker reports', () => {
    it('asks, keeps, replaces and clears the question for a person, and says which question a report replaced', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const asked = h.engine.report(ticketId, { state: 'progress', summary: 'need a call', question: 'Which color?', askedBy: '1' });
        assertMatches(asked.attention, { question: 'Which color?', triggerId: '1' }, true);
        assertMatches(h.engine.report(ticketId, { state: 'blocked', summary: 'still waiting' }).attention, asked.attention);
        assertMatches(h.withdrawn, []);
        const replaced = h.engine.report(ticketId, { state: 'progress', summary: 'other question', question: 'Which size?' });
        assertMatches(replaced.attention, { question: 'Which size?' }, true);
        assertProperty(replaced.attention, 'triggerId', true);
        // The replaced question is withdrawn from the outbox if its message has not gone out yet.
        assertMatches(h.withdrawn, [key('attention-reply', asked.attention!.id)]);
        const cleared = h.engine.report(ticketId, { state: 'progress', summary: 'answered', question: null });
        assertProperty(cleared, 'attention', true);
        assertMatches(h.withdrawn, [key('attention-reply', asked.attention!.id), key('attention-reply', replaced.attention!.id)]);
    });
    it('ends the ticket on a final report: dropped drops it, ready completes it unless it follows a Source\'s Thread that is open', () => {
        const outcome = (state: 'ready' | 'dropped' | 'failed', follows: boolean, closed = false) => {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Merge it?' });
            if (follows)
                h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false);
            if (follows)
                h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true);
            // Work resumed after both closed ends with its ready report, using the latest close outcome.
            if (closed) {
                h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'closed', '2026-09-22T00:00:00Z');
                h.engine.threadClosed({ source: 'gh', id: 'pr-10' }, 'merged', '2026-09-22T00:00:01Z');
            }
            h.engine.report(ticketId, { state, summary: 'done' });
            return h.repo.tickets.get(ticketId)!;
        };
        assertMatches(outcome('dropped', true), { ended: { by: 'executor', outcome: 'dropped' } }, true);
        assertProperty(outcome('dropped', true).ended, 'reason', true);
        assertMatches(outcome('ready', false), { ended: { outcome: 'completed' } }, true);
        assertProperty(outcome('ready', false), 'attention', true);
        assertMatches(outcome('ready', true), { follows: [{ thread: 'gh:pr-9', own: false }, { thread: 'gh:pr-10', own: true }],
            assignments: [subset({ report: subset({ state: 'ready' }) })] }, true);
        assertProperty(outcome('ready', true), 'ended', true);
        assertProperty(outcome('ready', true), 'attention', true);
        assertMatches(outcome('ready', true, true), { ended: { outcome: 'merged' } }, true);
        assertMatches(outcome('failed', false), { attention: { question: 'Merge it?' } }, true);
        assertProperty(outcome('failed', false), 'ended', true);
    });
    it('refuses a question with a result or an answer, and questions or answers that name no person\'s message of the ticket', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.receive(trigger('2', { human: false, threads: [{ source: 'chat', id: 't1' }] }));
        h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 'elsewhere' }] }));
        const report = (extra: object) => () => h.engine.report(ticketId, { state: 'progress', summary: 'x', ...extra });
        assertThrows(report({ state: 'ready', question: 'Q?' }), new UserError('questionWithResult'));
        assertThrows(report({ question: 'Q?', answers: '1' }), new UserError('questionWithResult'));
        assertThrows(report({ askedBy: '1' }), new UserError('askerWithoutQuestion'));
        assertThrows(report({ question: 'Q?', askedBy: '2' }), new UserError('notAsker'));
        assertThrows(report({ answers: '4' }), new UserError('notAnswerable'));
        assertMatches(report({ answers: '1' })(), { answers: ['1'] }, true);
    });
    it('refuses a report on an ended ticket', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.stopTicket(ticketId);
        assertThrows(() => h.engine.report(ticketId, { state: 'progress', summary: 'x' }), new UserError('ticketEnded'));
    });
});
describe('outcomes', () => {
    it('records how a ticket ended', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.stopTicket(ticketId, 'Human asked to stop');
        assertMatches(h.repo.tickets.get(ticketId)!.ended, { by: 'human', outcome: 'stopped', reason: 'Human asked to stop' }, true);
        assert.strictEqual(ticketOutcome(h.repo.tickets.get(ticketId)!), 'stopped');
        assert.strictEqual(ticketOutcome({}), undefined);
    });
});
describe('attach', () => {
    it('sends the routing note for a message the worker has, ends an Eval that holds only that message, and refuses a ticket a person stopped or the Policy no longer holds', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.receive(trigger('2', { actor: guest }));
        h.pump();
        assertMatches(h.delivered.map(([, input]) => input), [key('input', ticketId, 'trigger', '2')]);
        // The follow-up reached the ticket without an Eval, and is its worker's to judge; sent to Eval again by a person, it is judged there.
        assert.strictEqual(h.engine.candidate('2'), undefined);
        assertThrows(() => h.engine.attach(ticketId, '2'), new UserError('workerDecides', { tickets: ticketId }));
        assert.strictEqual(h.engine.reevaluate('2'), true);
        h.pump();
        assert.notStrictEqual(h.engine.candidate('2'), undefined);
        const attached = h.engine.attach(ticketId, '2', 'The guest asks for the same fix');
        h.settle();
        assertMatches(attached.inputs, [subset({ triggerId: '2' }), subset({ triggerId: '2', note: 'The guest asks for the same fix' })]);
        assertMatches(h.delivered.map(([, input]) => input), attached.inputs.map(input => input.id));
        assert.strictEqual(h.engine.candidate('2'), undefined);
        assertMatches(h.repo.decisions.byThread('chat:t1').at(-1), { kind: 'ignore', reason: [{ code: 'routed', values: { ticket: ticketId } }] }, true);
        // A note for a message that still waits for the worker goes out with it, as for one a person sent to Eval at once.
        h.engine.receive(trigger('5', { actor: guest }));
        h.engine.reevaluate('5');
        assertMatches(h.engine.attach(ticketId, '5', 'Same fix again').inputs.at(-1), { triggerId: '5', note: 'Same fix again' }, true);
        h.settle();
        h.engine.report(ticketId, { state: 'ready', summary: 'done' });
        h.setVersion('revoked');
        assertThrows(() => h.engine.attach(ticketId, '2'), new UserError('mandateRevoked'));
        h.setVersion('v1');
        const stopped = accepted(h, '3', 't3').ticketId!;
        h.engine.stopTicket(stopped);
        assertThrows(() => h.engine.attach(stopped, '2'), new UserError('ticketStopped'));
        assertThrows(() => h.engine.attach('missing', '2'), new UserError('unknownTicket'));
    });
    it('ends the batch Eval of a message attached to a ticket and assesses the rest again, leaving the message to that ticket', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!, other = accepted(h, '5', 't5').ticketId!;
        const elsewhere = { threads: [{ source: 'chat', id: 'x' }] };
        h.engine.receive(trigger('2', elsewhere));
        h.engine.receive(trigger('3', elsewhere));
        h.pump();
        h.engine.attach(ticketId, '3');
        h.pump();
        assertMatches(h.repo.decisions.byThread('chat:x'), [subset({ kind: 'unavailable', triggerIds: ['2', '3'],
                reason: [{ code: 'routed', triggerId: '3', values: { ticket: ticketId } }] })]);
        assertMatches(h.engine.candidate('2')?.triggers.map(item => item.id), ['2']);
        assertMatches(followupOwners(h.repo.triggers.get('3')!, h.repo), [ticketId]);
        assertThrows(() => h.engine.attach(other, '3'), new UserError('workerDecides', { tickets: ticketId }));
    });
    it('names missing things apart from refusals and fills in the values', () => {
        assertMatches([new UserError('unknownTicket').missing, new UserError('ticketEnded').missing], [true, false]);
        assertMatches(new UserError('notAdmissible', { reason: 'not_a_member' }), { code: 'notAdmissible', values: { reason: 'not_a_member' }, message: 'Trigger is not admissible: not_a_member' }, true);
    });
});
describe('direct decisions', () => {
    it('decides an explicit request no Eval holds in a direct Eval, refuses a proactive accept without matched rules, and accepts a Trigger once', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        const decision = h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'routed' });
        assertMatches(decision, { kind: 'accept', triggerIds: ['1'], strength: 'explicit' }, true);
        assertMatches(h.repo.threads.get('chat:t1'), { pending: [] }, true);
        assertProperty(h.repo.threads.get('chat:t1'), 'evaluating', true);
        assertMatches(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'routed' }), decision);
        // A guest's follow-up reached that ticket without an Eval: its worker decides it, and only what the worker hands back can
        // become new work, under the gate's authority, inferred.
        h.engine.receive(trigger('2', { actor: guest }));
        h.pump();
        const ticketId = decision.ticketId!;
        assertThrows(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['r1'] }), new UserError('workerDecides', { tickets: ticketId }));
        h.engine.handback(ticketId, '2', 'A different fix');
        assertThrows(() => h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'proactive' }), new UserError('notExplicit'));
        assertMatches(h.engine.decide('2', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule',
            rules: ['r1'] }), { kind: 'accept', strength: 'inferred' }, true);
        assertThrows(() => h.engine.decide('missing', { kind: 'ignore', reason: 'x' }), new UserError('unknownTrigger'));
    });
    it('accepts an inferred candidate only on rules the Policy admits, whoever names them', () => {
        const h = harness({ admitsInferred: rules => rules.includes('enabled') });
        accepted(h);
        h.engine.receive(trigger('2', { actor: guest }));
        h.engine.reevaluate('2');
        h.pump();
        const candidate = h.requests.at(-1)!;
        assertThrows(() => h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['disabled'] }), new UserError('notExplicit'));
        assertMatches(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'rule', rules: ['enabled'] }), { kind: 'accept' }, true);
    });
    it('ends the Eval of a replayed Trigger that started a ticket, and returns that ticket\'s Decision for it', () => {
        const h = harness();
        const decision = accepted(h);
        h.tick(1);
        assert.strictEqual(h.engine.reevaluate('1'), true);
        h.pump();
        assert.strictEqual(h.engine.candidate('1'), undefined);
        assertMatches(h.repo.decisions.byThread('chat:t1').at(-1), { kind: 'ignore', triggerIds: ['1'],
            reason: [{ code: 'startedTicket', triggerId: '1', values: { ticket: decision.ticketId } }] }, true);
        assertMatches(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' }), decision);
        assert.strictEqual(h.repo.tickets.list().length, 1);
        assertThrows(() => h.engine.reevaluate('missing'), new UserError('unknownTrigger'));
    });
    it('keeps a replayed Trigger that started a ticket out of the Eval of the Triggers queued with it', () => {
        const h = harness();
        const decision = accepted(h);
        h.engine.receive(trigger('2', { actor: guest }));
        h.engine.reevaluate('2');
        h.engine.reevaluate('1');
        h.pump();
        // The member's replayed request lends the guest's message no authority.
        assert.strictEqual(h.engine.candidate('1'), undefined);
        assertMatches(h.engine.candidate('2'), { strength: 'inferred', triggers: [{ id: '2' }] }, true);
        assertThrows(() => h.engine.decide('2', { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed' }), new UserError('notExplicit'));
        assertMatches(h.engine.decide('1', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'again' }), decision);
        assert.strictEqual(h.repo.tickets.list().length, 1);
    });
    it('starts a ticket from a request accepted beside a replayed one, with its own origin and acknowledgement', () => {
        const h = harness();
        const first = accepted(h);
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.engine.reevaluate('2');
        h.engine.reevaluate('1');
        h.pump();
        const second = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Other', scope: 'small', reason: 'routed', acknowledgement: 'On it' });
        assert.notStrictEqual(second.ticketId, first.ticketId);
        assertMatches(h.repo.tickets.get(second.ticketId!)!.origin, { triggerId: '2', triggerIds: ['2'] });
        assertMatches(h.outbox.find(message => message.id === key('ack', '2')), { text: 'On it', kind: 'acknowledgement' }, true);
        // The replayed request still answers with the ticket it started.
        assertMatches(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'again' }), first);
    });
});
describe('automatic input', () => {
    it('holds back automatic Input from a worker that reported blocked or failed until a person\'s message arrives', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const bot = (id: string) => trigger(id, { human: false });
        h.engine.receive(bot('2'));
        h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' });
        // Both pending and subsequent automated inputs stay queued on the ticket without waking the worker.
        h.engine.receive(bot('3'));
        h.settle();
        assertMatches(h.repo.tickets.get(ticketId), { undelivered: [], inputs: [subset({ triggerId: '2' }), subset({ triggerId: '3' })] }, true);
        assertMatches(h.delivered, []);
        h.tick(1);
        h.engine.receive(trigger('4', { actor: guest }));
        h.engine.receive(bot('5'));
        h.settle();
        assertMatches(h.delivered.map(([, input]) => input), [key('input', ticketId, 'trigger', '4'), key('input', ticketId, 'trigger', '5')]);
    });
    it('stops waiting for a person on a person\'s message, a later report that is neither blocked nor failed, or a retry', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const ticket = () => h.repo.tickets.get(ticketId)!;
        h.engine.report(ticketId, { state: 'blocked', summary: 'needs a decision' });
        assert.strictEqual(waitsForPerson(ticket()), true);
        assertMatches(ticketStage(ticket()), { stage: 'person', action: 'blocked' });
        // The worker has the person's reply, so the stale blocked report no longer holds the ticket.
        h.tick(1);
        h.engine.receive(trigger('2', { actor: guest }));
        h.settle();
        assert.strictEqual(waitsForPerson(ticket()), false);
        assertMatches(ticketStage(ticket()), { stage: 'working' });
        h.tick(1);
        h.engine.report(ticketId, { state: 'failed', summary: 'broke' });
        assert.strictEqual(waitsForPerson(ticket()), true);
        h.tick(1);
        h.engine.report(ticketId, { state: 'progress', summary: 'found a way' });
        assert.strictEqual(waitsForPerson(ticket()), false);
        h.tick(1);
        h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' });
        h.engine.retryTicket(ticketId);
        assert.strictEqual(waitsForPerson(ticket()), false);
    });
    it('launches a failed launch again for a person\'s message, but not for a Policy change', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        const ticketId = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'requested' }).ticketId!;
        h.engine.report(ticketId, { state: 'failed', summary: 'The prepare command failed' });
        resetCalls(h.executor.start);
        h.setVersion('v2');
        h.engine.policyChanged('v1', 'v2');
        assertCallCount(h.executor.start, 0);
        h.tick(1);
        h.engine.receive(trigger('2', { actor: guest }));
        assertCall(h.executor.start, [subset({ id: ticketId }), subset({ state: 'pending' })], "once");
    });
});
describe('replies', () => {
    it('acknowledges a person\'s message that reached an open ticket once, and refuses others', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        // The acknowledgement of the accept stays; a later request for one reuses it.
        assertMatches(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '1', text: 'On it' }), { id: key('ack', '1'), status: 'pending', reused: true });
        assertMatches(h.outbox.map(message => message.text), ['ok']);
        h.engine.receive(trigger('2', { actor: guest }));
        assertMatches(h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'Looking' }), { id: key('ack', '2'), status: 'pending', reused: false });
        h.engine.receive(trigger('3', { human: false }));
        assertThrows(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '3', text: 'x' }), new UserError('ackNotPerson'));
        h.engine.receive(trigger('6', { threads: [{ source: 'chat', id: 'elsewhere' }] }));
        assertThrows(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '6', text: 'x' }), new UserError('notReached'));
        h.engine.stopTicket(ticketId);
        assertThrows(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'x' }), new UserError('ackEnded'));
    });
    it('sends an answer only after the worker reported it, a result only for a ready ticket, and attention only for its current question', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const asked = trigger('2', { actor: guest, channel: { source: 'chat', thread: 't1', address: { message: '2' } } });
        h.engine.receive(asked);
        assertThrows(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' }), new UserError('noAnswer'));
        h.engine.report(ticketId, { state: 'progress', summary: 'Yes', answers: '2' });
        assertMatches(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Yes' }), { status: 'pending', reused: false }, true);
        assertMatches(h.outbox.at(-1), { channel: asked.channel, text: 'Yes', kind: 'reply' }, true);
        assertMatches(h.repo.tickets.get(ticketId)!.answers, []);
        assertThrows(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' }), new UserError('notReady'));
        h.engine.report(ticketId, { state: 'progress', summary: 'asking', question: 'Which color?', askedBy: '2' });
        assertThrows(() => h.engine.reply({ purpose: 'attention', ticketId, question: 'Which size?', text: 'x' }), new UserError('notAttention'));
        // Without an open question there is nothing to ask, whether or not a question is named.
        const quiet = accepted(h, '9', 't9').ticketId!;
        assertThrows(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, text: 'Anything to send.' }), new UserError('notAttention'));
        assertThrows(() => h.engine.reply({ purpose: 'attention', ticketId: quiet, question: '', text: 'Anything to send.' }), new UserError('notAttention'));
        const attention = h.repo.tickets.get(ticketId)!.attention!;
        assert.strictEqual(h.engine.reply({ purpose: 'attention', ticketId, question: 'Which color?', text: 'Which color?' }).id, key('attention-reply', attention.id));
        // A question goes where the message that raised it was written.
        assertMatches(h.outbox.at(-1)!.channel, asked.channel);
        h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
        assertMatches(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' }), { status: 'pending' }, true);
        assertMatches(h.outbox.at(-1)!.channel, trigger('1').channel);
    });
});
describe('ticket commands', () => {
    it('ends a ticket by the same rule on a close and on a ready report: once no PR it opened is open, as the latest of them ended', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        // It started from someone's PR and opened its own.
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-5' }, false);
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true);
        h.engine.threadClosed({ source: 'gh', id: 'pr-7' }, 'merged', '2026-09-23T00:00:00Z');
        assertMatches(h.repo.tickets.get(ticketId)!.ended, { outcome: 'merged' }, true);
        // A person's comment resumes it; its ready report ends it again as its own PR did, though the one it started from is open.
        h.tick(10);
        h.engine.receive(trigger('2', { threads: [{ source: 'gh', id: 'pr-5' }] }));
        h.settle();
        assertProperty(h.repo.tickets.get(ticketId), 'ended', true);
        h.engine.report(ticketId, { state: 'ready', summary: 'Answered' });
        assertMatches(h.repo.tickets.get(ticketId)!.ended, { outcome: 'merged' }, true);
        // The PR it started from closing later changes nothing.
        h.engine.threadClosed({ source: 'gh', id: 'pr-5' }, 'closed', '2026-09-23T00:00:30Z');
        assertMatches(h.repo.tickets.get(ticketId)!.ended, { outcome: 'merged' }, true);
        // A ticket that opened no PR ends when the one it follows closes, as it did.
        const other = accepted(h, '3', 't3').ticketId!;
        h.engine.bindThread(other, { source: 'gh', id: 'pr-8' }, false);
        h.engine.report(other, { state: 'ready', summary: 'Pushed to their branch' });
        assertProperty(h.repo.tickets.get(other), 'ended', true);
        h.engine.threadClosed({ source: 'gh', id: 'pr-8' }, 'closed', '2026-09-23T00:01:00Z');
        assertMatches(h.repo.tickets.get(other)!.ended, { outcome: 'closed' }, true);
    });
    it('stops following a Thread whose Subscription a person removes', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-7' }, true);
        assert.strictEqual(h.engine.unsubscribe('gh:pr-7'), true);
        assertProperty(h.repo.tickets.get(ticketId), 'follows', true);
        // Its ready report completes it, since it follows no Thread now.
        h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
        assertMatches(h.repo.tickets.get(ticketId)!.ended, { outcome: 'completed' }, true);
    });
    it('follows a Source\'s Threads, and ends once no Thread of its own is open, unless resumed work has not finished', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const close = (id: string, outcome: 'merged' | 'closed', at: string) => {
            const open = h.repo.tickets.open().map(ticket => ticket.id);
            h.engine.threadClosed({ source: 'gh', id }, outcome, at);
            return open.filter(item => h.repo.tickets.get(item)!.ended);
        };
        assertMatches(h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, false), { follows: [{ thread: 'gh:pr-9', own: false }] }, true);
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-10' }, true);
        assertMatches(h.repo.threads.get('gh:pr-9')!.subscriptions, [ticketId]);
        // The Thread it started from closes while its own is open: it records the close and works on.
        assertMatches(close('pr-9', 'closed', '2026-09-23T00:00:00Z'), []);
        assertMatches(h.repo.tickets.get(ticketId), { follows: [{ thread: 'gh:pr-9', closed: { outcome: 'closed' } }, { thread: 'gh:pr-10' }] }, true);
        assertProperty(h.repo.tickets.get(ticketId), 'ended', true);
        // Its own closes too: it ends as that one did, when it did, once.
        assertMatches(close('pr-10', 'merged', '2026-09-23T00:00:01Z'), [ticketId]);
        assertMatches(h.repo.tickets.get(ticketId), { ended: { by: 'executor', outcome: 'merged', at: '2026-09-23T00:00:01.000Z' } }, true);
        assertMatches(close('pr-10', 'merged', '2026-09-23T00:00:01Z'), []);
        assertThrows(() => h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-11' }, true), new UserError('ticketEnded'));
        // A ticket retried after its PR closed but before the close was reported works on until it reports ready.
        const other = accepted(h, '2', 't2').ticketId!;
        h.engine.bindThread(other, { source: 'gh', id: 'pr-12' }, true);
        h.engine.report(other, { state: 'failed', summary: 'tests fail' });
        h.tick(10);
        h.engine.retryTicket(other);
        assertMatches(close('pr-12', 'closed', '2026-09-23T00:00:05Z'), []);
        assert.strictEqual(h.repo.tickets.get(other)!.ended, undefined);
        h.engine.report(other, { state: 'ready', summary: 'done' });
        assertMatches(h.repo.tickets.get(other), { ended: { outcome: 'closed' } }, true);
    });
    it('retries a ticket that reported failed with a new Assignment, and asks only a waiting worker for its status', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        assertThrows(() => h.engine.retryTicket(ticketId), new UserError('notRetryable'));
        assert.strictEqual(h.engine.requestStatus(ticketId), false);
        assertMatches(h.repo.tickets.get(ticketId)!.inputs, []);
        h.engine.report(ticketId, { state: 'waiting', summary: 'idle' });
        assert.strictEqual(h.engine.requestStatus(ticketId), true);
        assertMatches(h.repo.tickets.get(ticketId)!.inputs, [subset({ kind: 'text', text: stringContaining('status-only') })]);
        h.engine.report(ticketId, { state: 'failed', summary: 'broke' });
        const retried = h.engine.retryTicket(ticketId);
        assertMatches(retried.assignments, [subset({ state: 'ended', endedReason: 'retried' }), subset({ state: 'pending' })]);
        assertCallCount(h.executor.stop, 1);
        assertCall(h.executor.start, [subset({ id: ticketId }), retried.assignments[1]], "last");
    });
});
describe('failed deliveries', () => {
    it('forgets a failed delivery once a new Assignment takes over or the ticket ends', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const failed = () => {
            h.engine.deliveryFailed(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id, 'Session busy');
            assertMatches(h.repo.tickets.get(ticketId)!.delivery, { error: 'Session busy' }, true);
        };
        failed();
        h.engine.report(ticketId, { state: 'blocked', summary: 'needs access' });
        h.engine.retryTicket(ticketId);
        h.settle();
        assertProperty(h.repo.tickets.get(ticketId), 'delivery', true);
        failed();
        h.engine.stopTicket(ticketId);
        assertProperty(h.repo.tickets.get(ticketId), 'delivery', true);
    });
});
describe('problems', () => {
    it('dismisses the problem an unavailable Decision shows, and only such a Decision', () => {
        const h = harness();
        const decision = accepted(h);
        assertThrows(() => h.engine.dismiss(decision.id), new UserError('unknownProblem'));
        h.engine.receive(trigger('2', { threads: [{ source: 'chat', id: 't2' }] }));
        h.pump();
        const unavailable = h.decide(h.requests.at(-1)!, { kind: 'unavailable', reason: 'model down' });
        assertMatches(h.engine.dismiss(unavailable.id), { kind: 'unavailable', dismissed: true }, true);
        assertMatches(h.repo.decisions.get(unavailable.id), { dismissed: true }, true);
    });
});
describe('retry after a failed delivery', () => {
    it('starts a new Assignment for a ticket whose Input keeps failing to reach its worker, which takes the Input', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'failed', summary: 'tests fail' });
        // A person's answer goes to the failed worker, and delivering it fails.
        h.tick(5);
        h.engine.receive(trigger('2'));
        const answered = h.repo.tickets.get(ticketId)!;
        assert.strictEqual(answered.undelivered.length, 1);
        h.engine.deliveryFailed(ticketId, runningAssignment(answered)!.id, 'Session gone');
        assertMatches(ticketStage(h.repo.tickets.get(ticketId)!), { stage: 'person', action: 'delivery' });
        const retried = h.engine.retryTicket(ticketId);
        assertMatches(retried.assignments.map(item => item.state), ['ended', 'pending']);
        assertProperty(retried, 'delivery', true);
        assert.strictEqual(retried.undelivered.length, 1);
    });
});
describe('Evals across Policy versions, revoked Mandates and mixed batches', () => {
    it('queues an Eval\'s batch again when it is decided under an older Policy, such as after an upgrade changed the version', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        const candidate = h.requests.at(-1)!;
        // An upgrade changes the version without a Policy change being reported.
        h.setVersion('v2');
        assertMatches(h.decide(candidate, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r' }), { kind: 'unavailable', reason: [{ code: 'policyChanged' }] }, true);
        assertMatches(h.repo.threads.get('chat:t1'), { pending: ['1'] }, true);
        h.pump();
        assertMatches(h.requests.at(-1), { policyVersion: 'v2', triggers: [subset({ id: '1' })] }, true);
    });
    it('queues a person\'s message for Eval when the only ticket it reached cannot resume under the Policy now, and says it reached none', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
        h.settle();
        h.setVersion('revoked');
        h.tick(5);
        h.engine.receive(trigger('2'));
        assertMatches(h.repo.tickets.get(ticketId), { undelivered: [], ended: anything() }, true);
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
        assertMatches(followupOwners(trigger('2'), h.repo), []);
    });
    it('queues a person\'s message that waited out a pause for Eval when the ticket it reached cannot resume once the pause lifts', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
        h.settle();
        h.setPaused(true);
        h.tick(5);
        h.engine.receive(trigger('2'));
        h.pump();
        assert.strictEqual(h.repo.tickets.get(ticketId)!.undelivered.length, 1);
        h.setVersion('revoked');
        h.setPaused(false);
        h.engine.evaluateDue();
        assertMatches(h.repo.tickets.get(ticketId), { undelivered: [], ended: anything() }, true);
        assert.strictEqual(h.repo.threads.get('chat:t1')!.pending.includes('2') || h.engine.candidate('2') !== undefined, true);
    });
    it('takes a new ticket\'s origin and acknowledgement from the admissible Trigger that gave its batch its strength', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.tick(1);
        h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci-bot' }, channel: { source: 'chat', thread: 'chat:t1', address: { message: 'bot' } } }));
        h.pump();
        assertMatches(h.requests.at(-1)!.triggers.map(item => item.id), ['1', '2']);
        const decision = h.decide(h.requests.at(-1)!, { kind: 'accept', title: 'Fix', scope: 'small', reason: 'r', acknowledgement: 'ok' });
        assertMatches(h.repo.tickets.get(decision.ticketId!)!.origin, { triggerId: '1', triggerIds: ['1', '2'] });
        assertMatches(h.outbox, [subset({ id: key('ack', '1'), channel: trigger('1').channel })]);
    });
});
describe('gaps', () => {
    it('takes a mixed batch\'s strength, actor and basis from its strongest admissible Trigger, the latest of equal strength', () => {
        // A guest's message is admitted as inferred, as on a Thread a ticket follows.
        const gate: Policy['gate'] = t => t.actor.id === 'alice' ? { admissible: true, strength: 'explicit', basis: { via: 'listed' } }
            : { admissible: true, strength: 'inferred', basis: { via: 'followup' } };
        for (const order of [['guest', 'alice'], ['alice', 'guest']]) {
            const h = harness({ gate });
            order.forEach((who, index) => { h.tick(1); h.engine.receive(trigger(String(10 + index), { actor: who === 'alice' ? member : guest })); });
            h.pump();
            const alice = String(10 + order.indexOf('alice'));
            assertMatches(h.repo.threads.get('chat:t1')!.evaluating, { strength: 'explicit', actor: member, basis: { via: 'listed' }, primary: alice }, true);
        }
        const named = harness({ gate: t => ({ admissible: true, strength: 'explicit', basis: { via: 'listed', sender: t.actor.id } }) });
        named.engine.receive(trigger('1', { actor: { source: 'chat', id: 'bob' } }));
        named.tick(1);
        named.engine.receive(trigger('2', { actor: { source: 'chat', id: 'carol' } }));
        named.pump();
        assertMatches(named.repo.threads.get('chat:t1')!.evaluating, { actor: { id: 'carol' }, basis: { sender: 'carol' }, primary: '2' }, true);
    });
    it('changes nothing and delivers nothing on a late start of an Assignment a retry replaced', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const first = h.repo.tickets.get(ticketId)!.assignments[0]!.id;
        h.engine.report(ticketId, { state: 'failed', summary: 'broke' });
        h.engine.retryTicket(ticketId);
        const before = h.repo.tickets.get(ticketId)!;
        const delivered = h.delivered.length;
        h.engine.assignmentStarted(ticketId, first);
        h.settle({ launch: false });
        assertMatches(h.repo.tickets.get(ticketId)!.assignments, before.assignments);
        assert.strictEqual(h.delivered.length, delivered);
    });
    it('records a stop that names an unknown or ended ticket as ignored', () => {
        const h = harness();
        const ended = accepted(h).ticketId!;
        h.engine.report(ended, { state: 'ready', summary: 'Done' });
        for (const [id, ticketId] of [['2', 'missing'], ['3', ended]] as const) {
            h.tick(1);
            h.engine.receive(trigger(id, { threads: [{ source: 'chat', id: `t${id}` }] }));
            h.pump();
            assertMatches(h.decide(h.requests.at(-1)!, { kind: 'stop', ticketId, reason: 'stop it' }), { kind: 'ignore', reason: [{ code: 'stopUnknown' }] }, true);
        }
        assertMatches(h.repo.tickets.get(ended)!.ended, { by: 'executor', outcome: 'completed' }, true);
    });
    it('refuses a direct decision on a Trigger the gate does not admit, and leaves the queue as it was', () => {
        const h = harness();
        h.engine.receive(trigger('1', { human: false }));
        const pending = h.repo.threads.get('chat:t1')!.pending;
        assertThrows(() => h.engine.decide('1', { kind: 'ignore', reason: 'noise' }), new UserError('notAdmissible', { reason: 'not human' }));
        assertMatches(h.repo.threads.get('chat:t1')!.pending, pending);
        assertMatches(h.repo.decisions.byThread('chat:t1'), []);
    });
    it('refuses to retry a ticket a person stopped after its failed report', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'failed', summary: 'broke' });
        h.engine.stopTicket(ticketId);
        assertThrows(() => h.engine.retryTicket(ticketId), new UserError('notRetryable'));
    });
    it('answers a question once, sends a result only for finished work, and the same result once', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.engine.report(ticketId, { state: 'progress', summary: 'It reads the config.', answers: '2' });
        assertMatches(h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'It reads the config.' }), { reused: false }, true);
        assertThrows(() => h.engine.reply({ purpose: 'answer', triggerId: '2', text: 'Something else.' }), new UserError('noAnswer'));
        assertThrows(() => h.engine.reply({ purpose: 'result', ticketId, text: 'Done' }), new UserError('notReady'));
        h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
        const sent = h.outbox.length;
        assertMatches(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' }), { reused: false }, true);
        assertMatches(h.engine.reply({ purpose: 'result', ticketId, text: 'Done' }), { reused: true }, true);
        assert.strictEqual(h.outbox.length, sent + 1);
        // A ticket whose PR closed unmerged, or that a person stopped, has no result to send.
        const closed = accepted(h, '5', 't5').ticketId!;
        h.engine.bindThread(closed, { source: 'gh', id: 'pr-1' }, true);
        h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'closed', '2026-09-23T00:01:00Z');
        assertThrows(() => h.engine.reply({ purpose: 'result', ticketId: closed, text: 'x' }), new UserError('notReady'));
        const stopped = accepted(h, '6', 't6').ticketId!;
        h.engine.stopTicket(stopped);
        assertThrows(() => h.engine.reply({ purpose: 'result', ticketId: stopped, text: 'x' }), new UserError('notReady'));
    });
    it('keeps an Eval\'s deadline on a repeated delivery, refuses to queue a held Trigger again, and puts expired Triggers first', () => {
        const h = harness();
        h.engine.receive(trigger('1'));
        h.pump();
        const evalId = h.requests[0]!.evalId;
        h.engine.candidateDelivered(evalId);
        const deadline = h.repo.threads.get('chat:t1')!.evaluating!.deadline;
        h.tick(30);
        h.engine.candidateDelivered(evalId);
        assert.strictEqual(h.repo.threads.get('chat:t1')!.evaluating!.deadline, deadline);
        assert.strictEqual(h.engine.reevaluate('1'), false);
        // A Trigger that arrives meanwhile queues behind the expired one, and the fresh Eval takes both in that order.
        h.tick(1);
        h.engine.receive(trigger('2', { actor: guest }));
        h.tick(30);
        h.engine.evaluateDue();
        assertMatches(h.repo.threads.get('chat:t1')!.evaluating!.triggerIds, ['1', '2']);
        assertMatches(h.repo.decisions.byThread('chat:t1'), []);
    });
});
describe('final review', () => {
    it('ignores an Eval an earlier version left holding only a Trigger that started a ticket, instead of recording it unavailable', () => {
        const h = harness();
        const decision = accepted(h);
        // An earlier version could leave an Eval holding the Trigger after it started a ticket.
        const thread = h.repo.threads.get('chat:t1')!;
        h.repo.threads.save({ ...thread, evaluating: { id: 'old-eval', threadKey: 'chat:t1', triggerIds: ['1'], primary: '1', strength: 'explicit', actor: member,
                basis: { via: 'listed' }, policyVersion: 'v1', startedAt: '', deadline: '2999-01-01T00:00:00.000Z' } });
        assertMatches(h.engine.decide('1', { kind: 'accept', title: 'Again', scope: 'small', reason: 'replayed' }), decision);
        assertMatches(h.repo.decisions.byThread('chat:t1').at(-1), { kind: 'ignore', reason: [{ code: 'startedTicket', triggerId: '1',
                    values: { ticket: decision.ticketId } }] }, true);
        assert.strictEqual(h.repo.decisions.byThread('chat:t1').some(item => item.kind === 'unavailable'), false);
        assertProperty(h.repo.threads.get('chat:t1'), 'evaluating', true);
    });
    it('clears the count of expired Evals when the gate ignores what a Thread queued', () => {
        const h = harness();
        h.engine.receive(trigger('1', { human: false }));
        h.repo.threads.save({ ...h.repo.threads.get('chat:t1')!, expired: 1 });
        h.pump();
        assertMatches(h.repo.decisions.byThread('chat:t1'), [subset({ kind: 'ignore' })]);
        assertProperty(h.repo.threads.get('chat:t1'), 'expired', true);
    });
});
describe('final review: Policy transitions', () => {
    it('tells a worker of each Policy change that bears on its ticket, also of one that repeats an earlier transition', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const effect = { requesterAllowed: false as const };
        for (const [from, to] of [['A', 'B'], ['B', 'A'], ['A', 'B']]) {
            h.tick(1);
            h.engine.policyChanged(from!, to!, new Map([[ticketId, effect]]));
        }
        assert.strictEqual(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'policy-changed').length, 3);
    });
});
describe('final review: Threads followed for context', () => {
    it('lets a worker acknowledge or ask no one on a Thread it follows only for context', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.followForContext(ticketId, { source: 'chat', id: 'side' });
        h.tick(1);
        h.engine.receive(trigger('5', { threads: [{ source: 'chat', id: 'side' }], channel: { source: 'chat', thread: 'side', address: { message: '5' } } }));
        assertThrows(() => h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '5', text: 'On it' }), new UserError('notReached'));
        assertThrows(() => h.engine.report(ticketId, { state: 'progress', summary: 'A question', question: 'Which page?', askedBy: '5' }), new UserError('notAsker'));
    });
});
describe('final review: close times', () => {
    it('records a Source\'s close time in the canonical form, and keeps the ticket\'s updatedAt moving forward', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-1' }, true);
        h.tick(30);
        const before = h.repo.tickets.get(ticketId)!.updatedAt;
        // GitHub gives whole seconds, and the PR merged before the ticket's last change.
        h.engine.threadClosed({ source: 'gh', id: 'pr-1' }, 'merged', '2026-09-23T00:00:05Z');
        const ended = h.repo.tickets.get(ticketId)!;
        assertMatches(ended.ended, { at: '2026-09-23T00:00:05.000Z', outcome: 'merged' }, true);
        assertMatches(ended.follows, [{ thread: 'gh:pr-1', own: true, closed: { at: '2026-09-23T00:00:05.000Z', outcome: 'merged' } }]);
        assert.strictEqual(ended.updatedAt >= before, true);
    });
});
describe('model-surface review', () => {
    it('resumes an ended ticket only on a person\'s message, not on a bot\'s that is attached to it', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'ready', summary: 'Done' });
        h.tick(1);
        h.engine.receive(trigger('2', { human: false, actor: { source: 'chat', id: 'ci' }, threads: [{ source: 'chat', id: 'ci' }] }));
        h.engine.attach(ticketId, '2');
        assert.notStrictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
        // A person's message resumes it, with what waited.
        h.tick(1);
        h.engine.receive(trigger('3'));
        assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
    });
});
describe('follow-up review: turn ends', () => {
    const merge = (h: ReturnType<typeof harness>) => h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z');
    it('lets a merge send to Eval only the messages its worker had no turn to read after its ready report', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true);
        h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' });
        // A person thanks the worker, which reads it in a turn and leaves it; another message comes after that turn.
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.read(ticketId);
        h.tick(1);
        h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id);
        h.tick(1);
        h.engine.receive(trigger('3'));
        h.settle();
        merge(h);
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['3']);
    });
    it('keeps a ticket open at a merge while its worker works on a message it took up, also after a progress report', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true);
        h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' });
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' });
        // It answers another question in a progress report while it works on the message.
        h.tick(1);
        h.engine.report(ticketId, { state: 'progress', summary: 'Answered the other question' });
        merge(h);
        assert.strictEqual(h.repo.tickets.get(ticketId)!.ended, undefined);
    });
    it('ends a ticket whose close it deferred as the close did when its worker then drops the work', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true);
        h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' });
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.engine.reply({ purpose: 'acknowledgement', ticketId, triggerId: '2', text: 'On it' });
        merge(h);
        h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing more to do' });
        assertMatches(h.repo.tickets.get(ticketId)!.ended, { outcome: 'merged' }, true);
    });
    it('sends a message another ticket handed back to Eval when a stop on it ends the ticket that kept it', () => {
        const h = harness();
        const first = accepted(h).ticketId!;
        const second = accepted(h, '2', 't2').ticketId!;
        h.engine.bindThread(second, { source: 'chat', id: 't1' }, false);
        h.engine.receive(trigger('3'));
        h.settle();
        assert.strictEqual(h.engine.handback(second, '3', 'It is about the first fix'), false);
        h.engine.decide('3', { kind: 'stop', ticketId: first, reason: 'asked to stop' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['3']);
    });
    it('gives a live ticket\'s worker again a message it had that a person sent to Eval and the main Session attached back', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.tick(1);
        h.engine.report(ticketId, { state: 'progress', summary: 'working' });
        h.engine.reevaluate('2');
        h.pump();
        h.engine.attach(ticketId, '2');
        assert.strictEqual(h.repo.tickets.get(ticketId)!.inputs.filter(input => input.kind === 'trigger' && input.triggerId === '2').length, 2);
    });
});
describe('follow-up review: turn ends and deliveries', () => {
    it('lets a stop send to Eval a message that waited for delivery when a turn ended, and reached the worker after', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'progress', summary: 'working' });
        h.tick(1);
        h.engine.receive(trigger('2'));
        const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id;
        const [inputId] = ticket().undelivered;
        // The turn ends while the message is on its way; it reaches the worker after, and a person stops the ticket in that turn.
        h.tick(1);
        h.engine.turnEnded(ticketId, assignmentId);
        h.tick(1);
        h.engine.inputsDelivered(ticketId, assignmentId, [inputId!]);
        h.tick(1);
        h.engine.stopTicket(ticketId, 'not needed');
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
    });
});
describe('follow-up review: delivery times', () => {
    it('lets a stop send to Eval a message that came before the worker\'s waiting report but reached the worker after it', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.tick(1);
        h.engine.receive(trigger('2'));
        const ticket = () => h.repo.tickets.get(ticketId)!, assignmentId = runningAssignment(ticket())!.id;
        const [inputId] = ticket().undelivered;
        // The Executor reports the worker waiting while the message is on its way; it reaches the worker after, and a person stops.
        h.tick(1);
        h.engine.report(ticketId, { state: 'waiting', summary: 'Waiting for input' });
        h.tick(1);
        h.engine.inputsDelivered(ticketId, assignmentId, [inputId!]);
        h.tick(1);
        h.engine.stopTicket(ticketId, 'not needed');
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
    });
});
describe('routing review', () => {
    it('records two stops of one follow-up that reached two tickets, made in the same moment, as two Decisions', () => {
        const h = harness();
        const first = accepted(h).ticketId!;
        const second = accepted(h, '2', 't2').ticketId!;
        h.engine.bindThread(second, { source: 'chat', id: 't1' }, false);
        h.engine.receive(trigger('3'));
        h.settle();
        const stops = [first, second].map(ticketId => h.engine.decide('3', { kind: 'stop', ticketId, reason: 'asked to stop' }));
        assert.strictEqual(new Set(stops.map(stop => stop.id)).size, 2);
        assertMatches(stops.map(stop => h.repo.decisions.get(stop.id)?.ticketId), [first, second]);
        assertMatches([first, second].map(id => h.repo.tickets.get(id)!.ended?.outcome), ['stopped', 'stopped']);
    });
});
describe('what a worker read', () => {
    /** A ticket that ended, resumed by a person's message `2`, whose new Assignment started; its Inputs wait for delivery. */
    function resumed() {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.report(ticketId, { state: 'ready', summary: 'done' });
        h.tick(1);
        h.engine.receive(trigger('2'));
        const assignmentId = h.repo.tickets.get(ticketId)!.assignments.at(-1)!.id;
        h.tick(1);
        h.engine.assignmentStarted(ticketId, assignmentId);
        const [note, message] = h.repo.tickets.get(ticketId)!.undelivered as [
            string,
            string
        ];
        return { h, ticketId, assignmentId, note, message, pending: () => h.repo.threads.get('chat:t1')!.pending };
    }
    it('sends to Eval a message that woke a ticket and reached its worker only after a progress report, at a dropped report', () => {
        const { h, ticketId, assignmentId, note, message, pending } = resumed();
        // Delivering the message fails at first; the worker reports progress, and the retry hands the message over while it
        // writes that nothing is left.
        h.engine.inputsDelivered(ticketId, assignmentId, [note]);
        h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy');
        h.tick(1);
        h.engine.report(ticketId, { state: 'progress', summary: 'Looking' });
        h.tick(1);
        h.engine.inputsDelivered(ticketId, assignmentId, [message]);
        h.tick(1);
        h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' });
        assertMatches(pending(), ['2']);
    });
    it('counts a message that woke a ticket as read by a later dropped report once its worker\'s Session took it into a step', () => {
        const { h, ticketId, assignmentId, note, message, pending } = resumed();
        // The Session takes it into the step its arrival starts, before the Executor records the delivery.
        h.engine.inputsRead(ticketId, [message]);
        h.engine.inputsDelivered(ticketId, assignmentId, [note, message]);
        h.tick(1);
        h.engine.report(ticketId, { state: 'progress', summary: 'Looking' });
        h.tick(1);
        h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' });
        assertMatches(pending(), []);
    });
    it('sends to Eval at a merge a message that reached the worker after its last step, which no step took before its turn ended', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.engine.bindThread(ticketId, { source: 'gh', id: 'pr-9' }, true);
        h.engine.report(ticketId, { state: 'ready', summary: 'PR ready' });
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.tick(1);
        h.engine.turnEnded(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id);
        h.engine.threadClosed({ source: 'gh', id: 'pr-9' }, 'merged', '2026-09-23T00:00:01Z');
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
    });
    it('counts a message a retry delivered after a failure and a turn end as read by a dropped report only once a step took it', () => {
        for (const taken of [false, true]) {
            const { h, ticketId, assignmentId, note, message, pending } = resumed();
            h.engine.inputsDelivered(ticketId, assignmentId, [note]);
            h.engine.deliveryFailed(ticketId, assignmentId, 'Session busy');
            h.tick(1);
            h.engine.turnEnded(ticketId, assignmentId);
            h.tick(1);
            h.engine.inputsDelivered(ticketId, assignmentId, [message]);
            if (taken)
                h.read(ticketId);
            h.tick(1);
            h.engine.report(ticketId, { state: 'dropped', summary: 'Nothing to do' });
            assertMatches(pending(), taken ? [] : ['2']);
        }
    });
    it('counts a message a step took before a restart cut its turn off as read only once the restarted worker reports', () => {
        for (const reported of [false, true]) {
            const h = harness();
            const ticketId = accepted(h).ticketId!;
            h.engine.report(ticketId, { state: 'progress', summary: 'working' });
            h.tick(1);
            h.engine.receive(trigger('2'));
            h.settle();
            h.read(ticketId);
            // The Assignment starts again with a recovery note, in the same Session, which holds the message.
            h.tick(1);
            h.engine.assignmentInterrupted(ticketId, runningAssignment(h.repo.tickets.get(ticketId)!)!.id);
            h.settle();
            if (reported) {
                h.tick(1);
                h.engine.report(ticketId, { state: 'progress', summary: 'Recovered' });
            }
            h.tick(1);
            h.engine.stopTicket(ticketId, 'not needed');
            assertMatches(h.repo.threads.get('chat:t1')!.pending, reported ? [] : ['2']);
        }
    });
});
describe('read claims review', () => {
    it('gives a retry\'s Assignment the messages the failed one had delivered but no step of its worker took', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        const ticket = () => h.repo.tickets.get(ticketId)!;
        const inputId = ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === '2')!.id;
        assertMatches(ticket().undelivered, []);
        h.tick(1);
        h.engine.report(ticketId, { state: 'failed', summary: 'The turn broke.' });
        h.tick(1);
        h.engine.retryTicket(ticketId);
        assertMatches(ticket().undelivered, [inputId]);
    });
});
describe('read claims review: retries', () => {
    it('gives a retry only what the Assignment it replaces had delivered and no step took, not what an earlier end let go of', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const ticket = () => h.repo.tickets.get(ticketId)!;
        const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id;
        // A follow-up reaches the worker, and the ticket ends before any step took it, which sends it to Eval.
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        h.tick(1);
        h.engine.report(ticketId, { state: 'dropped', summary: 'nothing to do' });
        assertMatches(h.repo.threads.get('chat:t1')!.pending, ['2']);
        // A person's message resumes the ticket; its worker reports blocked before a step took the message, and a person retries.
        h.tick(1);
        h.engine.receive(trigger('3'));
        h.settle();
        h.tick(1);
        h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' });
        h.tick(1);
        h.engine.retryTicket(ticketId);
        assertMatches(ticket().undelivered, [inputOf('3')]);
    });
});
describe('read claims review: restarts', () => {
    it('gives a restart\'s Assignment what the replaced one had delivered and no step took, and a retry of it gets it again', () => {
        const h = harness();
        const ticketId = accepted(h).ticketId!;
        const ticket = () => h.repo.tickets.get(ticketId)!;
        const inputOf = (triggerId: string) => ticket().inputs.find(input => input.kind === 'trigger' && input.triggerId === triggerId)!.id;
        h.tick(1);
        h.engine.receive(trigger('2'));
        h.settle();
        // The host restarts mid-work before a step took the message, which a cancel may have dropped: the new Assignment gets it.
        h.tick(1);
        h.engine.assignmentInterrupted(ticketId, runningAssignment(ticket())!.id);
        assert.strictEqual(ticket().undelivered[0], inputOf('2'));
        h.settle();
        // That Assignment blocks before a step took it, and a person retries: the retry's Assignment gets it too.
        h.tick(1);
        h.engine.report(ticketId, { state: 'blocked', summary: 'Which page?' });
        h.tick(1);
        h.engine.retryTicket(ticketId);
        assertMatches(ticket().undelivered, [inputOf('2')]);
    });
});
describe('ignores from the card', () => {
    const said = (text: string) => ({ code: 'said', values: { text } });
    it('marks the ignore of an inferred candidate that no assessment judged, unlike an assessed one or an explicit candidate\'s', () => {
        const h = harness();
        accepted(h);
        // A guest's message sent to Eval is an inferred candidate, which the main Session ignores from its card.
        h.engine.receive(trigger('2', { actor: guest }));
        h.engine.reevaluate('2');
        h.pump();
        assertMatches(h.requests.at(-1), { strength: 'inferred' }, true);
        assertMatches(h.engine.decide('2', { kind: 'ignore', reason: 'Plain chat.' }).reason, [{ code: 'ignoredFromCard' }, said('Plain chat.')]);
        // An assessment's ignore keeps its rule judgments, without the mark.
        h.engine.receive(trigger('3', { actor: guest }));
        h.engine.reevaluate('3');
        h.pump();
        assertMatches(h.decide(h.requests.at(-1)!, { kind: 'ignore', reason: 'Plain chat.', audit: { rule_assessments: [] } }), { reason: [said('Plain chat.')], audit: { rule_assessments: [] } }, true);
        // An explicit candidate is always routed from its card.
        h.engine.receive(trigger('4', { threads: [{ source: 'chat', id: 't9' }] }));
        h.pump();
        assertMatches(h.engine.decide('4', { kind: 'ignore', reason: 'Thanks.' }).reason, [said('Thanks.')]);
        // Accepting an inferred candidate still takes an assessment's matched rules.
        h.engine.receive(trigger('5', { actor: guest }));
        h.engine.reevaluate('5');
        h.pump();
        assertThrows(() => h.engine.decide('5', { kind: 'accept', title: 'Fix', scope: 'small', reason: 'chat' }), new UserError('notExplicit'));
    });
});
