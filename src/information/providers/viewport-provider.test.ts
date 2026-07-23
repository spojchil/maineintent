import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PerceptionBlock, PerceptionEntityCandidate, PerceptionPort, PerceptionPose } from '../source-ports/perception.js'
import { assertInformationProviderContract } from '../testing/provider-contract.js'
import { ViewportInformationProvider } from './viewport-provider.js'

class FakePerceptionPort implements PerceptionPort {
  sourceRevision = 1
  constructor(
    public pose: PerceptionPose,
    private blocks: Map<string, PerceptionBlock | 'unloaded'>,
    private entities: PerceptionEntityCandidate[] = [],
  ) {}
  selfPose(): PerceptionPose { return this.pose }
  revision(): number { return this.sourceRevision }
  blockAt(position: PerceptionPose['position']): PerceptionBlock | 'unloaded' {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? air()
  }
  nearbyEntities(): readonly PerceptionEntityCandidate[] { return this.entities }
}

function air(): PerceptionBlock { return { name: 'air', visible: false, occludes: false } }
function opaque(name: string): PerceptionBlock { return { name, visible: true, occludes: true } }
function transparent(name: string): PerceptionBlock { return { name, visible: true, occludes: false } }

function context() {
  let refIndex = 0
  return {
    now: new Date().toISOString(),
    scope: { processSessionId: 's', connectionState: 'play' as const, connectionEpoch: 1, uiRevision: 0, capturedAt: new Date().toISOString() },
    caller: { audience: 'companion' as const, purpose: 'companion_context' as const },
    refs: { issue: (request: { basedOnInformationRevision: number; validUntil?: string }) => ({
      protocol: 'mineintent.information-selector-ref.v1' as const,
      id: `iref_test_${++refIndex}`,
      interfaceId: 'viewport_information' as const,
      connectionEpoch: 1,
      basedOnInformationRevision: request.basedOnInformationRevision,
      ...(request.validUntil ? { validUntil: request.validUntil } : {}),
    }) },
  }
}

const NORTH_POSE: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }

test('viewport provider satisfies the provider contract', async () => {
  const provider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, new Map()))
  await assertInformationProviderContract(provider, {
    context: context(), request: { fields: ['standingOnBlock', 'lookedAtBlock', 'visibleEntities', 'visibleBlocks'], page: { limit: 1 } },
  })
})

test('viewport provider emits opaque references with view-relative visible blocks', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([['0,65,-3', opaque('stone')]])
  const provider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, blocks))
  const result = await provider.read(context(), { fields: ['visibleBlocks'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.visibleBlocks?.truncated, false)
  assert.deepEqual(result.values.visibleBlocks?.blocks[0], {
    ref: 'iref_test_1', relativePosition: [0, 1, 3], name: 'stone',
  })
})

test('viewport provider returns at most 256 visible block records', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>()
  for (let x = -10; x <= 10; x++) {
    for (let y = 60; y <= 72; y++) blocks.set(`${x},${y},-20`, transparent('glass'))
  }
  const provider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, blocks))
  const result = await provider.read(context(), { fields: ['visibleBlocks'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.visibleBlocks?.blocks.length, 256)
  assert.equal(result.values.visibleBlocks?.truncated, true)
})

test('viewport provider reports the inferred block directly underfoot', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([['0,63,0', opaque('grass_block')]])
  const provider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, blocks))
  const result = await provider.read(context(), { fields: ['standingOnBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.deepEqual(result.values.standingOnBlock, {
    ref: 'iref_test_1', name: 'grass_block', relativePosition: [0, -1, 0],
  })
})

test('viewport provider reports standingOnBlock as null for unloaded or air', async () => {
  const unloaded = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, new Map([['0,63,0', 'unloaded']])))
  const airProvider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, new Map()))
  assert.equal((await unloaded.read(context(), { fields: ['standingOnBlock'], page: { limit: 1 } }, new AbortController().signal)).values.standingOnBlock, null)
  assert.equal((await airProvider.read(context(), { fields: ['standingOnBlock'], page: { limit: 1 } }, new AbortController().signal)).values.standingOnBlock, null)
})

test('viewport provider finds the nearest visible block along the sightline', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([['0,65,-3', opaque('stone')]])
  const provider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, blocks))
  const result = await provider.read(context(), { fields: ['lookedAtBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.lookedAtBlock?.name, 'stone')
  assert.deepEqual(result.values.lookedAtBlock?.relativePosition, [0, 1, 3])
})

test('viewport provider reports null for air or unloaded sightlines', async () => {
  const airProvider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, new Map()))
  const unloaded = new Map<string, PerceptionBlock | 'unloaded'>()
  for (let z = 0; z >= -6; z--) unloaded.set(`0,65,${z}`, 'unloaded')
  const unloadedProvider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, unloaded))
  assert.equal((await airProvider.read(context(), { fields: ['lookedAtBlock'], page: { limit: 1 } }, new AbortController().signal)).values.lookedAtBlock, null)
  assert.equal((await unloadedProvider.read(context(), { fields: ['lookedAtBlock'], page: { limit: 1 } }, new AbortController().signal)).values.lookedAtBlock, null)
})

test('viewport provider publishes only entities that pass FOV and occlusion', async () => {
  const entities: PerceptionEntityCandidate[] = [
    { entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: -2, y: 64, z: -4 }, height: 1.8 },
    { entityKey: 'entity-zombie', type: 'zombie', position: { x: 0, y: 64, z: -10 }, height: 1.95 },
    { entityKey: 'entity-cow', type: 'cow', position: { x: 0, y: 64, z: 3 }, height: 1.4 },
  ]
  const wall = new Map<string, PerceptionBlock | 'unloaded'>([
    ['0,64,-3', opaque('stone')], ['0,65,-3', opaque('stone')], ['0,66,-3', opaque('stone')],
  ])
  const provider = new ViewportInformationProvider(new FakePerceptionPort(NORTH_POSE, wall, entities))
  const result = await provider.read(context(), { fields: ['visibleEntities'], page: { limit: 1 } }, new AbortController().signal)
  assert.deepEqual(result.values.visibleEntities?.map(entity => entity.username ?? entity.type), ['Alex'])
  assert.deepEqual(result.values.visibleEntities?.[0]?.relativePosition, [-2, 0, 4])
})

test('viewport revision changes when the perception source changes without a pose change', () => {
  const port = new FakePerceptionPort(NORTH_POSE, new Map())
  const provider = new ViewportInformationProvider(port)
  const before = provider.availability().informationRevision
  port.sourceRevision++
  assert.equal(provider.availability().informationRevision, before + 1)
})
