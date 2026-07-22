import { z } from 'zod'
import type { ViewportGroundingPayload } from '../information/providers/viewport-provider.js'
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

const positionSchema = z.strictObject({ x: z.number().finite(), y: z.number().finite(), z: z.number().finite() })
const viewportPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('block'), name: z.string().min(1), position: positionSchema, evidenceIds: z.array(z.string().min(1)) }),
  z.strictObject({
    kind: z.literal('entity'), entityKey: z.string().min(1), type: z.string().min(1),
    name: z.string().min(1).optional(), username: z.string().min(1).optional(),
    position: positionSchema, evidenceIds: z.array(z.string().min(1)),
  }),
])

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
        const resolved = this.#references.resolveContextReference<ViewportGroundingPayload>(
          request.caller,
          referent.selection.ref,
          ['viewport.block', 'viewport.entity'],
        )
        if (!resolved) return { status: 'invalid', effectId: request.effect.id, reasonCode: 'stale_or_forged_context_ref' }
        const payload = viewportPayloadSchema.safeParse(resolved.payload)
        if (!payload.success || resolved.ref.connectionEpoch !== scope.epoch || resolved.ref.worldId !== scope.worldId || !resolved.ref.validUntil) {
          return { status: 'invalid', effectId: request.effect.id, reasonCode: 'invalid_context_ref_payload' }
        }
        pending.push({
          role: referent.role,
          validUntil: resolved.ref.validUntil,
          evidenceIds: [...payload.data.evidenceIds],
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
