import { test } from 'node:test'
import assert from 'node:assert/strict'
import { ADMISSION_DEFAULTS, ADMISSION_OPTIONS, type AdmissionCell, type AdmissionRow } from '../src/main/bot/core/admission.ts'
import { assessmentOutcome, directionAllowed, settingsPolicy, policyVersion, policyEffects, allowedSender, listedBot, anyoneAllowed,
  type Assessment, type Settings } from '../src/main/bot/core/policy.ts'
import type { GateResult, SourceScope } from '../src/main/bot/core/ports.ts'
import type { Mandate, MandateBasis, Thread, Ticket, Trigger } from '../src/main/bot/core/model.ts'

const config = (mode: Settings['eval']['mode'] = 'auto'): Settings => ({
  paused: false,
  policy: {
    rules: [
      { id: 'copy', name: 'Copy', enabled: true, instruction: 'Correct copy' },
      { id: 'visual', name: 'Visual', enabled: true, instruction: 'Restore spacing' },
      { id: 'disabled', name: 'Disabled', enabled: false, instruction: 'Do not use' },
    ],
    sources: { github: { allowed: [{ id: 'Alice', name: 'Alice A' }], bots: [{ id: 'build-bot', name: 'Builder' }], admission: {} } },
  },
  eval: { mode, timeoutSeconds: 120 },
})
const receiving = (observed = true): SourceScope => ({ scope: ({ meta }) => meta.closed
  ? { listened: false, reason: 'closed' } : { listened: true, observed, row: 'repo' } })
const event = (patch: Partial<Trigger> = {}): Trigger => ({ id: 'event', source: 'github', actor: { source: 'github', id: 'Alice' },
  human: true, at: '2026-01-01T00:00:00Z', text: 'Fix typo', threads: [{ source: 'github', id: 'issue' }], meta: {}, ...patch })
const thread = (patch: Partial<Thread> = {}): Thread => ({ key: 'github:issue', ref: { source: 'github', id: 'issue' },
  createdAt: '2026-01-01T00:00:00Z', subscriptions: [], correlated: [], pending: [], meta: {}, ...patch })
const mandate = (basis: MandateBasis, strength: Mandate['strength'] = 'inferred', id = 'Alice'): Mandate => ({
  actor: { source: 'github', id }, basis, strength, policyVersion: 'old', scope: 'typo only',
})
const ticket = (authorization: Mandate, id = 'ticket'): Ticket => ({ id, title: 'Copy', decisionId: 'decision', mandate: authorization,
  channels: [], assignments: [], inputs: [], undelivered: [], createdAt: '', updatedAt: '', origin: { triggerId: 'event', triggerIds: ['event'] } })
const admitted = (result: GateResult) => { assert.equal(result.admissible, true); return result }
const direction = { implementation_requested: true, target_basis: 'specified', requires_design_decision: false, evidence: 'Please fix the typo' }
const assessment = (patch: Partial<Assessment> = {}): Assessment => ({ decision: 'accept', title: 'Fix typo', scope: 'One label', reason: 'Requested',
  direction, rule_assessments: [{ rule_id: 'copy', matched: true, reason: 'Typo' }, { rule_id: 'visual', matched: false, reason: 'No layout change' }],
  intent_evidence: 'Please fix the typo', ...patch })

test('admission constants expose exactly three cells and exclude explicit unaddressed messages', () => {
  assert.deepEqual(ADMISSION_DEFAULTS, { listedUnaddressed: 'inferred', unlistedAddressed: 'ignore', unlistedUnaddressed: 'ignore' })
  assert.deepEqual(ADMISSION_OPTIONS.listedUnaddressed, ['inferred', 'ignore'])
  assert.deepEqual(ADMISSION_OPTIONS.unlistedAddressed, ['explicit', 'inferred', 'ignore'])
  assert.deepEqual(ADMISSION_OPTIONS.unlistedUnaddressed, ['inferred', 'ignore'])
})

for (const mode of ['off', 'observe', 'auto'] as const) {
  for (const cell of Object.keys(ADMISSION_OPTIONS) as AdmissionCell[]) {
    for (const admission of ADMISSION_OPTIONS[cell]) {
      test(`gate matrix ${mode}/${cell}/${admission}`, () => {
        const settings = config(mode)
        settings.policy.sources.github.admission.repo = { [cell]: admission } as AdmissionRow
        const input = event({ actor: { source: 'github', id: cell === 'listedUnaddressed' ? 'ALICE' : 'stranger' },
          ...(cell === 'unlistedAddressed' ? { addressed: 'mention' as const } : {}) })
        const result = settingsPolicy(settings, receiving()).gate(input, thread(), [])
        const expected = admission === 'explicit' || (admission === 'inferred' && mode !== 'off')
        assert.equal(result.admissible, expected)
        if (expected) {
          const pass = admitted(result)
          assert.equal(pass.strength, admission)
          assert.equal(pass.basis.via, 'admission')
          assert.equal(pass.basis.source, 'github')
          assert.equal(pass.basis.row, 'repo')
          assert.deepEqual(pass.basis.scope, input.meta)
          assert.equal(pass.basis.via === 'admission' && pass.basis.cell, cell)
          if (admission === 'inferred') assert.deepEqual(pass.basis.via === 'admission' && pass.basis.observation, { mode })
        }
      })
    }
  }
  test(`listed addressed is explicit in ${mode}, independent of observation and admission table`, () => {
    const policy = settingsPolicy(config(mode), receiving(false))
    for (const addressed of ['mention', 'direct'] as const) {
      const pass = admitted(policy.gate(event({ addressed }), thread(), []))
      assert.equal(pass.strength, 'explicit')
      assert.equal(pass.basis.via, 'addressed')
      assert.equal(pass.basis.sender, 'Alice A')
    }
  })
}

test('receiving scope, defaults, actor source identity and timeout/pause retain upstream boundaries', () => {
  const settings = config()
  settings.paused = true
  const policy = settingsPolicy(settings, receiving(false))
  assert.equal(policy.paused, true)
  assert.equal(policy.evalTimeoutMs, 120000)
  assert.deepEqual(policy.gate(event(), thread(), []), { admissible: false, reason: 'no_mention' })
  assert.equal(settingsPolicy(settings, receiving()).gate(event(), thread(), []).admissible, true)
  assert.deepEqual(settingsPolicy(settings, receiving()).gate(event({ actor: { source: 'other', id: 'Alice' } }), thread(), []),
    { admissible: false, reason: 'not_a_member' })
  assert.equal(allowedSender(settings, { source: 'github', id: 'aLiCe' })?.name, 'Alice A')
  assert.equal(anyoneAllowed(settings), true)
  settings.policy.sources.github.allowed = []
  assert.equal(anyoneAllowed(settings), false)
})

test('followups exclude context-only subscriptions, preserve explicit table priority and direct sender isolation', () => {
  const settings = config('observe')
  const policy = settingsPolicy(settings, receiving())
  const subscribed = thread({ subscriptions: ['ticket'] })
  assert.equal(admitted(policy.gate(event(), subscribed, [])).basis.via, 'followup')
  assert.equal(admitted(policy.gate(event({ actor: { source: 'github', id: 'stranger' } }), subscribed, [])).strength, 'inferred')
  assert.equal(policy.gate(event({ addressed: 'direct', actor: { source: 'github', id: 'stranger' } }), subscribed, []).admissible, false)
  assert.equal(admitted(policy.gate(event(), thread({ subscriptions: ['ticket'], context: ['ticket'] }), [])).basis.via, 'admission')
  assert.equal(admitted(policy.gate(event(), thread(), [ticket(mandate({ via: 'followup' }))])).basis.via, 'followup')
  settings.policy.sources.github.admission.repo = { unlistedAddressed: 'explicit' }
  const pass = admitted(settingsPolicy(settings, receiving()).gate(event({ addressed: 'mention', actor: { source: 'github', id: 'stranger' } }), subscribed, []))
  assert.equal(pass.strength, 'explicit')
  assert.equal(pass.basis.via, 'admission')
  assert.equal(settingsPolicy(config('off'), receiving()).gate(event({ actor: { source: 'github', id: 'stranger' } }), subscribed, []).admissible, false)
  assert.equal(admitted(settingsPolicy(config('off'), receiving()).gate(event(), subscribed, [])).strength, 'explicit')
})

for (const mode of ['off', 'observe', 'auto'] as const) {
  test(`bots and senderless CI ${mode}`, () => {
    const settings = config(mode)
    const bot = event({ human: false, actor: { source: 'github', id: 'BUILD-BOT' }, addressed: 'mention' })
    const policy = settingsPolicy(settings, receiving())
    const result = policy.gate(bot, thread(), [])
    assert.equal(result.admissible, mode !== 'off')
    if (result.admissible) { assert.equal(result.strength, 'inferred'); assert.equal(result.basis.via, 'bot'); assert.equal(result.basis.sender, 'Builder') }
    assert.deepEqual(policy.gate(event({ human: false }), thread({ subscriptions: ['ticket'] }), []), { admissible: false, reason: 'not_human' })
    assert.equal(policy.gate({ ...bot, meta: { closed: true } }, thread(), []).admissible, false)
    assert.equal(settingsPolicy(settings, receiving(false)).gate({ ...bot, addressed: undefined }, thread(), []).admissible, false)
    const ci = event({ human: false, actor: { source: 'github', id: '' }, addressed: 'mention' })
    assert.equal(policy.gate(ci, thread(), []).admissible, false)
    settings.policy.sources.github.admission.repo = { unlistedUnaddressed: 'inferred' }
    const ciResult = settingsPolicy(settings, receiving()).gate(ci, thread(), [])
    assert.equal(ciResult.admissible, mode !== 'off')
    if (ciResult.admissible) {
      assert.equal(ciResult.strength, 'inferred')
      assert.equal(ciResult.basis.via === 'admission' && ciResult.basis.cell, 'unlistedUnaddressed')
      assert.equal('addressed' in ciResult.basis, false)
    }
  })
}

test('bot list strict validation and trimming match upstream all-or-empty fallback', () => {
  const settings = config()
  for (const bots of [null, {}, [{ id: 'build-bot', extra: true }], [{ id: 'build-bot' }, { id: ' ' }], [{ id: 'x'.repeat(201) }], [{ id: 'build-bot', name: 1 }]]) {
    settings.policy.sources.github.bots = bots
    assert.equal(listedBot(settings, { source: 'github', id: 'build-bot' }), undefined)
  }
  settings.policy.sources.github.bots = [{ id: ' BUILD-BOT ', name: ' Builder ' }]
  assert.deepEqual(listedBot(settings, { source: 'github', id: 'build-bot' }), { id: 'BUILD-BOT', name: 'Builder' })
})

test('mandate revalidation preserves source scope, authorization strength, rules and mode', () => {
  const settings = config()
  const source = { source: 'github', scope: {}, row: 'repo', rules: ['copy'] }
  const policy = settingsPolicy(settings, receiving())
  assert.equal(policy.revalidate(mandate({ ...source, via: 'addressed', addressed: 'mention' }, 'explicit')), true)
  assert.equal(policy.revalidate(mandate({ ...source, scope: { closed: true }, via: 'followup' }, 'explicit')), false)
  assert.equal(policy.revalidate(mandate({ ...source, via: 'addressed', addressed: 'mention' }, 'explicit', 'stranger')), false)
  assert.equal(policy.revalidate(mandate({ ...source, via: 'followup' }, 'explicit', 'stranger')), true)
  assert.equal(policy.revalidate(mandate({ ...source, via: 'followup' })), true)
  assert.equal(settingsPolicy(config('observe'), receiving()).revalidate(mandate({ ...source, via: 'followup' })), false)
  assert.equal(policy.revalidate(mandate({ ...source, rules: ['disabled'], via: 'followup' })), false)
  assert.equal(policy.revalidate(mandate({ ...source, via: 'bot', observation: { mode: 'auto' } }, 'inferred', 'build-bot')), true)
  assert.equal(policy.revalidate(mandate({ ...source, via: 'bot', observation: { mode: 'auto' } }, 'inferred', 'unknown')), false)
  assert.equal(settingsPolicy(config('off'), receiving()).revalidate(mandate({ ...source, via: 'listed', observation: { mode: 'auto' } })), false)
  assert.equal(policy.revalidate(mandate({ ...source, via: 'listed' }, 'explicit')), true)
  assert.equal(policy.admitsInferred(['copy', 'visual']), true)
  for (const ids of [[], ['disabled'], ['unknown'], ['copy', 'unknown']]) assert.equal(policy.admitsInferred(ids), false)
})

test('admission mandates revalidate current rows, membership migrations and original strength', () => {
  const settings = config()
  settings.policy.sources.github.admission.repo = { listedUnaddressed: 'inferred', unlistedAddressed: 'explicit', unlistedUnaddressed: 'inferred' }
  const basis = { source: 'github', scope: {}, row: 'old-row', rules: ['copy'], via: 'admission' as const, observation: { mode: 'auto' as const } }
  const policy = settingsPolicy(settings, receiving())
  assert.equal(policy.revalidate(mandate({ ...basis, cell: 'unlistedUnaddressed' }, 'inferred', 'stranger')), true)
  assert.equal(policy.revalidate(mandate({ ...basis, cell: 'unlistedUnaddressed' })), true)
  assert.equal(policy.revalidate(mandate({ ...basis, cell: 'listedUnaddressed' }, 'inferred', 'stranger')), false)
  assert.equal(policy.revalidate(mandate({ ...basis, cell: 'unlistedAddressed' }, 'explicit', 'stranger')), true)
  settings.policy.sources.github.admission.repo.unlistedAddressed = 'inferred'
  assert.equal(settingsPolicy(settings, receiving()).revalidate(mandate({ ...basis, cell: 'unlistedAddressed' }, 'explicit', 'stranger')), false)
  assert.equal(settingsPolicy(config('off'), receiving()).revalidate(mandate({ ...basis, cell: 'unlistedAddressed' }, 'explicit')), true)
  settings.policy.sources.github.admission.repo.listedUnaddressed = 'ignore'
  assert.equal(settingsPolicy(settings, receiving()).revalidate(mandate({ ...basis, cell: 'unlistedUnaddressed' })), false)
})

test('policy version includes authorization only; effects distinguish requester, proactive mode and rule changes', () => {
  const old = config()
  const now = structuredClone(old)
  now.paused = true
  now.eval.timeoutSeconds = 42
  assert.equal(policyVersion(old), policyVersion(now))
  for (const mutate of [
    (s: Settings) => { s.eval.mode = 'observe' },
    (s: Settings) => { s.policy.rules[0].instruction = 'Changed instruction' },
    (s: Settings) => { s.policy.sources.github.allowed = [] },
  ]) { const changed = structuredClone(old); mutate(changed); assert.notEqual(policyVersion(old), policyVersion(changed)) }
  const authorization = mandate({ source: 'github', scope: {}, via: 'admission', cell: 'listedUnaddressed', rules: ['copy'], observation: { mode: 'auto' } })
  const tickets = [ticket(authorization)]
  assert.equal(policyEffects(tickets, old, now, () => receiving()).size, 0)
  now.eval.mode = 'observe'
  assert.deepEqual(policyEffects(tickets, old, now, () => receiving()).get('ticket'), { proactive: false })
  now.policy.sources.github.allowed = []
  assert.deepEqual(policyEffects(tickets, old, now, () => receiving()).get('ticket'), { requesterAllowed: false, requester: authorization.actor })
  const rules = structuredClone(old)
  rules.policy.rules[0].instruction = 'New instruction'
  assert.deepEqual(policyEffects(tickets, old, rules, () => receiving()).get('ticket'), { rules: [{ id: 'copy', name: 'Copy', change: 'changed', instruction: 'New instruction' }] })
  rules.policy.rules[0].enabled = false
  assert.deepEqual(policyEffects(tickets, old, rules, () => receiving()).get('ticket'), { rules: [{ id: 'copy', name: 'Copy', change: 'disabled' }] })
  assert.deepEqual(policyEffects(tickets, old, now, s => s === old ? receiving() : { scope: () => ({ listened: false, reason: 'removed' }) }).get('ticket'),
    { requesterAllowed: false, requester: authorization.actor })
})

test('direction validation checks strict object shape, intent, settled target and evidence bounds', () => {
  for (const target_basis of ['specified', 'existing-standard']) assert.equal(directionAllowed({ ...direction, target_basis }), true)
  assert.equal(directionAllowed({ ...direction, evidence: ` ${'x'.repeat(700)} ` }), true)
  for (const invalid of [null, [], 'yes', {}, { ...direction, extra: true }, { ...direction, implementation_requested: false },
    { ...direction, implementation_requested: 'true' }, { ...direction, target_basis: 'undetermined' }, { ...direction, target_basis: 'other' },
    { ...direction, requires_design_decision: true }, { ...direction, requires_design_decision: 0 }, { ...direction, evidence: ' ' },
    { ...direction, evidence: null }, { ...direction, evidence: 'x'.repeat(701) }]) assert.equal(directionAllowed(invalid), false, JSON.stringify(invalid))
})

test('assessment requires exactly one judgement per enabled rule for every decision', () => {
  const valid = assessment().rule_assessments
  for (const decision of ['accept', 'ignore', 'unavailable'] as const) {
    for (const judged of [[], valid.slice(0, 1), [valid[0], valid[0]], [...valid, { rule_id: 'disabled', matched: false, reason: 'Disabled' }],
      [valid[0], { rule_id: 'unknown', matched: false, reason: 'Unknown' }]]) {
      assert.throws(() => assessmentOutcome(assessment({ decision, rule_assessments: judged }), config(), 'explicit'), /Exactly one assessment/)
    }
  }
  assert.equal(assessmentOutcome(assessment({ rule_assessments: [...valid].reverse() }), config(), 'explicit').kind, 'accept')
})

test('assessment preserves direction/no-match/intent validation order and audit for nonaccept decisions', () => {
  for (const decision of ['ignore', 'unavailable'] as const) {
    const result = assessmentOutcome(assessment({ decision, direction: null, intent_evidence: null }), config(), 'explicit')
    assert.equal(result.kind, decision)
    assert.equal(result.reason, 'Requested')
    assert.deepEqual(result.audit?.matches, [{ rule_id: 'copy', reason: 'Typo' }])
    assert.equal(result.audit?.direction, null)
  }
  assert.deepEqual(assessmentOutcome(assessment({ direction: null, intent_evidence: null }), config(), 'explicit').reason, { code: 'directionUnsettled' })
  const unmatched = assessment().rule_assessments.map(item => ({ ...item, matched: false }))
  assert.deepEqual(assessmentOutcome(assessment({ rule_assessments: unmatched, intent_evidence: null }), config(), 'explicit').reason, { code: 'noRuleMatched' })
  for (const intent_evidence of [null, undefined, '']) assert.throws(() => assessmentOutcome(assessment({ intent_evidence }), config(), 'explicit'), /Acceptance requires intent_evidence/)
  const emptyRules = config(); emptyRules.policy.rules = []
  assert.deepEqual(assessmentOutcome(assessment({ rule_assessments: [] }), emptyRules, 'explicit').reason, { code: 'noRuleMatched' })
})

for (const mode of ['off', 'observe', 'auto'] as const) {
  for (const strength of ['explicit', 'inferred'] as const) {
    test(`assessment ${strength}/${mode} records acceptance or observe-only proposal`, () => {
      const result = assessmentOutcome(assessment({ acknowledgement: 'On it', worktree_name: 'copy-fix' }), config(mode), strength)
      if (strength === 'inferred' && mode !== 'auto') {
        assert.equal(result.kind, 'ignore')
        assert.deepEqual(result.reason, { code: 'observed', values: { text: 'Requested' } })
        assert.equal(result.audit?.would_accept, true)
        assert.deepEqual(result.audit?.proposal, { title: 'Fix typo', scope: 'One label', worktree_name: 'copy-fix' })
      } else {
        assert.equal(result.kind, 'accept')
        if (result.kind !== 'accept') throw new Error('Expected acceptance')
        assert.equal(result.acknowledgement, 'On it')
        assert.equal(result.name, 'copy-fix')
        assert.deepEqual(result.rules, ['copy'])
      }
      assert.equal(result.audit?.intent_evidence, 'Please fix the typo')
      assert.deepEqual(result.audit?.rule_assessments, assessment().rule_assessments)
    })
  }
}
