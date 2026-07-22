import type { BehaviorPlanV1 } from '../behavior/index.js'
import type { ResolvedGroundedTarget } from '../grounding/index.js'

export interface GroundedTargetResolver {
  resolve(input: {
    handle: string
    decisionRunId: string
    effectId: string
    worldId: string
    epoch: number
  }): ResolvedGroundedTarget | undefined
}

export interface MotorControllerScope {
  worldId: string
  epoch: number
}

export type ControllerEvidenceStage =
  | 'commanded'
  | 'motor_completed'
  | 'perception_observed'
  | 'outcome_verified'

export interface ControllerEvidence {
  stage: ControllerEvidenceStage
  at: string
  evidenceIds: string[]
}

export interface VisualAttentionResult {
  planId: string
  decisionRunId: string
  effectId: string
  status: 'completed' | 'failed' | 'cancelled'
  reasonCode: string
  evidence: ControllerEvidence[]
  metrics: { lookSamples: number; scanStops: number }
  observedTarget?: { kind: 'block' | 'entity' | 'identity'; name?: string; username?: string }
}

export interface VisualAttentionControllerRequest {
  plan: BehaviorPlanV1
  signal: AbortSignal
}
