import assert from 'node:assert/strict'
import { test } from 'node:test'
import { BODY_CAPABILITY_CATALOG } from '../capabilities/index.js'
import type { InformationReadResult } from '../information/index.js'
import { ContextBudgetError, composeContextPackage } from './context-composer.js'

test('Context Composer preserves read envelopes, source trust and fixed section order', () => {
  const context = composeContextPackage(fixture())
  assert.equal(context.protocol, 'mineintent.context.v2')
  assert.deepEqual(context.fragments.map(fragment => fragment.section), [
    'product_constraints', 'companion_profile', 'relationship_core', 'current_state',
    'trigger_events', 'trigger_events', 'observations', 'capabilities',
  ])
  const observation = context.fragments.find(fragment => fragment.section === 'observations')!
  assert.equal((observation.content as InformationReadResult<Record<string, unknown>>).readId, 'read-status')
  assert.equal(observation.source.trust, 'verified_observation')
  assert.equal(JSON.stringify(context).includes('C:\\private\\profile.md'), false)
  assert.equal(JSON.stringify(context).includes('availableSkills'), false)
})

test('Context Composer records optional omissions and fails instead of truncating required context', () => {
  const baseline = composeContextPackage(fixture())
  const requiredTokens = baseline.fragments
    .filter(fragment => !['observations', 'retrieved_memories'].includes(fragment.section) && fragment.id !== 'fragment_recent_events')
    .reduce((sum, fragment) => sum + fragment.budget.estimatedTokens, 0)
  const constrained = composeContextPackage({
    ...fixture(),
    recentEvents: [{ id: 'event-0', type: 'summary', summary: '旧事件'.repeat(4_000) }],
    maxInputTokens: Math.max(1_024, requiredTokens),
  })
  assert.equal(constrained.omissions.length > 0, true)

  assert.throws(() => composeContextPackage({
    ...fixture(),
    profile: { ...fixture().profile, content: '档案'.repeat(20_000) },
    maxInputTokens: 1_024,
  }), ContextBudgetError)
})

test('capability catalog is immutable metadata and contains no executable values', () => {
  assert.equal(Object.isFrozen(BODY_CAPABILITY_CATALOG), true)
  const pending: unknown[] = [BODY_CAPABILITY_CATALOG]
  while (pending.length > 0) {
    const value = pending.pop()
    assert.notEqual(typeof value, 'function')
    if (Array.isArray(value)) pending.push(...value)
    else if (value && typeof value === 'object') pending.push(...Object.values(value))
  }
})

function fixture() {
  const read: InformationReadResult<Record<string, unknown>> = {
    protocol: 'mineintent.information-read.v1', readId: 'read-status', interfaceId: 'current_status',
    schemaRevision: 'current-status:2', informationRevision: 1, connectionEpoch: 1,
    worldId: 'world', dimension: 'overworld', observedAt: '2026-07-22T00:00:00.000Z',
    source: { kind: 'hud_projection', adapterRevision: 'test', sourceRevision: 1, acquisition: 'current_perception' },
    values: { health: { current: 20, maximum: 20 } }, unavailable: [], evidenceIds: ['evidence-1'],
  }
  return {
    runId: 'run-1', companionId: 'companion', sessionId: 'session-1', worldId: 'world',
    companionRevision: 2, throughEventSequence: 8,
    profile: { profileId: 'companion', versionId: 'profile-1', content: '你是可靠的朋友。', sourcePath: 'C:\\private\\profile.md' },
    trigger: { type: 'player_chat' as const, text: '你好', eventId: 'event-1' }, route: 'new' as const,
    primaryPlayer: 'Alex', currentState: { activity: null, intent: null },
    recentEvents: [{ id: 'event-0', type: 'companion.started', summary: '加入世界' }],
    memories: [], observations: { reads: [read], omissions: [] }, createdAt: '2026-07-22T00:00:00.000Z',
  }
}
