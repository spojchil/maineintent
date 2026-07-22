import assert from 'node:assert/strict'
import { setImmediate } from 'node:timers'
import { test } from 'node:test'
import {
  raycastLookedAtBlock, standingOnBlock, viewRelativePosition, visibleBlocks, visibleEntities,
  type PerceptionBlock, type PerceptionEntityCandidate, type PerceptionPort, type PerceptionPose,
} from './perception.js'

class FakePerceptionPort implements PerceptionPort {
  sourceRevision = 1
  constructor(
    public pose: PerceptionPose,
    private blocks: Map<string, PerceptionBlock | 'unloaded'> = new Map(),
    private entities: PerceptionEntityCandidate[] = [],
  ) {}
  selfPose(): PerceptionPose { return this.pose }
  revision(): number { return this.sourceRevision }
  blockAt(position: PerceptionPose['position']): PerceptionBlock | 'unloaded' {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? air()
  }
  nearbyEntities(): readonly PerceptionEntityCandidate[] { return this.entities }
}

const POSE: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
const OPTIONS = { horizontalRadius: 8, verticalRadius: 4, maxDistance: 10, halfAngle: (45 * Math.PI) / 180, limit: 24 }
function air(): PerceptionBlock { return { name: 'air', visible: false, occludes: false } }
function opaque(name: string): PerceptionBlock { return { name, visible: true, occludes: true } }
function transparent(name: string): PerceptionBlock { return { name, visible: true, occludes: false } }

test('visibleBlocks includes an exposed, unoccluded block directly ahead', async () => {
  const result = await visibleBlocks(new FakePerceptionPort(POSE, new Map([['0,65,-3', opaque('stone')]])), OPTIONS)
  assert.equal(result.truncated, false)
  assert.deepEqual(result.blocks[0]?.offset, { x: 0, y: 1, z: -3 })
})

test('visibleBlocks excludes enclosed, outside-FOV and occluded blocks', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([
    ['1,65,-6', opaque('enclosed')],
    ['2,65,-6', opaque('stone')], ['0,65,-6', opaque('stone')], ['1,66,-6', opaque('stone')],
    ['1,64,-6', opaque('stone')], ['1,65,-5', opaque('stone')], ['1,65,-7', opaque('stone')],
    ['0,65,6', opaque('behind')],
    ['0,65,-3', opaque('occluder')], ['0,65,-9', opaque('hidden')],
  ])
  const result = await visibleBlocks(new FakePerceptionPort(POSE, blocks), OPTIONS)
  assert.equal(result.blocks.some(block => ['enclosed', 'behind', 'hidden'].includes(block.name)), false)
  assert.equal(result.blocks.some(block => block.name === 'occluder'), true)
})

test('transparent visible blocks do not hide farther surfaces', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([
    ['0,65,-3', transparent('glass')], ['0,65,-6', opaque('stone')],
  ])
  const result = await visibleBlocks(new FakePerceptionPort(POSE, blocks), OPTIONS)
  assert.deepEqual(result.blocks.map(block => block.name), ['glass', 'stone'])
})

test('visibleBlocks sorts, truncates and treats unloaded terrain as unknown', async () => {
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([
    ['0,65,-2', opaque('nearest')], ['-3,65,-6', opaque('farther')], ['2,65,-4', 'unloaded'],
  ])
  const port = new FakePerceptionPort(POSE, blocks)
  const full = await visibleBlocks(port, OPTIONS)
  assert.deepEqual(full.blocks.map(block => block.name), ['nearest', 'farther'])
  const limited = await visibleBlocks(port, { ...OPTIONS, limit: 1 })
  assert.equal(limited.truncated, true)
  assert.deepEqual(limited.blocks.map(block => block.name), ['nearest'])
})

test('visibleBlocks yields to cancellation during a large scan', async () => {
  const controller = new AbortController()
  setImmediate(() => controller.abort('superseded'))
  await assert.rejects(
    visibleBlocks(new FakePerceptionPort(POSE), { ...OPTIONS, horizontalRadius: 32, verticalRadius: 20 }, controller.signal),
    error => error === 'superseded',
  )
})

test('visibleEntities excludes targets behind the view or an opaque wall', () => {
  const entities: PerceptionEntityCandidate[] = [
    { entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: -2, y: 64, z: -4 }, height: 1.8 },
    { entityKey: 'entity-zombie', type: 'zombie', position: { x: 0, y: 64, z: -8 }, height: 1.95 },
    { entityKey: 'entity-cow', type: 'cow', position: { x: 0, y: 64, z: 3 }, height: 1.4 },
  ]
  const blocks = new Map<string, PerceptionBlock | 'unloaded'>([
    ['0,64,-3', opaque('wall')], ['0,65,-3', opaque('wall')], ['0,66,-3', opaque('wall')],
  ])
  const result = visibleEntities(new FakePerceptionPort(POSE, blocks, entities), 32, Math.PI / 4, 10)
  assert.deepEqual(result.map(entity => entity.username ?? entity.type), ['Alex'])
})

test('viewRelativePosition is pose-relative and quantized rather than a world coordinate', () => {
  assert.deepEqual(viewRelativePosition(POSE, { x: -2.24, y: 64.26, z: -3.76 }), [-2, 0.5, 4])
  assert.deepEqual(viewRelativePosition({ ...POSE, yaw: -Math.PI / 2 }, { x: 3.24, y: 64, z: 0.24 }), [0, 0, 3])
})

test('raycast and standingOnBlock use visible blocks rather than air', () => {
  const port = new FakePerceptionPort(POSE, new Map([
    ['0,65,-3', transparent('glass')], ['0,63,0', opaque('grass_block')],
  ]))
  assert.equal(raycastLookedAtBlock(port, 4.5)?.name, 'glass')
  assert.deepEqual(standingOnBlock(port), { name: 'grass_block', position: { x: 0, y: 63, z: 0 } })
  assert.equal(standingOnBlock(new FakePerceptionPort(POSE)), null)
})
