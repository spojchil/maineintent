import assert from 'node:assert/strict'
import { test } from 'node:test'
import { raycastLookedAtBlock, standingOnBlock, visibleBlocks } from './perception.js'
import type { PerceptionBlock, PerceptionPort, PerceptionPose } from './perception.js'

class FakePerceptionPort implements PerceptionPort {
  constructor(
    public pose: PerceptionPose,
    private blocks: Map<string, PerceptionBlock | 'unloaded'> = new Map(),
  ) {}
  selfPose(): PerceptionPose { return this.pose }
  blockAt(position: PerceptionPose['position']): PerceptionBlock | 'unloaded' {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? { name: 'air', solid: false }
  }
  nearbyEntities() { return [] }
}

const DEFAULT_OPTIONS = { horizontalRadius: 8, verticalRadius: 4, maxDistance: 10, halfAngle: (35 * Math.PI) / 180, limit: 24 }
function solid(name: string): PerceptionBlock { return { name, solid: true } }

test('visibleBlocks includes an exposed, unoccluded block directly ahead', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map([['0,65,-3', solid('stone')]])
  const result = visibleBlocks(new FakePerceptionPort(pose, blocks), DEFAULT_OPTIONS)
  assert.equal(result.truncated, false)
  assert.equal(result.blocks.length, 1)
  assert.deepEqual(result.blocks[0]!.offset, { x: 0, y: 1, z: -3 })
  assert.equal(result.blocks[0]!.name, 'stone')
})

test('visibleBlocks excludes a block fully enclosed by solid neighbors (layer 1)', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map([
    ['1,65,-6', solid('stone')],
    ['2,65,-6', solid('stone')], ['0,65,-6', solid('stone')],
    ['1,66,-6', solid('stone')], ['1,64,-6', solid('stone')],
    ['1,65,-5', solid('stone')], ['1,65,-7', solid('stone')],
  ])
  const result = visibleBlocks(new FakePerceptionPort(pose, blocks), DEFAULT_OPTIONS)
  assert.equal(result.blocks.some((block) => block.offset.x === 1 && block.offset.y === 1 && block.offset.z === -6), false)
})

test('visibleBlocks excludes an exposed block outside the view cone (layer 2)', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map([['0,65,6', solid('stone')]]) // directly behind, facing is -z
  const result = visibleBlocks(new FakePerceptionPort(pose, blocks), DEFAULT_OPTIONS)
  assert.equal(result.blocks.length, 0)
})

test('visibleBlocks excludes a block occluded by a nearer solid block on the same ray (layer 3)', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map([
    ['0,65,-3', solid('stone')], // nearer occluder, directly ahead
    ['0,65,-9', solid('deepslate')], // farther target, same line — should be hidden behind the occluder
  ])
  const result = visibleBlocks(new FakePerceptionPort(pose, blocks), DEFAULT_OPTIONS)
  assert.equal(result.blocks.length, 1)
  assert.equal(result.blocks[0]!.name, 'stone')
})

test('visibleBlocks sorts by distance and marks the list truncated past the limit', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  // Two separate, non-occluding blocks within the cone at different distances (verified not
  // to share a ray path: 'nearest' occupies x:[0,1], 'farther' is well clear on the other side).
  const blocks = new Map([
    ['0,65,-2', solid('nearest')],
    ['-3,65,-6', solid('farther')],
  ])
  const port = new FakePerceptionPort(pose, blocks)
  const full = visibleBlocks(port, DEFAULT_OPTIONS)
  assert.equal(full.truncated, false)
  assert.equal(full.blocks.length, 2)
  assert.equal(full.blocks[0]!.name, 'nearest')

  const limited = visibleBlocks(port, { ...DEFAULT_OPTIONS, limit: 1 })
  assert.equal(limited.truncated, true)
  assert.equal(limited.blocks.length, 1)
  assert.equal(limited.blocks[0]!.name, 'nearest')
})

test('visibleBlocks stops scanning cleanly when candidates are unloaded (no throw)', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([['0,65,-3', 'unloaded']])
  const result = visibleBlocks(new FakePerceptionPort(pose, blocks), DEFAULT_OPTIONS)
  assert.equal(result.blocks.length, 0)
})

test('raycastLookedAtBlock and standingOnBlock still behave as before (regression)', () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const port = new FakePerceptionPort(pose, new Map([['0,65,-3', solid('stone')], ['0,63,0', solid('grass_block')]]))
  assert.equal(raycastLookedAtBlock(port, 4.5)?.name, 'stone')
  assert.deepEqual(standingOnBlock(port), { name: 'grass_block' })
})
