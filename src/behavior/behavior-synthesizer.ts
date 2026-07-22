import { randomUUID } from 'node:crypto'
import type { GroundedGoalExpression, GroundedSemanticState } from '../grounding/index.js'
import type {
  BehaviorPlanV1,
  BehaviorSynthesisRequest,
  BehaviorSynthesisResult,
  GroundedHandleAuthority,
  VisualAttentionControlStep,
} from './contracts.js'

const DEFAULT_PLAN_DURATION_MS = 8_000
const MAX_PLAN_DURATION_MS = 30_000
const PLAN_TTL_MS = 5_000

interface SupportedAttentionState {
  stateId: string
  targetHandle: string
}

type ObjectiveSelection =
  | { status: 'selected'; state: SupportedAttentionState }
  | { status: 'unsupported'; stateIds: string[] }
  | { status: 'infeasible'; stateIds: string[] }

/**
 * Deterministic first operator slice. It consumes only the grounded semantic contract and
 * handle validity. Free-text descriptions, player wording and target implementation data are
 * intentionally absent from dispatch.
 */
export class BehaviorSynthesizer {
  readonly #authority: GroundedHandleAuthority
  readonly #id: () => string

  constructor(authority: GroundedHandleAuthority, id: () => string = randomUUID) {
    this.#authority = authority
    this.#id = id
  }

  synthesize(request: BehaviorSynthesisRequest): BehaviorSynthesisResult {
    const { intent, scope } = request
    const referentExpiries = intent.referents.map(referent => Date.parse(referent.validUntil))
    if (referentExpiries.some(expiry => !Number.isFinite(expiry)) || intent.referents.some((referent, index) =>
      referent.worldId !== scope.worldId || referent.epoch !== scope.epoch ||
      referentExpiries[index]! <= scope.now.getTime())) {
      return { status: 'no_feasible_plan', effectId: intent.effectId, reasonCode: 'stale_grounded_referent' }
    }
    for (const referent of intent.referents) {
      if (!this.#authority.isCurrent({
        handle: referent.handle,
        decisionRunId: intent.decisionRunId,
        effectId: intent.effectId,
        worldId: scope.worldId,
        epoch: scope.epoch,
      })) {
        return { status: 'no_feasible_plan', effectId: intent.effectId, reasonCode: 'unauthorized_grounded_referent' }
      }
    }
    if (intent.semanticGoal.methodGuidance.some(guidance => guidance.strength === 'required')) {
      return { status: 'unsupported_goal', effectId: intent.effectId, reasonCode: 'required_method_not_supported' }
    }

    const selection = selectObjective(intent.semanticGoal.objective)
    if (selection.status === 'unsupported') {
      return {
        status: 'unsupported_goal', effectId: intent.effectId,
        reasonCode: 'semantic_operator_not_supported', stateIds: selection.stateIds,
      }
    }
    if (selection.status === 'infeasible') {
      return {
        status: 'no_feasible_plan', effectId: intent.effectId,
        reasonCode: 'compound_attention_not_feasible', stateIds: selection.stateIds,
      }
    }

    const referent = intent.referents.find(candidate => candidate.handle === selection.state.targetHandle)
    if (!referent) {
      return { status: 'no_feasible_plan', effectId: intent.effectId, reasonCode: 'selected_referent_missing' }
    }
    const gaps = intent.missingInformation.filter(gap => gap.referentHandle === referent.handle)
    if (referent.spatialKnowledge === 'unknown' && !gaps.some(gap => gap.property === 'spatial_direction')) {
      return { status: 'no_feasible_plan', effectId: intent.effectId, reasonCode: 'inconsistent_spatial_grounding' }
    }
    const unsupportedGaps = gaps.filter(gap => gap.property !== 'spatial_direction')
    if (unsupportedGaps.length > 0) {
      return {
        status: 'information_needed', effectId: intent.effectId, reasonCode: 'unsupported_information_gap',
        stateIds: [selection.state.stateId], missingProperties: [...new Set(unsupportedGaps.map(gap => gap.property))],
      }
    }

    const mode: VisualAttentionControlStep['mode'] = referent.spatialKnowledge === 'known'
      ? 'orient_to_grounded_target'
      : 'bounded_scan_for_identity'
    const durationMs = Math.min(intent.constraints.maxDurationMs ?? DEFAULT_PLAN_DURATION_MS, MAX_PLAN_DURATION_MS)
    const validUntilMs = Math.min(
      scope.now.getTime() + PLAN_TTL_MS,
      ...referentExpiries,
    )
    const plan: BehaviorPlanV1 = {
      protocol: 'mineintent.behavior-plan.v1',
      id: `behavior_${this.#id()}`,
      decisionRunId: intent.decisionRunId,
      effectId: intent.effectId,
      worldId: scope.worldId,
      epoch: scope.epoch,
      createdAt: scope.now.toISOString(),
      validUntil: new Date(validUntilMs).toISOString(),
      interruptibility: intent.constraints.interruptibility,
      resourceClaims: ['gaze'],
      steps: [{
        kind: 'visual_attention_control',
        stateId: selection.state.stateId,
        targetHandle: selection.state.targetHandle,
        mode,
        maxDurationMs: durationMs,
      }],
    }
    return { status: 'ready', plan }
  }
}

function selectObjective(expression: GroundedGoalExpression): ObjectiveSelection {
  if (expression.kind === 'state') return selectAttentionState(expression.state)
  const selections = expression.goals.map(selectObjective)
  if (expression.kind === 'any') {
    const selected = selections.find((item): item is Extract<ObjectiveSelection, { status: 'selected' }> => item.status === 'selected')
    if (selected) return selected
    return {
      status: selections.some(item => item.status === 'infeasible') ? 'infeasible' : 'unsupported',
      stateIds: selections.flatMap(selectionStateIds),
    }
  }
  if (selections.length === 1) return selections[0]!
  const selected = selections.filter((item): item is Extract<ObjectiveSelection, { status: 'selected' }> => item.status === 'selected')
  if (selected.length === selections.length && new Set(selected.map(item => item.state.targetHandle)).size === 1) return selected[0]!
  return { status: 'infeasible', stateIds: selections.flatMap(selectionStateIds) }
}

function selectAttentionState(state: GroundedSemanticState): ObjectiveSelection {
  if (state.concept !== 'self.attention_includes') return { status: 'unsupported', stateIds: [state.id] }
  const keys = Object.keys(state.arguments).sort()
  if (keys.length !== 2 || keys[0] !== 'observer' || keys[1] !== 'subject') {
    return { status: 'unsupported', stateIds: [state.id] }
  }
  const observer = state.arguments.observer
  const subject = state.arguments.subject
  if (observer?.kind !== 'self' || subject?.kind !== 'grounded_referent') {
    return { status: 'unsupported', stateIds: [state.id] }
  }
  return { status: 'selected', state: { stateId: state.id, targetHandle: subject.handle } }
}

function selectionStateIds(selection: ObjectiveSelection): string[] {
  return selection.status === 'selected' ? [selection.state.stateId] : selection.stateIds
}
