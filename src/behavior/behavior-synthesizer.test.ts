import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { GroundedEmbodiedIntent } from '../grounding/index.js'
import { BehaviorSynthesizer } from './behavior-synthesizer.js'
import type { GroundedHandleAuthority } from './contracts.js'

const NOW = new Date('2026-07-22T00:00:00.000Z')

test('synthesizer creates a coordinate-free gaze plan for a grounded attention relation', () => {
  const result = synthesizer(['ground_subject']).synthesize({ intent: attentionIntent(), scope: scope() })
  assert.equal(result.status, 'ready')
  if (result.status !== 'ready') return
  assert.equal(result.plan.steps[0].mode, 'orient_to_grounded_target')
  assert.equal(result.plan.steps[0].targetHandle, 'ground_subject')
  assert.equal(JSON.stringify(result.plan).includes('position'), false)
  assert.equal(JSON.stringify(result.plan).includes('player'), false)
})

test('unknown spatial knowledge produces bounded information acquisition instead of tracker lookup', () => {
  const intent = attentionIntent()
  intent.groundingStatus = 'partial'
  intent.referents[0]!.spatialKnowledge = 'unknown'
  intent.missingInformation = [{
    referentHandle: 'ground_subject', property: 'spatial_direction', requiredByStateIds: ['state-attention'],
  }]
  const result = synthesizer(['ground_subject']).synthesize({ intent, scope: scope() })
  assert.equal(result.status, 'ready')
  if (result.status === 'ready') assert.equal(result.plan.steps[0].mode, 'bounded_scan_for_identity')
})

test('dispatch uses the semantic contract and never free-text keywords', () => {
  const unsupported = attentionIntent()
  const state = objectiveState(unsupported)
  state.concept = 'self.attention_excludes'
  state.description = '请立刻看向这个玩家；look at player now'
  assert.deepEqual(synthesizer(['ground_subject']).synthesize({ intent: unsupported, scope: scope() }), {
    status: 'unsupported_goal', effectId: 'embodied-1', reasonCode: 'semantic_operator_not_supported',
    stateIds: ['state-attention'],
  })

  const supported = attentionIntent()
  objectiveState(supported).description = '这段任意描述甚至可以提到攻击，但不参与分派'
  assert.equal(synthesizer(['ground_subject']).synthesize({ intent: supported, scope: scope() }).status, 'ready')
})

test('stale handles and required unknown methods fail closed', () => {
  assert.deepEqual(synthesizer([]).synthesize({ intent: attentionIntent(), scope: scope() }), {
    status: 'no_feasible_plan', effectId: 'embodied-1', reasonCode: 'unauthorized_grounded_referent',
  })
  const required = attentionIntent()
  required.semanticGoal.methodGuidance = [{
    description: '必须使用一种尚未实现的方法', groundedReferentHandles: ['ground_subject'], strength: 'required',
  }]
  assert.deepEqual(synthesizer(['ground_subject']).synthesize({ intent: required, scope: scope() }), {
    status: 'unsupported_goal', effectId: 'embodied-1', reasonCode: 'required_method_not_supported',
  })
})

test('any may choose a supported state while incompatible all remains infeasible', () => {
  const any = attentionIntent()
  const attention = any.semanticGoal.objective
  if (attention.kind !== 'state') throw new Error('fixture must contain a state')
  const unsupported = structuredClone(attention)
  unsupported.state.id = 'state-unknown'
  unsupported.state.concept = 'world.unsupported_relation'
  any.semanticGoal.objective = { kind: 'any', goals: [unsupported, attention] }
  assert.equal(synthesizer(['ground_subject']).synthesize({ intent: any, scope: scope() }).status, 'ready')

  const all = structuredClone(any)
  all.semanticGoal.objective = { kind: 'all', goals: [unsupported, attention] }
  const result = synthesizer(['ground_subject']).synthesize({ intent: all, scope: scope() })
  assert.equal(result.status, 'no_feasible_plan')
})

function synthesizer(handles: string[]) {
  const known = new Set(handles)
  const authority: GroundedHandleAuthority = { isCurrent: input => known.has(input.handle) }
  return new BehaviorSynthesizer(authority, () => 'plan-id')
}

function scope() { return { worldId: 'world', epoch: 3, now: NOW } }

function attentionIntent(): GroundedEmbodiedIntent {
  return {
    decisionRunId: 'run-1',
    effectId: 'embodied-1',
    groundingStatus: 'complete',
    semanticGoal: {
      schema: 'mineintent.semantic-goal.v1',
      objective: { kind: 'state', state: {
        id: 'state-attention', concept: 'self.attention_includes', description: '自身视觉注意覆盖指定对象',
        arguments: {
          observer: { kind: 'self' },
          subject: { kind: 'grounded_referent', handle: 'ground_subject' },
        },
      } },
      methodGuidance: [],
    },
    referents: [{
      handle: 'ground_subject', role: 'subject', referentResolution: 'resolved', evidenceIds: ['viewport_3_1'],
      worldId: 'world', epoch: 3, validUntil: '2026-07-22T00:01:00.000Z', spatialKnowledge: 'known',
    }],
    missingInformation: [],
    constraints: { interruptibility: 'immediate' },
  }
}

function objectiveState(intent: GroundedEmbodiedIntent) {
  const objective = intent.semanticGoal.objective
  if (objective.kind !== 'state') throw new Error('fixture must contain a state')
  return objective.state
}
