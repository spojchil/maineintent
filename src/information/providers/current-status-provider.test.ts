import assert from 'node:assert/strict'
import { test } from 'node:test'
import { assertInformationProviderContract } from '../testing/provider-contract.js'
import type { SelfVitalsPort, SelfVitalsSnapshot } from '../source-ports/self-vitals.js'
import { CurrentStatusProvider } from './current-status-provider.js'

class FakeSelfVitalsPort implements SelfVitalsPort {
  constructor(public vitals: SelfVitalsSnapshot) {}
  current(): SelfVitalsSnapshot { return this.vitals }
}

function context() {
  return {
    now: new Date().toISOString(),
    scope: { processSessionId: 's', connectionState: 'play' as const, connectionEpoch: 1, uiRevision: 0, capturedAt: new Date().toISOString() },
    caller: { audience: 'companion' as const, purpose: 'companion_context' as const },
    refs: { issue: () => { throw new Error('not used') } },
  }
}

test('current status provider satisfies the provider contract', async () => {
  const port = new FakeSelfVitalsPort({ health: 20, food: 18, foodSaturation: 5, oxygen: 20, experience: { level: 3, progress: 0.5, total: 100 }, effects: [] })
  const provider = new CurrentStatusProvider(port)
  await assertInformationProviderContract(provider, {
    context: context(),
    request: { fields: ['health', 'food', 'oxygen', 'experienceLevel', 'statusEffects'], page: { limit: 1 } },
  })
})

test('current status provider leaves unsupported HUD values unavailable instead of inventing defaults', async () => {
  const port = new FakeSelfVitalsPort({ health: 10, food: 5, foodSaturation: 0, effects: [] })
  const provider = new CurrentStatusProvider(port)
  const result = await provider.read(context(), { fields: ['oxygen', 'experienceLevel'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.oxygen, undefined)
  assert.equal(result.values.experienceLevel, undefined)
  assert.deepEqual(result.unavailable, [
    { field: 'oxygen', reason: 'not_currently_displayed' },
    { field: 'experienceLevel', reason: 'not_supported' },
  ])
})

test('current status provider bumps revision only when vitals change', async () => {
  const port = new FakeSelfVitalsPort({ health: 20, food: 20, foodSaturation: 5, effects: [] })
  const provider = new CurrentStatusProvider(port)
  const first = provider.availability().informationRevision
  const same = provider.availability().informationRevision
  assert.equal(same, first)
  port.vitals = { ...port.vitals, foodSaturation: 0 }
  assert.equal(provider.availability().informationRevision, first, 'hidden saturation does not change the public projection')
  port.vitals = { ...port.vitals, health: 15 }
  const changed = provider.availability().informationRevision
  assert.equal(changed, first + 1)
})

test('current status projection quantizes hidden health fractions and removes effect ticks', async () => {
  const port = new FakeSelfVitalsPort({
    health: 14.25, food: 18, foodSaturation: 3,
    effects: [{ name: 'Speed', amplifier: 1, durationTicks: 137 }],
  })
  const provider = new CurrentStatusProvider(port)
  const result = await provider.read(context(), { fields: ['health', 'statusEffects'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.health, 15)
  assert.deepEqual(result.values.statusEffects, [{ name: 'Speed', amplifier: 1 }])
})
