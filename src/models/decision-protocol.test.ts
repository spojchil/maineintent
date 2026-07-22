import assert from 'node:assert/strict'
import { test } from 'node:test'
import {
  companionDecisionV2OutputSchema,
  companionDecisionV2Schema,
  type CompanionDecisionV2,
  type ContextPackageV2,
} from './contracts.js'
import { DecisionProtocolDispatcher } from './decision-protocol.js'

test('dispatcher accepts only a V2 decision bound to the exact context', () => {
  const dispatcher = new DecisionProtocolDispatcher()
  const context = fixtureContext()
  const value = decision(context, [])
  assert.deepEqual(dispatcher.parse(value, context), value)

  assert.throws(() => dispatcher.parse({ ...value, protocol: 'mineintent.companion-decision.v1' }, context), /mineintent\.decision\.v2/u)
  assert.throws(() => dispatcher.parse({ ...value, action: { skill: 'collect_wood' } }, context), /Unrecognized key/u)
  assert.throws(() => dispatcher.parse({ ...value, context: { ...value.context, companionRevision: 2 } }, context), /context reference/u)
})

test('dispatcher rejects duplicate effects and invalid dependency references', () => {
  const dispatcher = new DecisionProtocolDispatcher()
  const context = fixtureContext()
  const duplicate = decision(context, [speech('same'), speech('same')])
  assert.throws(() => dispatcher.parse(duplicate, context), /Duplicate effect id/u)

  const missingDependency = decision(context, [{
    ...speech('later'), timing: 'after_intent_accepted', dependsOn: ['missing'],
  }])
  assert.throws(() => dispatcher.parse(missingDependency, context), /must depend only on an embodied intent/u)
})

test('dispatcher validates opaque and message referents without interpreting their wording', () => {
  const dispatcher = new DecisionProtocolDispatcher()
  const context = fixtureContext()
  const embodied = embodiedIntent({ kind: 'message_referent', eventId: 'event-1', expression: '这棵树' })
  assert.equal(dispatcher.parse(decision(context, [embodied]), context).effects[0]?.kind, 'embodied_intent')

  const forged = embodiedIntent({ kind: 'context_ref', ref: 'ref_not_issued' })
  assert.throws(() => dispatcher.parse(decision(context, [forged]), context), /was not issued/u)
})

test('V2 text limits count Unicode scalar values and output schema contains no skill contract', () => {
  const context = fixtureContext()
  assert.equal(companionDecisionV2Schema.safeParse({ ...decision(context, []), summary: '😀'.repeat(240) }).success, true)
  assert.equal(companionDecisionV2Schema.safeParse({ ...decision(context, []), summary: '😀'.repeat(241) }).success, false)
  const schemaText = JSON.stringify(companionDecisionV2OutputSchema)
  assert.equal(schemaText.includes('collect_wood'), false)
  assert.equal(schemaText.includes('skill'), false)
})

function fixtureContext(): ContextPackageV2 {
  return {
    protocol: 'mineintent.context.v2',
    ref: {
      runId: 'run-1', companionId: 'companion', sessionId: 'session-1', worldId: 'world',
      companionRevision: 1, throughEventSequence: 4, profileVersion: 'profile-1', capabilityRevision: 'cap-1',
    },
    createdAt: '2026-07-22T00:00:00.000Z',
    trigger: { eventIds: ['event-1'], route: 'new', reason: 'player message', priority: 70 },
    limits: { maxInputTokens: 16_000, reservedOutputTokens: 3_000, estimatedInputTokens: 10 },
    fragments: [
      {
        id: 'fragment-trigger', section: 'trigger_events',
        source: { kind: 'player', ids: ['event-1'], trust: 'player_statement' },
        content: { id: 'event-1', type: 'player_chat', text: '请处理这棵树' },
        budget: { estimatedTokens: 5, originalEstimatedTokens: 5, truncated: false },
      },
      {
        id: 'fragment-observation', section: 'observations',
        source: { kind: 'runtime', ids: ['read-1'], trust: 'verified_observation' },
        content: { values: { lookedAtBlock: { ref: 'ref_block_1', name: 'oak_log' } } },
        budget: { estimatedTokens: 5, originalEstimatedTokens: 5, truncated: false },
      },
    ],
    omissions: [],
  }
}

function decision(context: ContextPackageV2, effects: CompanionDecisionV2['effects']): CompanionDecisionV2 {
  return {
    protocol: 'mineintent.decision.v2', runId: context.ref.runId, context: structuredClone(context.ref),
    summary: '简短解释', effects,
  }
}

function speech(id: string): Extract<CompanionDecisionV2['effects'][number], { kind: 'speech' }> {
  return {
    id, kind: 'speech', text: '好。', audience: { kind: 'primary_player' }, timing: 'now', purpose: 'reply',
  }
}

function embodiedIntent(
  selection: Extract<CompanionDecisionV2['effects'][number], { kind: 'embodied_intent' }>['referents'][number]['selection'],
): Extract<CompanionDecisionV2['effects'][number], { kind: 'embodied_intent' }> {
  return {
    id: 'embodied-1', kind: 'embodied_intent', summary: '改变指定对象状态', desiredOutcome: '指定对象不再阻挡',
    semanticGoal: {
      schema: 'mineintent.semantic-goal.v1',
      objective: { kind: 'state', state: {
        id: 'state-1', concept: 'referent.no_longer_obstructs', description: '指定对象不再阻挡通行',
        arguments: { subject: { kind: 'referent_role', role: 'obstacle' } },
      } },
      methodGuidance: [],
    },
    referents: [{ role: 'obstacle', selection }],
    constraints: { interruptibility: 'immediate' },
  }
}
