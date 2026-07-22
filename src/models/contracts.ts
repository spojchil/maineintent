import { z } from 'zod'

const EFFECT_ID = /^[A-Za-z0-9_-]{1,64}$/u
const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,159}$/u

function scalarLength(value: string): number | undefined {
  let length = 0
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) return undefined
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      return undefined
    }
    length += 1
  }
  return length
}

function text(minimum: number, maximum: number, options: { trimmed?: boolean } = {}) {
  return z.string().refine(value => {
    const length = scalarLength(value)
    return length !== undefined && length >= minimum && length <= maximum &&
      (!options.trimmed || value === value.trim())
  }, `must contain ${minimum}-${maximum} Unicode scalar values${options.trimmed ? ' without surrounding whitespace' : ''}`)
}

const idSchema = text(1, 160).regex(IDENTIFIER)
const effectIdSchema = z.string().regex(EFFECT_ID)
const isoDateSchema = z.iso.datetime({ offset: true })

export const decisionContextRefSchema = z.strictObject({
  runId: idSchema,
  companionId: idSchema,
  sessionId: idSchema,
  worldId: text(1, 256),
  companionRevision: z.number().int().nonnegative(),
  throughEventSequence: z.number().int().nonnegative(),
  profileVersion: idSchema,
  capabilityRevision: idSchema,
})

export type DecisionContextRef = z.infer<typeof decisionContextRefSchema>

const contextSourceSchema = z.strictObject({
  kind: z.enum(['runtime', 'event', 'profile', 'memory', 'player', 'summary', 'capability_registry']),
  ids: z.array(text(1, 256)).min(1).max(64),
  trust: z.enum([
    'runtime_authoritative', 'verified_observation', 'player_statement', 'profile_instruction',
    'remembered_record', 'derived_summary', 'untrusted_content',
  ]),
  observedAt: isoDateSchema.optional(),
  validAt: isoDateSchema.optional(),
})

const contextSectionSchema = z.enum([
  'product_constraints', 'companion_profile', 'relationship_core', 'current_state', 'trigger_events',
  'observations', 'retrieved_memories', 'capabilities', 'requested_knowledge',
])

const contextFragmentSchema = z.strictObject({
  id: idSchema,
  section: contextSectionSchema,
  source: contextSourceSchema,
  content: z.unknown(),
  budget: z.strictObject({
    estimatedTokens: z.number().int().nonnegative(),
    originalEstimatedTokens: z.number().int().nonnegative(),
    truncated: z.boolean(),
    truncationReason: z.enum(['section_budget', 'total_budget', 'recency_limit', 'deduplicated']).optional(),
    omittedItemCount: z.number().int().positive().optional(),
  }),
})

export const contextPackageV2Schema = z.strictObject({
  protocol: z.literal('mineintent.context.v2'),
  ref: decisionContextRefSchema,
  createdAt: isoDateSchema,
  trigger: z.strictObject({
    eventIds: z.array(text(1, 256)).min(1).max(64),
    route: z.enum(['new', 'collect', 'steer_rerun', 'interrupt_rerun', 'follow_up', 'proactive']),
    reason: text(1, 300, { trimmed: true }),
    priority: z.number().int().min(0).max(100),
  }),
  limits: z.strictObject({
    maxInputTokens: z.number().int().min(1_024).max(1_000_000),
    reservedOutputTokens: z.number().int().min(256).max(100_000),
    estimatedInputTokens: z.number().int().nonnegative(),
  }),
  fragments: z.array(contextFragmentSchema).min(1).max(128),
  omissions: z.array(z.strictObject({
    section: contextSectionSchema,
    reason: text(1, 240, { trimmed: true }),
    count: z.number().int().positive().optional(),
  })).max(128),
})

export type ContextPackageV2 = z.infer<typeof contextPackageV2Schema>
export type ContextFragment = z.infer<typeof contextFragmentSchema>
export type ContextSection = z.infer<typeof contextSectionSchema>

const semanticTermSchema = z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('self') }),
  z.strictObject({ kind: z.literal('referent_role'), role: idSchema }),
  z.strictObject({
    kind: z.literal('value'),
    value: z.union([text(1, 512), z.number().finite(), z.boolean()]),
    unit: text(1, 64).optional(),
  }),
])

const semanticStateSchema = z.strictObject({
  id: effectIdSchema,
  concept: idSchema,
  description: text(1, 300, { trimmed: true }),
  arguments: z.record(idSchema, semanticTermSchema),
})

type SemanticGoalExpressionInput =
  | { kind: 'state'; state: z.input<typeof semanticStateSchema> }
  | { kind: 'all' | 'any'; goals: SemanticGoalExpressionInput[] }

const semanticGoalExpressionSchema: z.ZodType<SemanticGoalExpressionInput> = z.lazy(() => z.discriminatedUnion('kind', [
  z.strictObject({ kind: z.literal('state'), state: semanticStateSchema }),
  z.strictObject({ kind: z.literal('all'), goals: z.array(semanticGoalExpressionSchema).min(1).max(16) }),
  z.strictObject({ kind: z.literal('any'), goals: z.array(semanticGoalExpressionSchema).min(1).max(16) }),
]))

const semanticGoalSchema = z.strictObject({
  schema: z.literal('mineintent.semantic-goal.v1'),
  objective: semanticGoalExpressionSchema,
  methodGuidance: z.array(z.strictObject({
    description: text(1, 300, { trimmed: true }),
    referentRoles: z.array(idSchema).max(16),
    strength: z.enum(['required', 'preferred', 'suggested']),
  })).max(16),
})

const effectBaseShape = { id: effectIdSchema }

const speechEffectSchema = z.strictObject({
  ...effectBaseShape,
  kind: z.literal('speech'),
  text: text(1, 1_000, { trimmed: true }),
  audience: z.discriminatedUnion('kind', [
    z.strictObject({ kind: z.literal('primary_player') }),
    z.strictObject({ kind: z.literal('nearby_players'), playerIds: z.array(idSchema).min(1).max(32).optional() }),
  ]),
  timing: z.enum(['now', 'after_intent_accepted', 'after_intent_terminal']),
  dependsOn: z.array(effectIdSchema).max(8).optional(),
  terminalCondition: z.enum(['completed', 'failed', 'cancelled', 'any']).optional(),
  purpose: z.enum(['reply', 'acknowledge', 'coordinate', 'report', 'social', 'ask']),
})

const activityEffectSchema = z.strictObject({
  ...effectBaseShape,
  kind: z.literal('activity'),
  operation: z.enum(['propose', 'activate', 'update', 'pause', 'complete', 'abandon']),
  activityId: idSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  summary: text(1, 300, { trimmed: true }).optional(),
  companionContribution: text(1, 500, { trimmed: true }).optional(),
  agreedFacts: z.array(text(1, 300, { trimmed: true })).max(16).optional(),
  openQuestions: z.array(text(1, 300, { trimmed: true })).max(16).optional(),
  reason: text(1, 300, { trimmed: true }),
  evidenceEventIds: z.array(text(1, 256)).max(32),
})

const intentEffectSchema = z.strictObject({
  ...effectBaseShape,
  kind: z.literal('intent'),
  operation: z.enum(['set', 'replace', 'clear']),
  intentId: idSchema.optional(),
  expectedRevision: z.number().int().nonnegative().optional(),
  summary: text(1, 300, { trimmed: true }).optional(),
  reason: text(1, 300, { trimmed: true }),
  activityId: idSchema.optional(),
  completionSignals: z.array(text(1, 160, { trimmed: true })).max(16).optional(),
  invalidationSignals: z.array(text(1, 160, { trimmed: true })).max(16).optional(),
})

const embodiedIntentEffectSchema = z.strictObject({
  ...effectBaseShape,
  kind: z.literal('embodied_intent'),
  summary: text(1, 300, { trimmed: true }),
  desiredOutcome: text(1, 500, { trimmed: true }),
  semanticGoal: semanticGoalSchema,
  referents: z.array(z.strictObject({
    role: idSchema,
    selection: z.discriminatedUnion('kind', [
      z.strictObject({ kind: z.literal('context_ref'), ref: text(1, 256) }),
      z.strictObject({
        kind: z.literal('message_referent'),
        eventId: text(1, 256),
        expression: text(1, 300, { trimmed: true }),
      }),
    ]),
  })).max(16),
  constraints: z.strictObject({
    maxDurationMs: z.number().int().min(100).max(3_600_000).optional(),
    interruptibility: z.enum(['immediate', 'checkpoint']),
  }),
})

const memoryCandidateEffectSchema = z.strictObject({
  ...effectBaseShape,
  kind: z.literal('memory_candidate'),
  memoryKind: z.enum(['episode', 'world_fact', 'player_preference', 'relationship', 'commitment', 'procedural']),
  content: text(1, 1_000, { trimmed: true }),
  sourceClaim: z.enum(['player_stated', 'observed', 'derived']),
  evidenceEventIds: z.array(text(1, 256)).min(1).max(32),
  subjects: z.array(text(1, 160)).max(32),
  placeIds: z.array(idSchema).max(16).optional(),
  activityId: idSchema.optional(),
  confidence: z.number().min(0).max(1),
  validAt: isoDateSchema.optional(),
})

const attentionEffectSchema = z.strictObject({
  ...effectBaseShape,
  kind: z.literal('next_attention'),
  waitFor: z.array(z.enum([
    'player_message', 'embodied_progress', 'embodied_terminal', 'world_event', 'natural_opportunity',
  ])).min(1).max(5),
  focus: text(1, 300, { trimmed: true }),
  embodiedIntentIds: z.array(effectIdSchema).max(8).optional(),
  earliestProactiveAt: isoDateSchema.optional(),
  expiresAt: isoDateSchema.optional(),
})

export const decisionEffectV2Schema = z.discriminatedUnion('kind', [
  speechEffectSchema,
  activityEffectSchema,
  intentEffectSchema,
  embodiedIntentEffectSchema,
  memoryCandidateEffectSchema,
  attentionEffectSchema,
])

export const companionDecisionV2Schema = z.strictObject({
  protocol: z.literal('mineintent.decision.v2'),
  runId: idSchema,
  context: decisionContextRefSchema,
  summary: text(1, 240, { trimmed: true }),
  effects: z.array(decisionEffectV2Schema).max(16),
})

export type CompanionDecisionV2 = z.infer<typeof companionDecisionV2Schema>
export type DecisionEffectV2 = z.infer<typeof decisionEffectV2Schema>
export type EmbodiedIntentEffect = z.infer<typeof embodiedIntentEffectSchema>
export type ActivityEffect = z.infer<typeof activityEffectSchema>
export type IntentEffect = z.infer<typeof intentEffectSchema>
export type SpeechEffectV2 = z.infer<typeof speechEffectSchema>
export type MemoryCandidateEffect = z.infer<typeof memoryCandidateEffectSchema>
export type AttentionEffectV2 = z.infer<typeof attentionEffectSchema>
export type SemanticGoalV1 = z.infer<typeof semanticGoalSchema>

export const companionDecisionV2OutputSchema = z.toJSONSchema(companionDecisionV2Schema, {
  target: 'draft-2020-12',
  unrepresentable: 'any',
  cycles: 'ref',
  reused: 'ref',
})

export interface RawModelRunResult {
  rawOutput: unknown
  model: string
  usage?: { inputTokens?: number; outputTokens?: number }
}

export interface ModelProvider {
  runDecision(input: {
    context: ContextPackageV2
    outputSchema: object
    signal: AbortSignal
  }): Promise<RawModelRunResult>
}
