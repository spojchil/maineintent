import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { PerceptionBlock, PerceptionEntityCandidate, PerceptionPort, PerceptionPose } from '../source-ports/perception.js'
import { assertInformationProviderContract } from '../testing/provider-contract.js'
import { ViewportInformationProvider } from './viewport-provider.js'

class FakePerceptionPort implements PerceptionPort {
  constructor(
    public pose: PerceptionPose,
    private blocks: Map<string, PerceptionBlock | 'unloaded'>,
    private entities: PerceptionEntityCandidate[] = [],
  ) {}
  selfPose(): PerceptionPose { return this.pose }
  blockAt(position: PerceptionPose['position']): PerceptionBlock | 'unloaded' {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? { name: 'air', solid: false }
  }
  nearbyEntities(): readonly PerceptionEntityCandidate[] { return this.entities }
}

function context() {
  return {
    now: new Date().toISOString(),
    scope: { processSessionId: 's', connectionState: 'play' as const, connectionEpoch: 1, uiRevision: 0, capturedAt: new Date().toISOString() },
    caller: { audience: 'companion' as const, purpose: 'companion_context' as const },
    refs: { issue: () => { throw new Error('not used') } },
  }
}

test('viewport provider satisfies the provider contract', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, new Map()))
  await assertInformationProviderContract(provider, { context: context(), request: { fields: ['standingOnBlock', 'lookedAtBlock', 'nearbyTrackedEntities'], page: { limit: 1 } } })
})

test('viewport provider reports the block directly underfoot', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([['0,63,0', { name: 'grass_block', solid: true }]])
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, blocks))
  const result = await provider.read(context(), { fields: ['standingOnBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.deepEqual(result.values.standingOnBlock, { name: 'grass_block' })
})

test('viewport provider reports standingOnBlock as null when underfoot is unloaded', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, new Map([['0,63,0', 'unloaded']])))
  const result = await provider.read(context(), { fields: ['standingOnBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.standingOnBlock, null)
})

test('viewport provider finds the nearest solid block along the sightline', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([['0,65,3', { name: 'stone', solid: true }]])
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, blocks))
  const result = await provider.read(context(), { fields: ['lookedAtBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.lookedAtBlock?.name, 'stone')
})

test('viewport provider reports null when the sightline is all air within range', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, new Map()))
  const result = await provider.read(context(), { fields: ['lookedAtBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.lookedAtBlock, null)
})

test('viewport provider stops at unloaded terrain instead of guessing past it', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>()
  for (let z = 0; z <= 6; z++) blocks.set(`0,65,${z}`, 'unloaded')
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, blocks))
  const result = await provider.read(context(), { fields: ['lookedAtBlock'], page: { limit: 1 } }, new AbortController().signal)
  assert.equal(result.values.lookedAtBlock, null)
})

test('viewport provider sorts nearby tracked entities by distance and bounds the list', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const entities: PerceptionEntityCandidate[] = [
    { type: 'zombie', position: { x: 0, y: 64, z: 10 } },
    { type: 'player', username: 'Alex', position: { x: 0, y: 64, z: 2 } },
    { type: 'cow', position: { x: 0, y: 64, z: 30 } },
  ]
  const provider = new ViewportInformationProvider(new FakePerceptionPort(pose, new Map(), entities))
  const result = await provider.read(context(), { fields: ['nearbyTrackedEntities'], page: { limit: 1 } }, new AbortController().signal)
  const list = result.values.nearbyTrackedEntities!
  assert.equal(list.length, 2)
  assert.equal(list[0]!.username, 'Alex')
  assert.equal(list[0]!.direction, 'ahead')
  assert.equal(list[1]!.type, 'zombie')
})
