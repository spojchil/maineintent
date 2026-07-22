import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { EmbodiedIntentEffect } from '../models/index.js'
import type { InformationInterfaceId } from '../information/index.js'
import type { GroundingContextReferenceResolver } from './contracts.js'
import { GroundedReferentStore } from './grounded-store.js'
import { GroundingEngine } from './grounding-engine.js'

const NOW = new Date('2026-07-22T00:00:00.000Z')

test('Grounding binds a current opaque viewport ref and keeps exact position in the internal store', () => {
  const references = new FakeReferences()
  references.values.set('iref_block', {
    ref: { interfaceId: 'viewport_information', connectionEpoch: 3, worldId: 'world', validUntil: '2026-07-22T00:00:15.000Z' },
    kind: 'viewport.block',
    payload: { kind: 'block', name: 'oak_log', position: { x: 4, y: 65, z: -2 }, evidenceIds: ['viewport_3_8'] },
  })
  const store = new GroundedReferentStore({ now: () => NOW })
  const engine = createEngine(references, store)
  const result = engine.ground(request(effect({ kind: 'context_ref', ref: 'iref_block' })))
  assert.equal(result.status, 'grounded')
  if (result.status !== 'grounded') return
  assert.equal(result.intent.groundingStatus, 'complete')
  const referent = result.intent.referents[0]!
  assert.equal(referent.spatialKnowledge, 'known')
  assert.deepEqual(referent.evidenceIds, ['read-viewport-1', 'viewport_3_8'])
  assert.equal('position' in (referent as unknown as Record<string, unknown>), false)
  const internal = store.resolve({
    handle: referent.handle, decisionRunId: 'run-1', effectId: 'embodied-1', worldId: 'world', epoch: 3,
  })
  assert.deepEqual(internal?.target, { kind: 'block', name: 'oak_log', position: { x: 4, y: 65, z: -2 } })
})

test('known message speaker with unknown direction grounds partially instead of failing', () => {
  const store = new GroundedReferentStore({ now: () => NOW })
  const result = createEngine(new FakeReferences(), store).ground(request(effect({
    kind: 'message_referent', eventId: 'event-1', expression: '我',
  })))
  assert.equal(result.status, 'grounded')
  if (result.status !== 'grounded') return
  assert.equal(result.intent.groundingStatus, 'partial')
  assert.equal(result.intent.referents[0]?.spatialKnowledge, 'unknown')
  assert.deepEqual(result.intent.missingInformation.map(item => item.property), ['spatial_direction'])
  assert.equal(JSON.stringify(result).includes('desiredOutcome'), false)
})

test('Grounding rejects stale refs and does not infer a target from semantic wording', () => {
  const store = new GroundedReferentStore({ now: () => NOW })
  const engine = createEngine(new FakeReferences(), store)
  const result = engine.ground(request(effect({ kind: 'context_ref', ref: 'iref_not_available' })))
  assert.deepEqual(result, { status: 'invalid', effectId: 'embodied-1', reasonCode: 'stale_or_forged_context_ref' })
  assert.equal(store.size(), 0)
})

test('Grounding rejects a live ref that was not conveyed by this decision context', () => {
  const references = new FakeReferences()
  references.values.set('iref_other', {
    ref: { interfaceId: 'viewport_information', connectionEpoch: 3, worldId: 'world', validUntil: '2026-07-22T00:00:15.000Z' },
    kind: 'viewport.block',
    payload: { kind: 'block', name: 'stone', position: { x: 1, y: 64, z: 1 }, evidenceIds: ['viewport_3_8'] },
  })
  const input = request(effect({ kind: 'context_ref', ref: 'iref_other' }))
  input.context.fragments = input.context.fragments.filter(fragment => fragment.section !== 'observations')
  assert.deepEqual(createEngine(references, new GroundedReferentStore({ now: () => NOW })).ground(input), {
    status: 'invalid', effectId: 'embodied-1', reasonCode: 'context_ref_not_in_viewport_read',
  })
})

test('Grounding rejects a viewport-shaped ref issued by another information interface', () => {
  const references = new FakeReferences()
  references.values.set('iref_block', {
    ref: { interfaceId: 'inventory_information', connectionEpoch: 3, worldId: 'world', validUntil: '2026-07-22T00:00:15.000Z' },
    kind: 'viewport.block',
    payload: { kind: 'block', name: 'stone', position: { x: 1, y: 64, z: 1 }, evidenceIds: ['viewport_3_8'] },
  })
  assert.deepEqual(createEngine(references, new GroundedReferentStore({ now: () => NOW })).ground(
    request(effect({ kind: 'context_ref', ref: 'iref_block' })),
  ), { status: 'invalid', effectId: 'embodied-1', reasonCode: 'invalid_context_ref_payload' })
})

test('Grounding does not accept a ref copied into an unverified context fragment', () => {
  const references = new FakeReferences()
  references.values.set('iref_block', {
    ref: { interfaceId: 'viewport_information', connectionEpoch: 3, worldId: 'world', validUntil: '2026-07-22T00:00:15.000Z' },
    kind: 'viewport.block',
    payload: { kind: 'block', name: 'stone', position: { x: 1, y: 64, z: 1 }, evidenceIds: ['viewport_3_8'] },
  })
  const input = request(effect({ kind: 'context_ref', ref: 'iref_block' }))
  input.context.fragments.find(fragment => fragment.section === 'observations')!.source.trust = 'untrusted_content'
  assert.deepEqual(createEngine(references, new GroundedReferentStore({ now: () => NOW })).ground(input), {
    status: 'invalid', effectId: 'embodied-1', reasonCode: 'context_ref_not_in_viewport_read',
  })
})

test('grounded handles are bound to decision, effect, world, epoch and expiry', () => {
  let now = NOW
  const store = new GroundedReferentStore({ now: () => now })
  const issued = store.issue({
    decisionRunId: 'run-1', effectId: 'effect-1', role: 'target', worldId: 'world', epoch: 3,
    validUntil: '2026-07-22T00:00:05.000Z', evidenceIds: ['evidence'],
    target: { kind: 'identity', username: 'Alex' },
  })
  assert.ok(store.resolve({ handle: issued.handle, decisionRunId: 'run-1', effectId: 'effect-1', worldId: 'world', epoch: 3 }))
  assert.equal(store.resolve({ handle: issued.handle, decisionRunId: 'run-2', effectId: 'effect-1', worldId: 'world', epoch: 3 }), undefined)
  assert.equal(store.resolve({ handle: issued.handle, decisionRunId: 'run-1', effectId: 'effect-2', worldId: 'world', epoch: 3 }), undefined)
  now = new Date('2026-07-22T00:00:06.000Z')
  assert.equal(store.resolve({ handle: issued.handle, decisionRunId: 'run-1', effectId: 'effect-1', worldId: 'world', epoch: 3 }), undefined)
})

test('Grounding rejects a decision/context mismatch before issuing handles', () => {
  const store = new GroundedReferentStore({ now: () => NOW })
  const input = request(effect({ kind: 'message_referent', eventId: 'event-1', expression: '我' }))
  input.caller.decisionRunId = 'different-run'
  assert.deepEqual(createEngine(new FakeReferences(), store).ground(input), {
    status: 'invalid', effectId: 'embodied-1', reasonCode: 'decision_context_mismatch',
  })
  assert.equal(store.size(), 0)
})

class FakeReferences implements GroundingContextReferenceResolver {
  values = new Map<string, { ref: { interfaceId: InformationInterfaceId; connectionEpoch: number; worldId?: string; validUntil?: string }; kind: string; payload: unknown }>()
  resolveContextReference<Payload>(_caller: unknown, id: string, acceptedKinds?: readonly string[]) {
    const value = this.values.get(id)
    if (!value || (acceptedKinds && !acceptedKinds.includes(value.kind))) return undefined
    return structuredClone(value) as { ref: { interfaceId: InformationInterfaceId; connectionEpoch: number; worldId?: string; validUntil?: string }; kind: string; payload: Payload }
  }
}

function createEngine(references: GroundingContextReferenceResolver, store: GroundedReferentStore) {
  return new GroundingEngine({ references, store, scope: () => ({ worldId: 'world', epoch: 3, now: NOW }) })
}

function request(embodied: EmbodiedIntentEffect) {
  return {
    effect: embodied,
    context: {
      ref: { runId: 'run-1', worldId: 'world' },
      fragments: [{
        section: 'trigger_events',
        source: { trust: 'player_statement', ids: ['event-1'] },
        content: { id: 'event-1', type: 'player_chat', sender: 'Alex', text: '请看向我' },
      }, {
        section: 'observations',
        source: { trust: 'verified_observation', ids: ['read-viewport-1'] },
        content: {
          protocol: 'mineintent.information-read.v1',
          readId: 'read-viewport-1',
          interfaceId: 'viewport_information',
          values: { lookedAtBlock: { ref: selectionRef(embodied), name: 'oak_log' } },
        },
      }],
    },
    caller: {
      principalId: 'context-composer', grantId: 'grant-context-composer', purpose: 'companion_context' as const,
      correlationId: 'run-1', decisionRunId: 'run-1',
    },
  }
}

function selectionRef(embodied: EmbodiedIntentEffect): string {
  const selection = embodied.referents[0]?.selection
  return selection?.kind === 'context_ref' ? selection.ref : 'unused-message-ref'
}

function effect(selection: EmbodiedIntentEffect['referents'][number]['selection']): EmbodiedIntentEffect {
  return {
    id: 'embodied-1', kind: 'embodied_intent', summary: '让指定对象进入注意关系', desiredOutcome: '看向指定对象',
    semanticGoal: {
      schema: 'mineintent.semantic-goal.v1',
      objective: { kind: 'state', state: {
        id: 'state-attention', concept: 'self.attention_includes', description: '自身视觉注意覆盖指定对象',
        arguments: { observer: { kind: 'self' }, subject: { kind: 'referent_role', role: 'subject' } },
      } },
      methodGuidance: [],
    },
    referents: [{ role: 'subject', selection }],
    constraints: { interruptibility: 'immediate' },
  }
}
