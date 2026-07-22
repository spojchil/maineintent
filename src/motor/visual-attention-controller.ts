import type { BehaviorPlanV1 } from '../behavior/index.js'
import type { GroundedTarget } from '../grounding/index.js'
import { raycastLookedAtBlock, visibleEntities, type PerceptionPort } from '../information/index.js'
import type { MinecraftMotorDriverApi, Vec3Value } from '../minecraft/index.js'
import type {
  ControllerEvidence,
  GroundedTargetResolver,
  MotorControllerScope,
  VisualAttentionControllerRequest,
  VisualAttentionResult,
} from './contracts.js'

const MAX_VISUAL_DISTANCE = 32
const VIEW_HALF_ANGLE = (45 * Math.PI) / 180
const FOCUS_HALF_ANGLE = (4 * Math.PI) / 180
const MAX_YAW_SAMPLE = (15 * Math.PI) / 180
const MAX_PITCH_SAMPLE = (12 * Math.PI) / 180
const AIM_TOLERANCE = (1.5 * Math.PI) / 180
const SCAN_OFFSETS = [-Math.PI / 4, Math.PI / 4, -Math.PI / 2, Math.PI / 2, Math.PI] as const

export class VisualAttentionController {
  readonly #targets: GroundedTargetResolver
  readonly #perception: PerceptionPort
  readonly #motor: MinecraftMotorDriverApi
  readonly #scope: () => MotorControllerScope
  readonly #now: () => Date

  constructor(options: {
    targets: GroundedTargetResolver
    perception: PerceptionPort
    motor: MinecraftMotorDriverApi
    scope: () => MotorControllerScope
    now?: () => Date
  }) {
    this.#targets = options.targets
    this.#perception = options.perception
    this.#motor = options.motor
    this.#scope = options.scope
    this.#now = options.now ?? (() => new Date())
  }

  async execute(request: VisualAttentionControllerRequest): Promise<VisualAttentionResult> {
    const { plan, signal } = request
    const evidence: ControllerEvidence[] = []
    let lookSamples = 0
    let scanStops = 0
    const result = (
      status: VisualAttentionResult['status'],
      reasonCode: string,
      observedTarget?: VisualAttentionResult['observedTarget'],
    ): VisualAttentionResult => ({
      planId: plan.id,
      decisionRunId: plan.decisionRunId,
      effectId: plan.effectId,
      status,
      reasonCode,
      evidence,
      metrics: { lookSamples, scanStops },
      ...(observedTarget ? { observedTarget } : {}),
    })

    if (signal.aborted) return result('cancelled', 'cancelled_before_start')
    const currentScope = this.#scope()
    if (currentScope.worldId !== plan.worldId || currentScope.epoch !== plan.epoch) return result('failed', 'stale_plan_scope')
    const planExpiry = Date.parse(plan.validUntil)
    if (!Number.isFinite(planExpiry) || planExpiry <= this.#now().getTime()) return result('failed', 'stale_plan')
    const step = plan.steps[0]
    if (!Number.isSafeInteger(step.maxDurationMs) || step.maxDurationMs <= 0) return result('failed', 'invalid_controller_budget')
    const initial = this.#resolveTarget(plan, step.targetHandle)
    if (!initial) return result('failed', 'stale_grounded_target')

    const operationSignal = AbortSignal.any([signal, AbortSignal.timeout(step.maxDurationMs)])
    const deadline = this.#now().getTime() + step.maxDurationMs
    const ensureCurrent = () => {
      if (operationSignal.aborted) throw abortError(operationSignal.reason)
      const scope = this.#scope()
      if (scope.worldId !== plan.worldId || scope.epoch !== plan.epoch) throw new ControllerFailure('scope_changed')
      if (this.#now().getTime() >= deadline) throw new ControllerFailure('controller_deadline')
      const target = this.#resolveTarget(plan, step.targetHandle)
      if (!target) throw new ControllerFailure('stale_grounded_target')
      return target
    }
    const command = async (yaw: number, pitch: number) => {
      ensureCurrent()
      if (evidence.every(item => item.stage !== 'commanded')) evidence.push(this.#evidence('commanded', plan, 'gaze_commanded'))
      await this.#motor.look(normalizeYaw(yaw), clampPitch(pitch), operationSignal)
      lookSamples++
    }

    try {
      let observed: VisualAttentionResult['observedTarget']
      if (step.mode === 'orient_to_grounded_target') {
        const locate = () => this.#locateKnownTarget(ensureCurrent().target)?.aimPosition
        const located = locate()
        if (!located) return result('failed', 'target_not_revalidated')
        await this.#orientTo(locate, command, ensureCurrent)
        evidence.push(this.#evidence('motor_completed', plan, 'gaze_motor_completed'))
        observed = this.#verifyTarget(ensureCurrent().target)
      } else {
        if (initial.target.kind !== 'identity') return result('failed', 'scan_requires_identity_target')
        const targetUsername = initial.target.username
        const startYaw = this.#perception.selfPose().yaw
        let visible = this.#findVisibleIdentity(targetUsername)
        for (const offset of SCAN_OFFSETS) {
          if (visible) break
          scanStops++
          await this.#orientYaw(normalizeYaw(startYaw + offset), command, ensureCurrent, () => {
            visible = this.#findVisibleIdentity(targetUsername)
            return Boolean(visible)
          })
          visible = this.#findVisibleIdentity(targetUsername)
        }
        if (!visible) return result('failed', 'scan_exhausted')
        await this.#orientTo(
          () => this.#findVisibleIdentity(targetUsername)?.aimPosition,
          command,
          ensureCurrent,
        )
        evidence.push(this.#evidence('motor_completed', plan, 'gaze_motor_completed'))
        observed = this.#verifyTarget(initial.target)
      }
      if (!observed) return result('failed', 'visual_target_not_confirmed')
      const perceptionEvidence = this.#evidence('perception_observed', plan, 'visual_target_observed')
      evidence.push(perceptionEvidence)
      evidence.push({
        stage: 'outcome_verified', at: this.#now().toISOString(),
        evidenceIds: [...perceptionEvidence.evidenceIds],
      })
      return result('completed', 'visual_attention_verified', observed)
    } catch (error) {
      if (signal.aborted) {
        this.#motor.releaseAll()
        return result('cancelled', 'controller_cancelled')
      }
      if (operationSignal.aborted || (error instanceof DOMException && error.name === 'TimeoutError')) {
        this.#motor.releaseAll()
        return result('failed', 'controller_deadline')
      }
      if (error instanceof DOMException && error.name === 'AbortError') return result('failed', 'motor_aborted')
      if (error instanceof ControllerFailure) return result('failed', error.code)
      return result('failed', 'motor_failed')
    }
  }

  #resolveTarget(plan: BehaviorPlanV1, handle: string) {
    return this.#targets.resolve({
      handle,
      decisionRunId: plan.decisionRunId,
      effectId: plan.effectId,
      worldId: plan.worldId,
      epoch: plan.epoch,
    })
  }

  #locateKnownTarget(target: GroundedTarget): { aimPosition: Vec3Value } | undefined {
    if (target.kind === 'block') {
      const current = this.#perception.blockAt(target.position)
      if (current === 'unloaded' || !current.visible || current.name !== target.name) return undefined
      return { aimPosition: { x: target.position.x + 0.5, y: target.position.y + 0.5, z: target.position.z + 0.5 } }
    }
    if (target.kind === 'entity') {
      const visible = visibleEntities(this.#perception, MAX_VISUAL_DISTANCE, VIEW_HALF_ANGLE, Number.MAX_SAFE_INTEGER)
        .find(entity => entity.entityKey === target.entityKey)
      return visible ? { aimPosition: visible.aimPosition } : undefined
    }
    return undefined
  }

  #findVisibleIdentity(username: string, halfAngle = VIEW_HALF_ANGLE) {
    const normalized = username.toLocaleLowerCase()
    return visibleEntities(this.#perception, MAX_VISUAL_DISTANCE, halfAngle, Number.MAX_SAFE_INTEGER)
      .find(entity => entity.username?.toLocaleLowerCase() === normalized)
  }

  #verifyTarget(target: GroundedTarget): VisualAttentionResult['observedTarget'] | undefined {
    if (target.kind === 'block') {
      const hit = raycastLookedAtBlock(this.#perception, MAX_VISUAL_DISTANCE)
      return hit && samePosition(hit.position, target.position)
        ? { kind: 'block', name: hit.name }
        : undefined
    }
    const visible = target.kind === 'entity'
      ? visibleEntities(this.#perception, MAX_VISUAL_DISTANCE, FOCUS_HALF_ANGLE, Number.MAX_SAFE_INTEGER)
        .find(entity => entity.entityKey === target.entityKey)
      : this.#findVisibleIdentity(target.username, FOCUS_HALF_ANGLE)
    if (!visible) return undefined
    return {
      kind: target.kind,
      ...(visible.name ? { name: visible.name } : {}),
      ...(visible.username ? { username: visible.username } : {}),
    }
  }

  async #orientTo(
    locate: () => Vec3Value | undefined,
    command: (yaw: number, pitch: number) => Promise<void>,
    ensureCurrent: () => unknown,
  ): Promise<void> {
    for (let sample = 0; sample < 64; sample++) {
      ensureCurrent()
      const target = locate()
      if (!target) throw new ControllerFailure('target_lost_during_orientation')
      const pose = this.#perception.selfPose()
      const desired = anglesTo(pose.position, target)
      const yawDelta = shortestYawDelta(pose.yaw, desired.yaw)
      const pitchDelta = desired.pitch - pose.pitch
      if (Math.abs(yawDelta) <= AIM_TOLERANCE && Math.abs(pitchDelta) <= AIM_TOLERANCE) return
      await command(
        pose.yaw + clamp(yawDelta, -MAX_YAW_SAMPLE, MAX_YAW_SAMPLE),
        pose.pitch + clamp(pitchDelta, -MAX_PITCH_SAMPLE, MAX_PITCH_SAMPLE),
      )
    }
    throw new ControllerFailure('orientation_sample_limit')
  }

  async #orientYaw(
    targetYaw: number,
    command: (yaw: number, pitch: number) => Promise<void>,
    ensureCurrent: () => unknown,
    acquired: () => boolean,
  ): Promise<void> {
    for (let sample = 0; sample < 32; sample++) {
      ensureCurrent()
      const pose = this.#perception.selfPose()
      const delta = shortestYawDelta(pose.yaw, targetYaw)
      if (Math.abs(delta) <= AIM_TOLERANCE) return
      await command(pose.yaw + clamp(delta, -MAX_YAW_SAMPLE, MAX_YAW_SAMPLE), pose.pitch)
      if (acquired()) return
    }
    throw new ControllerFailure('scan_sample_limit')
  }

  #evidence(stage: ControllerEvidence['stage'], plan: BehaviorPlanV1, label: string): ControllerEvidence {
    return {
      stage,
      at: this.#now().toISOString(),
      evidenceIds: [`${label}_${plan.id}_${this.#perception.revision()}`],
    }
  }
}

class ControllerFailure extends Error {
  constructor(readonly code: string) { super(code) }
}

function anglesTo(origin: Vec3Value, target: Vec3Value): { yaw: number; pitch: number } {
  const dx = target.x - origin.x
  const dy = target.y - (origin.y + 1.62)
  const dz = target.z - origin.z
  return { yaw: Math.atan2(-dx, -dz), pitch: Math.atan2(dy, Math.hypot(dx, dz)) }
}

function shortestYawDelta(from: number, to: number): number {
  let delta = (to - from) % (Math.PI * 2)
  if (delta > Math.PI) delta -= Math.PI * 2
  if (delta < -Math.PI) delta += Math.PI * 2
  return delta
}

function normalizeYaw(value: number): number {
  let normalized = value % (Math.PI * 2)
  if (normalized > Math.PI) normalized -= Math.PI * 2
  if (normalized < -Math.PI) normalized += Math.PI * 2
  return normalized
}

function clampPitch(value: number): number { return clamp(value, -Math.PI / 2, Math.PI / 2) }
function clamp(value: number, minimum: number, maximum: number): number { return Math.max(minimum, Math.min(maximum, value)) }
function samePosition(left: Vec3Value, right: Vec3Value): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z
}
function abortError(reason: unknown): DOMException { return new DOMException(String(reason ?? 'aborted'), 'AbortError') }
