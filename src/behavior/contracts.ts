import type { GroundedEmbodiedIntent } from '../grounding/index.js'

export interface BehaviorScope {
  worldId: string
  epoch: number
  now: Date
}

export interface GroundedHandleAuthority {
  isCurrent(input: {
    handle: string
    decisionRunId: string
    effectId: string
    worldId: string
    epoch: number
  }): boolean
}

export interface VisualAttentionControlStep {
  kind: 'visual_attention_control'
  stateId: string
  targetHandle: string
  mode: 'orient_to_grounded_target' | 'bounded_scan_for_identity'
  maxDurationMs: number
}

export interface BehaviorPlanV1 {
  protocol: 'mineintent.behavior-plan.v1'
  id: string
  decisionRunId: string
  effectId: string
  worldId: string
  epoch: number
  createdAt: string
  validUntil: string
  interruptibility: GroundedEmbodiedIntent['constraints']['interruptibility']
  resourceClaims: ['gaze']
  steps: [VisualAttentionControlStep]
}

export type BehaviorSynthesisResult =
  | { status: 'ready'; plan: BehaviorPlanV1 }
  | {
      status: 'information_needed' | 'unsupported_goal' | 'no_feasible_plan'
      effectId: string
      reasonCode: string
      stateIds?: string[]
      missingProperties?: string[]
    }

export interface BehaviorSynthesisRequest {
  intent: GroundedEmbodiedIntent
  scope: BehaviorScope
}
