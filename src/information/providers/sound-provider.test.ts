import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { SoundHistoryPort, SoundObservation } from '../source-ports/sound.js'
import { assertInformationProviderContract } from '../testing/provider-contract.js'
import { SoundInformationProvider } from './sound-provider.js'

class FakeSoundHistoryPort implements SoundHistoryPort {
  constructor(private entries: SoundObservation[] = []) {}
  recent(limit: number): readonly SoundObservation[] { return this.entries.slice(0, limit) }
  revision(): number { return this.entries.length }
}

function context() {
  return {
    now: new Date().toISOString(),
    scope: { processSessionId: 's', connectionState: 'play' as const, connectionEpoch: 1, uiRevision: 0, capturedAt: new Date().toISOString() },
    caller: { audience: 'companion' as const, purpose: 'companion_context' as const },
    refs: { issue: () => { throw new Error('not used') } },
  }
}

test('sound provider satisfies the provider contract', async () => {
  const provider = new SoundInformationProvider(new FakeSoundHistoryPort([
    {
      semanticHint: 'cow', distanceBand: 'near', direction: 'ahead',
      observedAt: new Date().toISOString(), validUntil: new Date(Date.now() + 5_000).toISOString(),
    },
  ]))
  await assertInformationProviderContract(provider, { context: context(), request: { fields: ['recentSounds'], page: { limit: 1 } } })
})

test('sound provider returns an empty list, not unavailable, when nothing was heard', async () => {
  const provider = new SoundInformationProvider(new FakeSoundHistoryPort([]))
  const result = await provider.read(context(), { fields: ['recentSounds'], page: { limit: 1 } }, new AbortController().signal)
  assert.deepEqual(result.values.recentSounds, [])
  assert.deepEqual(result.unavailable, [])
})

test('sound provider preserves bounded semantics and publishes the earliest expiry', async () => {
  const observedAt = new Date().toISOString()
  const validUntil = new Date(Date.now() + 5_000).toISOString()
  const provider = new SoundInformationProvider(new FakeSoundHistoryPort([
    { semanticHint: 'zombie', distanceBand: 'medium', direction: 'behind', observedAt, validUntil },
  ]))
  const result = await provider.read(context(), { fields: ['recentSounds'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.validUntil, validUntil)
  assert.deepEqual(result.values.recentSounds?.[0], {
    semanticHint: 'zombie', distanceBand: 'medium', direction: 'behind', observedAt, validUntil,
  })
})
