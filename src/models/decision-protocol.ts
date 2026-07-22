import { isDeepStrictEqual } from 'node:util'
import {
  companionDecisionV2Schema,
  type CompanionDecisionV2,
  type ContextPackageV2,
  type DecisionEffectV2,
  type EmbodiedIntentEffect,
} from './contracts.js'

export interface NormalizedDecisionProposal {
  sourceProtocol: 'mineintent.decision.v2'
  runId: string
  context: CompanionDecisionV2['context']
  summary: string
  effects: DecisionEffectV2[]
}

export class DecisionProtocolError extends Error {
  constructor(readonly code: string, message: string) {
    super(message)
  }
}

export class DecisionProtocolDispatcher {
  parse(raw: unknown, context: ContextPackageV2): CompanionDecisionV2 {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new DecisionProtocolError('invalid_json_shape', 'Decision must be a JSON object')
    }
    if ((raw as Record<string, unknown>).protocol !== 'mineintent.decision.v2') {
      throw new DecisionProtocolError('unsupported_protocol', 'Only mineintent.decision.v2 is accepted')
    }
    const parsed = companionDecisionV2Schema.safeParse(raw)
    if (!parsed.success) throw new DecisionProtocolError('schema_invalid', parsed.error.message)
    const decision = parsed.data
    if (decision.runId !== context.ref.runId || !isDeepStrictEqual(decision.context, context.ref)) {
      throw new DecisionProtocolError('context_mismatch', 'Decision does not bind to the supplied context reference')
    }
    validateEffects(decision.effects, context)
    return decision
  }

  normalize(decision: CompanionDecisionV2, context: ContextPackageV2): NormalizedDecisionProposal {
    if (decision.runId !== context.ref.runId || !isDeepStrictEqual(decision.context, context.ref)) {
      throw new DecisionProtocolError('context_mismatch', 'Decision became detached from its context')
    }
    return {
      sourceProtocol: 'mineintent.decision.v2',
      runId: decision.runId,
      context: structuredClone(decision.context),
      summary: decision.summary,
      effects: structuredClone(decision.effects),
    }
  }
}

function validateEffects(effects: readonly DecisionEffectV2[], context: ContextPackageV2): void {
  const ids = new Set<string>()
  for (const effect of effects) {
    if (ids.has(effect.id)) fail('duplicate_effect_id', `Duplicate effect id ${effect.id}`)
    ids.add(effect.id)
  }

  requireMaximum(effects, 'activity', 1)
  requireMaximum(effects, 'intent', 1)
  requireMaximum(effects, 'embodied_intent', 1)
  requireMaximum(effects, 'next_attention', 1)
  requireMaximum(effects, 'speech', 4)
  requireMaximum(effects, 'memory_candidate', 4)

  const embodiedIds = new Set(effects.filter(effect => effect.kind === 'embodied_intent').map(effect => effect.id))
  const knownEvidenceIds = collectEvidenceIds(context)
  const knownContextRefs = collectContextRefs(context)
  const messageTextByEvent = collectMessageText(context)

  for (const effect of effects) {
    if (effect.kind === 'speech') validateSpeech(effect, embodiedIds)
    if (effect.kind === 'activity') {
      const creating = effect.operation === 'propose'
      if (creating && (effect.activityId !== undefined || effect.expectedRevision !== undefined)) {
        fail('invalid_activity_transition', 'A proposed activity cannot claim a runtime id or revision')
      }
      if (!creating && (!effect.activityId || effect.expectedRevision === undefined)) {
        fail('invalid_activity_transition', `${effect.operation} requires activityId and expectedRevision`)
      }
      validateEvidence(effect.evidenceEventIds, knownEvidenceIds, 'activity')
    }
    if (effect.kind === 'intent') {
      const creating = effect.operation === 'set'
      if (creating && (effect.intentId !== undefined || effect.expectedRevision !== undefined)) {
        fail('invalid_intent_transition', 'A new intent cannot claim a runtime id or revision')
      }
      if (!creating && (!effect.intentId || effect.expectedRevision === undefined)) {
        fail('invalid_intent_transition', `${effect.operation} requires intentId and expectedRevision`)
      }
      if (effect.operation !== 'clear' && !effect.summary) {
        fail('invalid_intent_transition', `${effect.operation} requires a summary`)
      }
    }
    if (effect.kind === 'embodied_intent') {
      validateEmbodiedIntent(effect, knownContextRefs, messageTextByEvent)
    }
    if (effect.kind === 'memory_candidate') {
      validateEvidence(effect.evidenceEventIds, knownEvidenceIds, 'memory candidate')
    }
    if (effect.kind === 'next_attention') {
      for (const id of effect.embodiedIntentIds ?? []) {
        if (!embodiedIds.has(id)) fail('invalid_effect_reference', `Attention references unknown embodied intent ${id}`)
      }
      if (effect.earliestProactiveAt && effect.expiresAt && effect.earliestProactiveAt > effect.expiresAt) {
        fail('invalid_attention_window', 'Attention proactive time must not be after its expiry')
      }
    }
  }
}

function validateSpeech(
  effect: Extract<DecisionEffectV2, { kind: 'speech' }>,
  embodiedIds: ReadonlySet<string>,
): void {
  const dependencies = effect.dependsOn ?? []
  if (effect.timing === 'now') {
    if (dependencies.length > 0 || effect.terminalCondition !== undefined) {
      fail('invalid_speech_dependency', 'Immediate speech cannot depend on embodied execution')
    }
    return
  }
  if (dependencies.length === 0 || dependencies.some(id => !embodiedIds.has(id))) {
    fail('invalid_speech_dependency', `${effect.timing} speech must depend only on an embodied intent in this decision`)
  }
  if (effect.timing === 'after_intent_accepted' && effect.terminalCondition !== undefined) {
    fail('invalid_speech_dependency', 'Accepted speech cannot declare a terminal condition')
  }
  if (effect.timing === 'after_intent_terminal' && effect.terminalCondition === undefined) {
    fail('invalid_speech_dependency', 'Terminal speech requires a terminal condition')
  }
}

function validateEmbodiedIntent(
  effect: EmbodiedIntentEffect,
  knownContextRefs: ReadonlySet<string>,
  messageTextByEvent: ReadonlyMap<string, string>,
): void {
  const roles = new Set<string>()
  for (const referent of effect.referents) {
    if (roles.has(referent.role)) fail('duplicate_referent_role', `Duplicate referent role ${referent.role}`)
    roles.add(referent.role)
    if (referent.selection.kind === 'context_ref') {
      if (!knownContextRefs.has(referent.selection.ref)) {
        fail('invalid_context_ref', `Context reference ${referent.selection.ref} was not issued in this context`)
      }
    } else {
      const message = messageTextByEvent.get(referent.selection.eventId)
      if (!message || !message.includes(referent.selection.expression)) {
        fail('invalid_message_referent', `Message referent ${referent.role} is not present in its claimed event`)
      }
    }
  }

  const stateIds = new Set<string>()
  const usedRoles = new Set<string>()
  const pending: Array<{ node: EmbodiedIntentEffect['semanticGoal']['objective']; depth: number }> = [
    { node: effect.semanticGoal.objective, depth: 1 },
  ]
  while (pending.length > 0) {
    const current = pending.pop()!
    if (current.depth > 8) fail('semantic_goal_too_deep', 'Semantic goal nesting exceeds eight levels')
    if (current.node.kind === 'state') {
      const state = current.node.state
      if (stateIds.has(state.id)) fail('duplicate_state_id', `Duplicate semantic state id ${state.id}`)
      stateIds.add(state.id)
      if (stateIds.size > 32) fail('semantic_goal_too_large', 'Semantic goal contains more than 32 states')
      for (const term of Object.values(state.arguments)) {
        if (term.kind === 'referent_role') usedRoles.add(term.role)
      }
    } else {
      for (const goal of current.node.goals) pending.push({ node: goal, depth: current.depth + 1 })
    }
  }
  for (const guidance of effect.semanticGoal.methodGuidance) {
    const guidanceRoles = new Set<string>()
    for (const role of guidance.referentRoles) {
      if (guidanceRoles.has(role)) fail('duplicate_guidance_role', `Method guidance repeats role ${role}`)
      guidanceRoles.add(role)
      usedRoles.add(role)
    }
  }
  for (const role of usedRoles) {
    if (!roles.has(role)) fail('undeclared_referent_role', `Semantic goal uses undeclared referent role ${role}`)
  }
  for (const role of roles) {
    if (!usedRoles.has(role)) fail('unused_referent_role', `Referent role ${role} is not used by the semantic goal`)
  }
}

function collectEvidenceIds(context: ContextPackageV2): Set<string> {
  const result = new Set(context.trigger.eventIds)
  for (const fragment of context.fragments) for (const id of fragment.source.ids) result.add(id)
  return result
}

function collectContextRefs(context: ContextPackageV2): Set<string> {
  const refs = new Set<string>()
  const pending: unknown[] = context.fragments.map(fragment => fragment.content)
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) pending.push(...value)
    else if (value && typeof value === 'object') {
      for (const [key, child] of Object.entries(value)) {
        if (key === 'ref' && typeof child === 'string') refs.add(child)
        pending.push(child)
      }
    }
  }
  return refs
}

function collectMessageText(context: ContextPackageV2): Map<string, string> {
  const messages = new Map<string, string>()
  const pending: unknown[] = context.fragments
    .filter(fragment => fragment.section === 'trigger_events')
    .map(fragment => fragment.content)
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) pending.push(...value)
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      if (typeof object.id === 'string' && typeof object.text === 'string') messages.set(object.id, object.text)
      pending.push(...Object.values(object))
    }
  }
  return messages
}

function validateEvidence(ids: readonly string[], known: ReadonlySet<string>, subject: string): void {
  for (const id of ids) if (!known.has(id)) fail('invalid_evidence_reference', `${subject} references unknown evidence ${id}`)
}

function requireMaximum(effects: readonly DecisionEffectV2[], kind: DecisionEffectV2['kind'], maximum: number): void {
  if (effects.filter(effect => effect.kind === kind).length > maximum) {
    fail('effect_limit_exceeded', `Decision contains too many ${kind} effects`)
  }
}

function fail(code: string, message: string): never {
  throw new DecisionProtocolError(code, message)
}
