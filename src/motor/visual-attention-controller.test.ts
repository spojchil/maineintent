import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { BehaviorPlanV1 } from '../behavior/index.js'
import { GroundedReferentStore, type GroundedTarget } from '../grounding/index.js'
import type {
  PerceptionBlock, PerceptionEntityCandidate, PerceptionPort, PerceptionPose,
} from '../information/index.js'
import type { MinecraftMotorDriverApi, MotorDigFeedback } from '../minecraft/index.js'
import { VisualAttentionController } from './visual-attention-controller.js'

const NOW = new Date('2026-07-22T00:00:00.000Z')

test('controller turns in bounded samples and verifies a grounded entity with new visual evidence', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const perception = new FakePerception(pose, [{
    entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 3, y: 64, z: -5 }, height: 1.8,
  }])
  const { store, handle } = grounded({
    kind: 'entity', entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 3, y: 64, z: -5 },
  })
  const motor = new FakeMotor(pose)
  const result = await controller(store, perception, motor).execute({ plan: plan(handle), signal: new AbortController().signal })
  assert.equal(result.status, 'completed')
  assert.equal(result.reasonCode, 'visual_attention_verified')
  assert.deepEqual(result.evidence.map(item => item.stage), [
    'commanded', 'motor_completed', 'perception_observed', 'outcome_verified',
  ])
  assert.ok(result.metrics.lookSamples >= 2)
  assert.ok(motor.calls.every((call, index) => index === 0 || angularDistance(call.yaw, motor.calls[index - 1]!.yaw) <= Math.PI / 12 + 1e-9))
  assert.deepEqual(result.observedTarget, { kind: 'entity', username: 'Alex' })
})

test('controller verifies the exact grounded block instead of accepting a motor completion', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: Math.PI / 2, pitch: 0 }
  const perception = new FakePerception(pose, [], new Map([['0,65,-4', opaque('oak_log')]]))
  const { store, handle } = grounded({ kind: 'block', name: 'oak_log', position: { x: 0, y: 65, z: -4 } })
  const result = await controller(store, perception, new FakeMotor(pose)).execute({
    plan: plan(handle), signal: new AbortController().signal,
  })
  assert.equal(result.status, 'completed')
  assert.deepEqual(result.observedTarget, { kind: 'block', name: 'oak_log' })

  perception.blocks.set('0,65,-4', opaque('stone'))
  const failed = await controller(store, perception, new FakeMotor(pose)).execute({
    plan: plan(handle), signal: new AbortController().signal,
  })
  assert.equal(failed.status, 'failed')
  assert.equal(failed.reasonCode, 'target_not_revalidated')
  assert.equal(failed.evidence.some(item => item.stage === 'outcome_verified'), false)
})

test('identity-only target is found by bounded visual scan, not by tracked coordinates', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const perception = new FakePerception(pose, [{
    entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 0, y: 64, z: 4 }, height: 1.8,
  }])
  const { store, handle } = grounded({ kind: 'identity', username: 'Alex' })
  const motor = new FakeMotor(pose)
  const input = plan(handle)
  input.steps[0].mode = 'bounded_scan_for_identity'
  const result = await controller(store, perception, motor).execute({ plan: input, signal: new AbortController().signal })
  assert.equal(result.status, 'completed')
  assert.ok(result.metrics.scanStops >= 1)
  assert.ok(result.metrics.lookSamples > 1)
  assert.deepEqual(result.observedTarget, { kind: 'identity', username: 'Alex' })
})

test('cancellation releases body input and never reports verified attention', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const perception = new FakePerception(pose, [{
    entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 3, y: 64, z: -5 }, height: 1.8,
  }])
  const { store, handle } = grounded({
    kind: 'entity', entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 3, y: 64, z: -5 },
  })
  const abort = new AbortController()
  const motor = new FakeMotor(pose, () => abort.abort('player_stop'))
  const result = await controller(store, perception, motor).execute({ plan: plan(handle), signal: abort.signal })
  assert.equal(result.status, 'cancelled')
  assert.equal(motor.releases, 1)
  assert.equal(result.evidence.some(item => item.stage === 'outcome_verified'), false)
})

test('controller deadline aborts a stalled motor primitive and fails without outcome evidence', async () => {
  const pose: PerceptionPose = { position: { x: 0, y: 64, z: 0 }, yaw: 0, pitch: 0 }
  const perception = new FakePerception(pose, [{
    entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 3, y: 64, z: -5 }, height: 1.8,
  }])
  const { store, handle } = grounded({
    kind: 'entity', entityKey: 'entity-alex', type: 'player', username: 'Alex', position: { x: 3, y: 64, z: -5 },
  })
  let releases = 0
  const stalled: MinecraftMotorDriverApi = {
    look: async (_yaw, _pitch, signal) => new Promise<void>((_resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
    }),
    dig: async () => { throw new Error('not used') },
    releaseAll: () => { releases++ },
  }
  const input = plan(handle)
  input.steps[0].maxDurationMs = 10
  const result = await controller(store, perception, stalled).execute({ plan: input, signal: new AbortController().signal })
  assert.equal(result.status, 'failed')
  assert.equal(result.reasonCode, 'controller_deadline')
  assert.equal(releases, 1)
  assert.equal(result.evidence.some(item => item.stage === 'outcome_verified'), false)
})

class FakePerception implements PerceptionPort {
  revision_ = 1
  constructor(
    readonly pose: PerceptionPose,
    readonly entities: PerceptionEntityCandidate[],
    readonly blocks = new Map<string, PerceptionBlock | 'unloaded'>(),
  ) {}
  selfPose(): PerceptionPose { return structuredClone(this.pose) }
  revision(): number { return this.revision_ }
  blockAt(position: { x: number; y: number; z: number }): PerceptionBlock | 'unloaded' {
    return this.blocks.get(`${position.x},${position.y},${position.z}`) ?? { name: 'air', visible: false, occludes: false }
  }
  nearbyEntities(): readonly PerceptionEntityCandidate[] { return this.entities }
}

class FakeMotor implements MinecraftMotorDriverApi {
  calls: Array<{ yaw: number; pitch: number }> = []
  releases = 0
  constructor(readonly pose: PerceptionPose, readonly afterLook?: () => void) {}
  async look(yaw: number, pitch: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    this.pose.yaw = yaw
    this.pose.pitch = pitch
    this.calls.push({ yaw, pitch })
    this.afterLook?.()
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
  }
  async dig(): Promise<MotorDigFeedback> { throw new Error('not used') }
  releaseAll(): void { this.releases++ }
}

function controller(store: GroundedReferentStore, perception: PerceptionPort, motor: MinecraftMotorDriverApi) {
  return new VisualAttentionController({
    targets: store, perception, motor, scope: () => ({ worldId: 'world', epoch: 3 }), now: () => NOW,
  })
}

function grounded(target: GroundedTarget) {
  const store = new GroundedReferentStore({ now: () => NOW })
  const record = store.issue({
    decisionRunId: 'run-1', effectId: 'embodied-1', role: 'subject', worldId: 'world', epoch: 3,
    validUntil: '2026-07-22T00:01:00.000Z', evidenceIds: ['viewport_3_1'], target,
  })
  return { store, handle: record.handle }
}

function plan(handle: string): BehaviorPlanV1 {
  return {
    protocol: 'mineintent.behavior-plan.v1', id: 'behavior-plan', decisionRunId: 'run-1', effectId: 'embodied-1',
    worldId: 'world', epoch: 3, createdAt: NOW.toISOString(), validUntil: '2026-07-22T00:00:30.000Z',
    interruptibility: 'immediate', resourceClaims: ['gaze'], steps: [{
      kind: 'visual_attention_control', stateId: 'state-attention', targetHandle: handle,
      mode: 'orient_to_grounded_target', maxDurationMs: 8_000,
    }],
  }
}

function opaque(name: string): PerceptionBlock { return { name, visible: true, occludes: true } }
function angularDistance(left: number, right: number): number {
  const delta = Math.abs(left - right) % (Math.PI * 2)
  return Math.min(delta, Math.PI * 2 - delta)
}
