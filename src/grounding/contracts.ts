import type { EmbodiedIntentEffect, SemanticGoalV1 } from '../models/index.js'

export interface GroundedReferent {
  handle: string
  role: string
  referentResolution: 'resolved'
  evidenceIds: string[]
  worldId: string
  epoch: number
  validUntil: string
  spatialKnowledge: 'known' | 'estimated' | 'unknown'
}

export type GroundedSemanticTerm =
  | { kind: 'self' }
  | { kind: 'grounded_referent'; handle: string }
  | { kind: 'value'; value: string | number | boolean; unit?: string }

export interface GroundedSemanticState {
  id: string
  concept: string
  description: string
  arguments: Record<string, GroundedSemanticTerm>
}

export type GroundedGoalExpression =
  | { kind: 'state'; state: GroundedSemanticState }
  | { kind: 'all'; goals: GroundedGoalExpression[] }
  | { kind: 'any'; goals: GroundedGoalExpression[] }

export interface GroundedSemanticGoalV1 {
  schema: 'mineintent.semantic-goal.v1'
  objective: GroundedGoalExpression
  methodGuidance: Array<{
    description: string
    groundedReferentHandles: string[]
    strength: 'required' | 'preferred' | 'suggested'
  }>
}

export interface GroundingInformationGap {
  referentHandle: string
  property: string
  requiredByStateIds: string[]
}

export interface GroundedEmbodiedIntent {
  decisionRunId: string
  effectId: string
  groundingStatus: 'complete' | 'partial'
  semanticGoal: GroundedSemanticGoalV1
  referents: GroundedReferent[]
  missingInformation: GroundingInformationGap[]
  constraints: EmbodiedIntentEffect['constraints']
}

export type EmbodiedGroundingResult =
  | { status: 'grounded'; intent: GroundedEmbodiedIntent }
  | {
      status: 'needs_clarification' | 'invalid' | 'unavailable'
      effectId: string
      reasonCode: string
      ambiguousRoles?: string[]
    }

export type GroundedTarget =
  | { kind: 'block'; name: string; position: { x: number; y: number; z: number } }
  | {
      kind: 'entity'
      entityKey: string
      type: string
      name?: string
      username?: string
      position: { x: number; y: number; z: number }
    }
  | { kind: 'identity'; username: string }

export interface ResolvedGroundedTarget {
  handle: string
  decisionRunId: string
  effectId: string
  role: string
  worldId: string
  epoch: number
  validUntil: string
  evidenceIds: string[]
  target: GroundedTarget
}

export interface GroundingContextReferenceResolver {
  resolveContextReference<Payload>(
    caller: GroundingCaller,
    id: string,
    acceptedKinds?: readonly string[],
  ): { ref: { connectionEpoch: number; worldId?: string; validUntil?: string }; kind: string; payload: Payload } | undefined
}

export interface GroundingCaller {
  principalId: string
  grantId: string
  purpose: 'companion_context'
  correlationId: string
  decisionRunId: string
}

export interface GroundingScope {
  worldId: string
  epoch: number
  now: Date
}

export interface GroundingRequest {
  effect: EmbodiedIntentEffect
  context: {
    ref: { runId: string; worldId: string }
    fragments: Array<{ section: string; content: unknown }>
  }
  caller: GroundingCaller
}

// Compile-time assertion that the model and grounded schemas remain related,
// while preventing the ungrounded model type from crossing into Behavior.
export type UngroundedSemanticGoal = SemanticGoalV1
