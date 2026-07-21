import { z } from 'zod'
import type { PassiveObservations } from '../information/index.js'
import type { MinecraftSnapshotV1 } from '../minecraft/contracts.js'
import type { MemoryRecord } from '../memory/contracts.js'
import type { CompanionProfile } from '../companion/profile.js'

const actionSchema = z.discriminatedUnion('skill', [
  z.strictObject({ skill: z.literal('follow_player'), args: z.strictObject({ range: z.number().min(2).max(8).default(3) }), purpose: z.string().min(1).max(200) }),
  z.strictObject({ skill: z.literal('collect_wood'), args: z.strictObject({ count: z.number().int().min(1).max(16), maxDistance: z.number().int().min(8).max(64).default(32) }), purpose: z.string().min(1).max(200) }),
  z.strictObject({ skill: z.literal('return_to_anchor'), args: z.strictObject({}), purpose: z.string().min(1).max(200) }),
  z.strictObject({ skill: z.literal('wait'), args: z.strictObject({ durationSeconds: z.number().int().min(1).max(120) }), purpose: z.string().min(1).max(200) }),
])

export const companionDecisionSchema = z.strictObject({
  protocol: z.literal('mineintent.companion-decision.v1'),
  speech: z.string().trim().min(1).max(500).nullable(),
  attention: z.strictObject({ kind: z.string().min(1).max(64), target: z.string().max(128).nullable() }),
  activity: z.strictObject({
    operation: z.enum(['keep', 'start_wood_collection', 'pause', 'resume', 'complete', 'abandon']),
    summary: z.string().trim().min(1).max(300),
  }),
  intent: z.strictObject({ kind: z.string().min(1).max(64), summary: z.string().trim().min(1).max(300) }),
  action: actionSchema.nullable(),
  memory: z.strictObject({ kind: z.enum(['episode', 'place', 'commitment', 'player_preference']), summary: z.string().trim().min(1).max(1_000) }).nullable(),
})

export type CompanionDecision = z.infer<typeof companionDecisionSchema>

export interface DecisionContext {
  runId: string
  trigger: { type: 'startup' | 'player_chat' | 'action_result' | 'danger'; text?: string; eventId: string }
  primaryPlayer: string
  profile: CompanionProfile
  snapshot: MinecraftSnapshotV1
  activity?: { id: string; kind: string; status: string; summary: string; anchor?: { x: number; y: number; z: number } }
  recentEvents: Array<{ id: string; type: string; summary: string }>
  memories: MemoryRecord[]
  observations: PassiveObservations
  availableSkills: readonly string[]
}

export interface ModelRunResult {
  decision: CompanionDecision
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ModelProvider {
  run(context: DecisionContext, signal: AbortSignal): Promise<ModelRunResult>
}
