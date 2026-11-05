/**
 * SPDX-License-Identifier: MIT
 * Adapted from DSH src/policy.ts (MIT); attribution and license: ./NOTICE.md.
 * Pure authorization and assessment logic; no runtime settings or source registration.
 */
import { ADMISSION_DEFAULTS, type Admission, type AdmissionCell, type AdmissionRow } from './admission.ts'
import { key } from './ids.ts'
import type { AssessmentOutcome, Policy, SourceScope, GateResult } from './ports.ts'
import type { Mandate, PolicyEffect, Strength, Thread, Ticket, Trigger, ActorRef } from './model.ts'

export interface RuleMatch { rule_id: string; reason: string }
export interface RuleAssessment extends RuleMatch { matched: boolean }
export interface AdmissionDirection {
  implementation_requested: boolean
  target_basis: 'specified' | 'existing-standard' | 'undetermined'
  requires_design_decision: boolean
  evidence: string
}
/** Strict equivalent of the upstream direction schema followed by its intent checks. */
export function directionAllowed(value: unknown): value is AdmissionDirection {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return false
  const object = value as Record<string, unknown>
  const fields = ['implementation_requested', 'target_basis', 'requires_design_decision', 'evidence']
  if (Object.keys(object).some(field => !fields.includes(field))) return false
  return typeof object.implementation_requested === 'boolean'
    && ['specified', 'existing-standard', 'undetermined'].includes(object.target_basis as string)
    && typeof object.requires_design_decision === 'boolean'
    && typeof object.evidence === 'string' && object.evidence.trim().length >= 1 && object.evidence.trim().length <= 700
    && object.implementation_requested && object.target_basis !== 'undetermined' && !object.requires_design_decision
}
/** Only configuration consumed by this isolated domain policy, never FastVibe's runtime settings. */
export interface Allowed { id: string; name?: string }
export interface Rule { id: string; name: string; enabled: boolean; instruction: string }
export interface SourcePolicy {
  allowed: Allowed[]
  admission: Record<string, AdmissionRow>
  /** Source-specific configuration remains opaque; malformed bot lists behave as an empty list. */
  bots?: unknown
  [key: string]: unknown
}
export interface Settings {
  paused: boolean
  policy: { rules: Rule[]; sources: Record<string, SourcePolicy> }
  eval: { mode: 'off' | 'observe' | 'auto'; timeoutSeconds: number }
}
const sameName = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase()
/** Match z.array(AllowedSchema).catch([]): one invalid entry invalidates the whole list. */
function botEntries(value: unknown): Allowed[] {
  if (!Array.isArray(value)) return []
  const entries: Allowed[] = []
  for (const item of value) {
    if (typeof item !== 'object' || item === null || Array.isArray(item)) return []
    const entry = item as Record<string, unknown>
    if (Object.keys(entry).some(field => field !== 'id' && field !== 'name')
      || typeof entry.id !== 'string' || !entry.id.trim() || entry.id.trim().length > 200
      || (entry.name !== undefined && (typeof entry.name !== 'string' || entry.name.trim().length > 100))) return []
    entries.push({ id: entry.id.trim(), ...(typeof entry.name === 'string' ? { name: entry.name.trim() } : {}) })
  }
  return entries
}
export interface Assessment {
  decision: 'accept' | 'ignore' | 'unavailable'; rule_assessments: RuleAssessment[]; direction: unknown
  title: string; scope: string; reason: string; intent_evidence?: string | null; acknowledgement?: string | null; worktree_name?: string
}
/**
 * Validate an assessment against enabled rules and convert it into an engine `AssessmentOutcome`.
 * Acceptance requires a settled direction, at least one matched enabled rule, and `intent_evidence`, and accepts an
 * inferred candidate only in `auto` mode (otherwise recording it as `would_accept`).
 * @throws when `rule_assessments` does not cover every enabled rule exactly once, or an accept omits `intent_evidence`.
 */
export function assessmentOutcome(assessment: Assessment, settings: Pick<Settings, 'policy' | 'eval'>, strength: Strength): AssessmentOutcome {
  const enabled = settings.policy.rules.filter(rule => rule.enabled)
  const judged = assessment.rule_assessments
  const ids = new Set(judged.map(item => item.rule_id))
  if (judged.length !== enabled.length || ids.size !== judged.length || enabled.some(rule => !ids.has(rule.id))) {
    throw new Error('Exactly one assessment for every enabled rule is required; disabled, unknown or missing rule IDs are not allowed')
  }
  const matches = judged.filter(item => item.matched).map(({ rule_id, reason }) => ({ rule_id, reason }))
  const evidence = assessment.intent_evidence ? { intent_evidence: assessment.intent_evidence } : {}
  const audit = { matches, rule_assessments: judged, direction: assessment.direction, ...evidence }
  if (assessment.decision !== 'accept') return { kind: assessment.decision, reason: assessment.reason, audit }
  if (!directionAllowed(assessment.direction)) return { kind: 'ignore', audit, reason: { code: 'directionUnsettled' } }
  if (!matches.length) return { kind: 'ignore', audit, reason: { code: 'noRuleMatched' } }
  if (!assessment.intent_evidence) throw new Error('Acceptance requires intent_evidence')
  const { title, scope, worktree_name: name } = assessment
  if (strength === 'inferred' && settings.eval.mode !== 'auto') {
    const proposal = { title, scope, worktree_name: name }
    return { kind: 'ignore', audit: { ...audit, would_accept: true, proposal }, reason: { code: 'observed', values: { text: assessment.reason } } }
  }
  return { kind: 'accept', title, scope, reason: assessment.reason, ...(assessment.acknowledgement ? { acknowledgement: assessment.acknowledgement } : {}),
    rules: matches.map(match => match.rule_id), audit, ...(name ? { name } : {}) }
}
export const POLICY_REVISION = 'mandate-v3'
/**
 * Compute a version hash for settings that affect work authorization.
 * Changes to models, concurrency, pause state, or polling intervals do not invalidate existing decisions.
 */
export function policyVersion(settings: Settings): string {
  return key(POLICY_REVISION, JSON.stringify({ rules: settings.policy.rules, mode: settings.eval.mode, sources: settings.policy.sources }))
}
export function allowedSender(settings: Settings, actor: ActorRef): Allowed | undefined {
  return settings.policy.sources[actor.source]?.allowed.find(entry => sameName(entry.id, actor.id))
}
/** Look up `actor` in the Source's `bots` policy list (validated by the Source's kind), whose messages are admitted as inferred candidates at most. */
export function listedBot(settings: Settings, actor: ActorRef): Allowed | undefined {
  const bots = botEntries(settings.policy.sources[actor.source]?.bots ?? [])
  return bots.find(entry => sameName(entry.id, actor.id))
}
export const anyoneAllowed = (settings: Settings): boolean => Object.values(settings.policy.sources).some(part => part.allowed.length > 0)
const senderName = (entry: Allowed): string => entry.name || entry.id

/** Check whether a thread has tickets of its own (excluding context-only subscriptions). */
const participating = (thread: Thread, tickets: Ticket[]): boolean =>
  [...thread.subscriptions, ...tickets.map(ticket => ticket.id)].some(id => !thread.context?.includes(id))
const listened = (sources: SourceScope, source: string, meta: Record<string, unknown>) => sources.scope({ source, meta })

function admissionCell(allowed: boolean, addressed: boolean): AdmissionCell | undefined {
  return allowed ? addressed ? undefined : 'listedUnaddressed' : addressed ? 'unlistedAddressed' : 'unlistedUnaddressed'
}
function admissionOf(settings: Settings, source: string, row: string | undefined, cell: AdmissionCell): Admission {
  return (row === undefined ? undefined : settings.policy.sources[source]?.admission[row]?.[cell]) ?? ADMISSION_DEFAULTS[cell]
}
const STRENGTH: Readonly<Record<Admission, number>> = { ignore: 0, inferred: 1, explicit: 2 }

/** Compute how a settings change from `old` to `now` affects the authorization or matched rules of each open ticket. */
export function policyEffects(tickets: readonly Ticket[], old: Settings, now: Settings, scope: (settings: Settings) => SourceScope):
  Map<string, PolicyEffect> {
  const before = settingsPolicy(old, scope(old)), after = settingsPolicy(now, scope(now))
  const effects = new Map<string, PolicyEffect>()
  for (const ticket of tickets) {
    const rules = (ticket.mandate.basis.rules ?? []).flatMap((id): NonNullable<PolicyEffect['rules']> => {
      const was = old.policy.rules.find(rule => rule.id === id), is = now.policy.rules.find(rule => rule.id === id)
      if (!is?.enabled) return was?.enabled ? [{ id, name: was.name, change: 'disabled' }] : []
      return JSON.stringify(was) === JSON.stringify(is) ? [] : [{ id, name: is.name, change: 'changed', instruction: is.instruction }]
    })
    const effect: PolicyEffect = rules.length ? { rules } : {}
    if (before.revalidate(ticket.mandate) && !after.revalidate(ticket.mandate)) {
      // With the previous accept mode and rules, the Mandate holds unless the sender or receiving scope lost authorization.
      const asBefore = { ...now, eval: old.eval, policy: { ...now.policy, rules: old.policy.rules } }
      if (!settingsPolicy(asBefore, scope(now)).revalidate(ticket.mandate)) {
        Object.assign(effect, { requesterAllowed: false, requester: ticket.mandate.actor })
      } else if (ticket.mandate.strength === 'inferred' && old.eval.mode === 'auto' && now.eval.mode !== 'auto') effect.proactive = false
    }
    if (Object.keys(effect).length) effects.set(ticket.id, effect)
  }
  return effects
}
/** Build the active Policy for gating incoming Triggers and revalidating existing Ticket Mandates. */
export function settingsPolicy(settings: Settings, sources: SourceScope): Policy {
  const version = policyVersion(settings)
  const mode = settings.eval.mode
  /** Gate non-human triggers: only listed bots (as inferred candidates) and senderless system/CI events may pass; other bots are rejected. */
  const machineGate = (trigger: Trigger): GateResult => {
    const bot = trigger.actor.id ? listedBot(settings, trigger.actor) : undefined
    if (trigger.actor.id && !bot) return { admissible: false, reason: 'not_human' }
    const scope = listened(sources, trigger.source, trigger.meta)
    if (!scope.listened || !(trigger.addressed || scope.observed)) return { admissible: false, reason: 'not_human' }
    const recorded = { source: trigger.source, scope: trigger.meta, ...scope.row === undefined ? {} : { row: scope.row } }
    const addressed = trigger.addressed ? { addressed: trigger.addressed } : {}
    if (bot) {
      if (mode === 'off') return { admissible: false, reason: 'admission_ignored' }
      const basis = { ...recorded, via: 'bot' as const, sender: senderName(bot), ...addressed, observation: { mode } }
      return { admissible: true, strength: 'inferred', basis }
    }
    const cell = 'unlistedUnaddressed' as const
    if (admissionOf(settings, trigger.source, scope.row, cell) !== 'inferred' || mode === 'off') {
      return { admissible: false, reason: 'admission_ignored' }
    }
    return { admissible: true, strength: 'inferred', basis: { ...recorded, via: 'admission', cell, observation: { mode } } }
  }
  return {
    version, paused: settings.paused, evalTimeoutMs: settings.eval.timeoutSeconds * 1000,
    gate(trigger: Trigger, thread, tickets) {
      if (!trigger.human) return machineGate(trigger)
      const allowed = allowedSender(settings, trigger.actor)
      const scope = listened(sources, trigger.source, trigger.meta)
      const row = scope.listened ? scope.row : undefined
      const recorded = { source: trigger.source, scope: trigger.meta, ...row === undefined ? {} : { row }, ...allowed ? { sender: senderName(allowed) } : {} }
      if (allowed && trigger.addressed) return { admissible: true, strength: 'explicit', basis: { ...recorded, via: 'addressed', addressed: trigger.addressed } }
      const cell = admissionCell(!!allowed, !!trigger.addressed)!
      // Unaddressed messages only use the admission table when the Source observes all messages in that scope.
      const receivable = !!trigger.addressed || (scope.listened && scope.observed)
      const admission = receivable ? admissionOf(settings, trigger.source, row, cell) : 'ignore'
      const basis = { ...recorded, via: 'admission' as const, cell, ...trigger.addressed ? { addressed: trigger.addressed } : {} }
      // Check explicit admission cells before thread follow-ups so a thread's tickets never weaken an explicit request to a follow-up.
      if (admission === 'explicit') return { admissible: true, strength: 'explicit', basis }
      // Direct-message threads belong to one sender (no follow-up for others), and inferred follow-ups require an accept mode other than off (when off, the table decides).
      if (!(trigger.addressed === 'direct' && !allowed) && (allowed || mode !== 'off') && participating(thread, tickets)) {
        return { admissible: true, strength: allowed ? 'explicit' : 'inferred', basis: { ...recorded, via: 'followup' } }
      }
      if (admission === 'inferred' && mode !== 'off') return { admissible: true, strength: 'inferred', basis: { ...basis, observation: { mode } } }
      return { admissible: false, reason: !allowed ? 'not_a_member' : receivable && admission === 'ignore' ? 'admission_ignored' : 'no_mention' }
    },
    admitsInferred: rules => mode === 'auto' && rules.length > 0 && rules.every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id)),
    revalidate(mandate: Mandate) {
      // Revalidation rules follow docs/002 (Eval path; Resume revalidates).
      const { basis } = mandate
      const { source } = basis
      const current = source && basis.scope ? listened(sources, source, basis.scope) : undefined
      if (current && !current.listened) return false
      const rulesOn = (rules: string[] | undefined) => (rules ?? []).every(id => settings.policy.rules.some(rule => rule.enabled && rule.id === id))
      // Explicit follow-ups remain valid; inferred follow-ups require auto mode and enabled matched rules.
      if (basis.via === 'followup') return mandate.strength === 'explicit' || (mode === 'auto' && rulesOn(basis.rules))
      // A bot's candidate holds only while the bot remains on its Source's bot list and passes the observation checks below.
      if (basis.via === 'bot' && !listedBot(settings, mandate.actor)) return false
      // An admission-table Mandate holds while the sender's current cell still grants at least the original strength.
      if (basis.via === 'admission') {
        const { cell } = basis
        const listed = !!allowedSender(settings, mandate.actor)
        // A listed sender who addresses the agent is always explicit and uses no table cell.
        if (cell === 'unlistedAddressed' && listed) return true
        // A sender added to the allowed list since acceptance moves to the listed cell, and still undergoes observation checks below.
        const now = cell === 'unlistedUnaddressed' && listed ? 'listedUnaddressed' : cell
        if (now === 'listedUnaddressed' && !listed) return false
        const admission = admissionOf(settings, source ?? '', current?.listened ? current.row : undefined, now)
        if (STRENGTH[admission] < STRENGTH[mandate.strength]) return false
        if (mandate.strength === 'explicit') return true
      } else if (basis.via !== 'bot' && !allowedSender(settings, mandate.actor)) return false
      // Observed/inferred Mandates hold only while auto mode is active and all matched rules remain enabled.
      if ((basis.via === 'admission' || basis.via === 'listed' || basis.via === 'bot') && basis.observation) return mode === 'auto' && rulesOn(basis.rules)
      return true
    },
  }
}
