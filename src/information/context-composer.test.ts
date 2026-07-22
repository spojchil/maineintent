import assert from 'node:assert/strict'
import { test } from 'node:test'
import { InMemoryInformationAccessPolicy } from './access-policy.js'
import { composePassiveObservations } from './context-composer.js'
import type { InformationInterfaceId, InformationScopeSnapshot } from './contracts/index.js'
import { CurrentStatusProvider } from './providers/current-status-provider.js'
import { InventoryProvider } from './providers/inventory-provider.js'
import { SoundInformationProvider } from './providers/sound-provider.js'
import { ViewportInformationProvider } from './providers/viewport-provider.js'
import { InformationRegistry } from './registry.js'
import { InformationRuntime } from './runtime.js'
import type { InformationScopeSource } from './scope.js'
import type { InventoryPort } from './source-ports/inventory.js'
import type { PerceptionPort } from './source-ports/perception.js'
import type { SelfVitalsPort } from './source-ports/self-vitals.js'
import type { SoundHistoryPort } from './source-ports/sound.js'

class FixedScopeSource implements InformationScopeSource {
  constructor(private snapshot: InformationScopeSnapshot) {}
  capture(): Readonly<InformationScopeSnapshot> { return this.snapshot }
}

function scope(): InformationScopeSnapshot {
  return { processSessionId: 's', connectionState: 'play', connectionEpoch: 1, worldId: 'w', uiRevision: 0, capturedAt: new Date().toISOString() }
}

function buildRuntime(allowedInterfaces: '*' | readonly InformationInterfaceId[]): InformationRuntime {
  const selfVitals: SelfVitalsPort = { current: () => ({ health: 20, food: 20, foodSaturation: 5, effects: [] }) }
  const inventory: InventoryPort = { current: () => ({ selectedHotbarSlot: 0, slots: [] }) }
  const sound: SoundHistoryPort = { recent: () => [], revision: () => 0 }
  const perception: PerceptionPort = {
    selfPose: () => ({ position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }),
    revision: () => 1,
    blockAt: () => ({ name: 'air', visible: false, occludes: false }),
    nearbyEntities: () => [],
  }
  const registry = new InformationRegistry()
  registry.register(new CurrentStatusProvider(selfVitals))
  registry.register(new InventoryProvider(inventory))
  registry.register(new SoundInformationProvider(sound))
  registry.register(new ViewportInformationProvider(perception))
  registry.seal('1.21.1')

  const accessPolicy = new InMemoryInformationAccessPolicy()
  accessPolicy.put({ id: 'grant-1', principalId: 'context-composer', audience: 'companion', allowedInterfaces, purpose: 'companion_context' })

  return new InformationRuntime({ registry, accessPolicy, scopeSource: new FixedScopeSource(scope()) })
}

test('composePassiveObservations preserves complete read envelopes for every allowed interface', async () => {
  const runtime = buildRuntime('*')
  const result = await composePassiveObservations(runtime, {
    principalId: 'context-composer', grantId: 'grant-1', purpose: 'companion_context', correlationId: 'run-1',
  }, new AbortController().signal)
  const currentStatus = result.reads.find(read => read.interfaceId === 'current_status')
  const inventory = result.reads.find(read => read.interfaceId === 'inventory_information')
  const sound = result.reads.find(read => read.interfaceId === 'sound_information')
  const viewport = result.reads.find(read => read.interfaceId === 'viewport_information')
  assert.match(result.catalogRevision ?? '', /^catalog:/u)
  assert.equal(currentStatus?.values.health, 20)
  assert.equal(inventory?.values.selectedHotbarSlot, 0)
  assert.deepEqual(sound?.values.recentSounds, [])
  assert.equal(viewport?.values.lookedAtBlock, null)
  assert.equal(typeof currentStatus?.readId, 'string')
  assert.equal(currentStatus?.source.kind, 'hud_projection')
  assert.deepEqual(result.omissions, [])
})

test('composePassiveObservations records an omission instead of throwing when access is denied', async () => {
  const runtime = buildRuntime(['current_status'])
  const result = await composePassiveObservations(runtime, {
    principalId: 'context-composer', grantId: 'grant-1', purpose: 'companion_context', correlationId: 'run-1',
  }, new AbortController().signal)
  assert.equal(result.reads.find(read => read.interfaceId === 'current_status')?.values.health, 20)
  assert.equal(result.reads.some(read => read.interfaceId === 'inventory_information'), false)
  assert.equal(result.omissions.some((omission) => omission.interfaceId === 'inventory_information' && omission.reason === 'audience_denied'), true)
  assert.equal(result.omissions.length, 3)
})
