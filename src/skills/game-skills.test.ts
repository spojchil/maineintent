import assert from 'node:assert/strict'
import { test } from 'node:test'
import { ActionRuntime } from '../actions/index.js'
import type { GameBlockTarget, GameThreat, MinecraftControlsApi, Vec3Value } from '../minecraft/contracts.js'
import { collectWoodSkill } from './game-skills.js'

test('wood collection trusts verified pickup and does not pathfind into an already collected drop', async () => {
  const controls = new PickupControls()
  const runtime = new ActionRuntime()
  runtime.register(collectWoodSkill(() => controls))
  const submitted = await runtime.submit({ id: 'group', mode: 'atomic_preflight', actions: [{
    id: 'collect', skill: 'collect_wood', args: { count: 1, maxDistance: 16 }, purpose: 'test', after: [], onDependencyFailure: 'cancel',
  }] })
  assert.equal(submitted.accepted, true)
  if (!submitted.accepted) return
  const [result] = await submitted.completion
  assert.equal(result?.status, 'completed')
  assert.equal(controls.navigationCalls, 1)
  assert.equal(result?.verification?.observedEffects?.[0], 'wood_delta=1')
})

class PickupControls implements MinecraftControlsApi {
  wood = 0
  navigationCalls = 0
  findNearestBlock(): GameBlockTarget { return { name: 'oak_log', position: { x: 2, y: 64, z: 0 } } }
  async navigateNear(): Promise<void> { this.navigationCalls++ }
  async navigateToPlayer(): Promise<void> {}
  async dig(position: Vec3Value): Promise<GameBlockTarget> { this.wood++; return { name: 'oak_log', position } }
  inventoryCount(): number { return this.wood }
  nearestThreat(): GameThreat | undefined { return undefined }
  stop(): void {}
}
