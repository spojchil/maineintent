import {
  viewportObservationRefPayloadSchema,
  type ViewportObservationRefPayload,
} from '../information/contracts/index.js'
import type { EmbodiedIntentEffect } from '../models/index.js'
import type {
  EmbodiedGroundingResult,
  GroundedGoalExpression,
  GroundedReferent,
  GroundedSemanticGoalV1,
  GroundedSemanticTerm,
  GroundedTarget,
  GroundingInformationGap,
  GroundingRequest,
  GroundingScope,
  GroundingContextReferenceResolver,
} from './contracts.js'
import { GroundedReferentStore } from './grounded-store.js'

export class GroundingEngine {
  readonly #references: GroundingContextReferenceResolver
  readonly #store: GroundedReferentStore
  readonly #scope: () => GroundingScope

  constructor(options: {
    references: GroundingContextReferenceResolver
    store: GroundedReferentStore
    scope: () => GroundingScope
  }) {
    this.#references = options.references
    this.#store = options.store
    this.#scope = options.scope
  }

  ground(request: GroundingRequest): EmbodiedGroundingResult {
    const scope = this.#scope()
    if (request.caller.decisionRunId !== request.context.ref.runId) {
      return { status: 'invalid', effectId: request.effect.id, reasonCode: 'decision_context_mismatch' }
    }
    if (scope.worldId !== request.context.ref.worldId) {
      return { status: 'unavailable', effectId: request.effect.id, reasonCode: 'wrong_world' }
    }
    const pending: Array<{
      role: string
      validUntil: string
      evidenceIds: string[]
      target: GroundedTarget
      spatialKnowledge: GroundedReferent['spatialKnowledge']
    }> = []
    for (const referent of request.effect.referents) {
      if (referent.selection.kind === 'context_ref') {
        const provenance = findObservationReference(request.context.fragments, referent.selection.ref)
        if (!provenance || provenance.interfaceId !== 'viewport_information') {
          return { status: 'invalid', effectId: request.effect.id, reasonCode: 'context_ref_not_in_viewport_read' }
        }
        const resolved = this.#references.resolveContextReference<ViewportObservationRefPayload>(
          request.caller,
          referent.selection.ref,
          ['viewport.block', 'viewport.entity'],
        )
        if (!resolved) return { status: 'invalid', effectId: request.effect.id, reasonCode: 'stale_or_forged_context_ref' }
        const payload = viewportObservationRefPayloadSchema.safeParse(resolved.payload)
        if (!payload.success || resolved.ref.interfaceId !== provenance.interfaceId ||
            resolved.ref.connectionEpoch !== scope.epoch || resolved.ref.worldId !== scope.worldId || !resolved.ref.validUntil) {
          return { status: 'invalid', effectId: request.effect.id, reasonCode: 'invalid_context_ref_payload' }
        }
        pending.push({
          role: referent.role,
          validUntil: resolved.ref.validUntil,
          evidenceIds: [...new Set([provenance.readId, ...payload.data.evidenceIds])],
          target: payload.data.kind === 'block'
            ? { kind: 'block', name: payload.data.name, position: payload.data.position }
            : {
                kind: 'entity', entityKey: payload.data.entityKey, type: payload.data.type,
                ...(payload.data.name ? { name: payload.data.name } : {}),
                ...(payload.data.username ? { username: payload.data.username } : {}),
                position: payload.data.position,
              },
          spatialKnowledge: 'known',
        })
      } else {
        const message = findMessage(request.context.fragments, referent.selection.eventId)
        if (!message || !message.text.includes(referent.selection.expression)) {
          return { status: 'invalid', effectId: request.effect.id, reasonCode: 'message_referent_not_found' }
        }
        if (!message.sender) {
          return { status: 'needs_clarification', effectId: request.effect.id, reasonCode: 'message_speaker_unknown', ambiguousRoles: [referent.role] }
        }
        const validUntil = new Date(scope.now.getTime() + 60_000).toISOString()
        pending.push({
          role: referent.role,
          validUntil,
          evidenceIds: [referent.selection.eventId],
          target: { kind: 'identity', username: message.sender },
          spatialKnowledge: 'unknown',
        })
      }
    }

    const groundedByRole = new Map<string, GroundedReferent>()
    const issuedHandles: string[] = []
    try {
      for (const item of pending) {
        const stored = this.#store.issue({
          decisionRunId: request.caller.decisionRunId,
          effectId: request.effect.id,
          role: item.role,
          worldId: scope.worldId,
          epoch: scope.epoch,
          validUntil: item.validUntil,
          evidenceIds: item.evidenceIds,
          target: item.target,
        })
        issuedHandles.push(stored.handle)
        groundedByRole.set(item.role, toPublicReferent(stored, item.spatialKnowledge))
      }
    } catch {
      for (const handle of issuedHandles) this.#store.revoke(handle)
      return { status: 'unavailable', effectId: request.effect.id, reasonCode: 'grounded_referent_store_unavailable' }
    }

    const stateRoles = new Map<string, Set<string>>()
    const objective = groundExpression(request.effect.semanticGoal.objective, groundedByRole, stateRoles)
    if (!objective) {
      for (const handle of issuedHandles) this.#store.revoke(handle)
      return { status: 'invalid', effectId: request.effect.id, reasonCode: 'ungrounded_referent_role' }
    }
    if (request.effect.semanticGoal.methodGuidance.some(guidance =>
      guidance.referentRoles.some(role => !groundedByRole.has(role)))) {
      for (const handle of issuedHandles) this.#store.revoke(handle)
      return { status: 'invalid', effectId: request.effect.id, reasonCode: 'ungrounded_guidance_role' }
    }
    const semanticGoal: GroundedSemanticGoalV1 = {
      schema: 'mineintent.semantic-goal.v1',
      objective,
      methodGuidance: request.effect.semanticGoal.methodGuidance.map(guidance => ({
        description: guidance.description,
        groundedReferentHandles: guidance.referentRoles.map(role => groundedByRole.get(role)!.handle),
        strength: guidance.strength,
      })),
    }
    const referents = [...groundedByRole.values()]
    const missingInformation: GroundingInformationGap[] = referents
      .filter(referent => referent.spatialKnowledge === 'unknown')
      .map(referent => ({
        referentHandle: referent.handle,
        property: 'spatial_direction',
        requiredByStateIds: [...(stateRoles.get(referent.role) ?? [])],
      }))
    return {
      status: 'grounded',
      intent: {
        decisionRunId: request.caller.decisionRunId,
        effectId: request.effect.id,
        groundingStatus: missingInformation.length > 0 ? 'partial' : 'complete',
        semanticGoal,
        referents,
        missingInformation,
        constraints: structuredClone(request.effect.constraints),
      },
    }
  }
}

function findObservationReference(
  fragments: GroundingRequest['context']['fragments'],
  refId: string,
): { readId: string; interfaceId: string } | undefined {
  const matches: Array<{ readId: string; interfaceId: string }> = []
  for (const fragment of fragments) {
    if (fragment.section !== 'observations' || fragment.source.trust !== 'verified_observation' ||
        !isRecord(fragment.content)) continue
    const read = fragment.content
    if (read.protocol !== 'mineintent.information-read.v1' ||
        typeof read.readId !== 'string' || typeof read.interfaceId !== 'string' ||
        !fragment.source.ids.includes(read.readId) || !isRecord(read.values)) continue
    if (containsReference(read.values, refId)) {
      matches.push({ readId: read.readId, interfaceId: read.interfaceId })
    }
  }
  return matches.length === 1 ? matches[0] : undefined
}

function containsReference(value: unknown, refId: string): boolean {
  const pending: unknown[] = [value]
  while (pending.length > 0) {
    const current = pending.pop()
    if (Array.isArray(current)) pending.push(...current)
    else if (isRecord(current)) {
      if (current.ref === refId) return true
      pending.push(...Object.values(current))
    }
  }
  return false
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

function groundExpression(
  expression: EmbodiedIntentEffect['semanticGoal']['objective'],
  groundedByRole: ReadonlyMap<string, GroundedReferent>,
  stateRoles: Map<string, Set<string>>,
): GroundedGoalExpression | undefined {
  if (expression.kind !== 'state') {
    const goals = expression.goals.map(goal => groundExpression(goal, groundedByRole, stateRoles))
    if (goals.some(goal => !goal)) return undefined
    return { kind: expression.kind, goals: goals as GroundedGoalExpression[] }
  }
  const arguments_: Record<string, GroundedSemanticTerm> = {}
  for (const [name, term] of Object.entries(expression.state.arguments)) {
    if (term.kind === 'referent_role') {
      const grounded = groundedByRole.get(term.role)
      if (!grounded) return undefined
      arguments_[name] = { kind: 'grounded_referent', handle: grounded.handle }
      const ids = stateRoles.get(term.role) ?? new Set<string>()
      ids.add(expression.state.id)
      stateRoles.set(term.role, ids)
    } else arguments_[name] = structuredClone(term)
  }
  return { kind: 'state', state: { ...expression.state, arguments: arguments_ } }
}

function findMessage(
  fragments: GroundingRequest['context']['fragments'],
  eventId: string,
): { text: string; sender?: string } | undefined {
  const pending: unknown[] = fragments.filter(fragment => fragment.section === 'trigger_events').map(fragment => fragment.content)
  while (pending.length > 0) {
    const value = pending.pop()
    if (Array.isArray(value)) pending.push(...value)
    else if (value && typeof value === 'object') {
      const object = value as Record<string, unknown>
      if (object.id === eventId && typeof object.text === 'string') {
        return { text: object.text, ...(typeof object.sender === 'string' ? { sender: object.sender } : {}) }
      }
      pending.push(...Object.values(object))
    }
  }
  return undefined
}

function toPublicReferent(
  stored: ReturnType<GroundedReferentStore['issue']>,
  spatialKnowledge: GroundedReferent['spatialKnowledge'],
): GroundedReferent {
  return {
    handle: stored.handle,
    role: stored.role,
    referentResolution: 'resolved',
    evidenceIds: [...stored.evidenceIds],
    worldId: stored.worldId,
    epoch: stored.epoch,
    validUntil: stored.validUntil,
    spatialKnowledge,
  }
}
