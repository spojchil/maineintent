import type { Bot, ControlState } from 'mineflayer'
import { Vec3 } from 'vec3'
import type {
  BlockPosition,
  MinecraftMotorDriverApi,
  MotorDigFeedback,
  MotorMoveDirection,
} from './contracts.js'

const MAX_RELATIVE_LOOK_DEGREES = 90
const MIN_MOVE_DURATION_MS = 50
const MAX_MOVE_DURATION_MS = 1_500
const MOVE_DIRECTIONS = new Set<MotorMoveDirection>(['forward', 'back', 'left', 'right'])

export class MineflayerMotorDriver implements MinecraftMotorDriverApi {
  readonly #bot: Bot

  constructor(bot: Bot) { this.#bot = bot }

  async look(yaw: number, pitch: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    if (![yaw, pitch].every(Number.isFinite)) throw new TypeError('Look target must be finite')
    if (pitch < -Math.PI / 2 || pitch > Math.PI / 2) throw new RangeError('Look pitch is outside the legal range')
    await raceAbort(this.#bot.look(yaw, pitch, false), signal)
    throwIfAborted(signal)
  }

  async lookRelative(yawDegrees: number, pitchDegrees: number, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    validateRelativeAngle(yawDegrees, 'yaw')
    validateRelativeAngle(pitchDegrees, 'pitch')
    const currentYaw = this.#bot.entity.yaw
    const currentPitch = this.#bot.entity.pitch
    if (![currentYaw, currentPitch].every(Number.isFinite)) throw new TypeError('Current look pose must be finite')

    // Mineflayer yaw grows to the player's left and pitch grows upward. The experimental tool
    // deliberately exposes the familiar mouse convention instead: right/down are positive.
    const targetYaw = normalizeYaw(currentYaw - degreesToRadians(yawDegrees))
    const targetPitch = clamp(currentPitch - degreesToRadians(pitchDegrees), -Math.PI / 2, Math.PI / 2)
    await this.look(targetYaw, targetPitch, signal)
  }

  async move(
    direction: MotorMoveDirection,
    durationMs: number,
    sprint: boolean | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    throwIfAborted(signal)
    if (!MOVE_DIRECTIONS.has(direction)) throw new TypeError('Move direction is not supported')
    if (!Number.isSafeInteger(durationMs) || durationMs < MIN_MOVE_DURATION_MS || durationMs > MAX_MOVE_DURATION_MS) {
      throw new RangeError(`Move duration must be an integer from ${MIN_MOVE_DURATION_MS} to ${MAX_MOVE_DURATION_MS} ms`)
    }
    if (sprint !== undefined && typeof sprint !== 'boolean') throw new TypeError('Sprint must be a boolean')

    const pressed: ControlState[] = []
    try {
      pressed.push(direction)
      this.#bot.setControlState(direction, true)
      if (sprint) {
        pressed.push('sprint')
        this.#bot.setControlState('sprint', true)
      }
      await abortableDelay(durationMs, signal)
      throwIfAborted(signal)
    } finally {
      for (const control of pressed.reverse()) {
        try { this.#bot.setControlState(control, false) } catch { this.#bot.clearControlStates() }
      }
    }
  }

  async dig(position: BlockPosition, signal: AbortSignal): Promise<MotorDigFeedback> {
    throwIfAborted(signal)
    const block = this.#bot.blockAt(new Vec3(position.x, position.y, position.z))
    if (!block || block.name === 'air') throw new Error('Target block is no longer present')
    if (!this.#bot.canDigBlock(block)) throw new Error(`Block ${block.name} is not reachable for digging`)
    const abort = () => this.#bot.stopDigging()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await this.#bot.dig(block, true)
      throwIfAborted(signal)
      return {
        stage: 'client_predicted',
        name: block.name,
        position: { x: block.position.x, y: block.position.y, z: block.position.z },
      }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  releaseAll(): void {
    this.#bot.stopDigging()
    this.#bot.clearControlStates()
  }
}

async function raceAbort<T>(operation: Promise<T>, signal: AbortSignal): Promise<T> {
  let rejectAbort!: (reason: unknown) => void
  const aborted = new Promise<never>((_resolve, reject) => { rejectAbort = reject })
  const onAbort = () => rejectAbort(abortError(signal.reason))
  signal.addEventListener('abort', onAbort, { once: true })
  try {
    return await Promise.race([operation, aborted])
  } finally {
    signal.removeEventListener('abort', onAbort)
  }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal.reason)
}

function abortError(reason: unknown): DOMException {
  return new DOMException(String(reason ?? 'aborted'), 'AbortError')
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(finish, ms)
    const onAbort = () => finish(abortError(signal.reason))
    signal.addEventListener('abort', onAbort, { once: true })
    if (signal.aborted) onAbort()

    function finish(error?: DOMException): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
      if (error) reject(error)
      else resolve()
    }
  })
}

function validateRelativeAngle(value: number, name: 'yaw' | 'pitch'): void {
  if (!Number.isFinite(value)) throw new TypeError(`Relative ${name} must be finite`)
  if (Math.abs(value) > MAX_RELATIVE_LOOK_DEGREES) {
    throw new RangeError(`Relative ${name} must be within ±${MAX_RELATIVE_LOOK_DEGREES} degrees`)
  }
}

function degreesToRadians(value: number): number { return (value * Math.PI) / 180 }
function clamp(value: number, minimum: number, maximum: number): number {
  return Math.max(minimum, Math.min(maximum, value))
}
function normalizeYaw(value: number): number {
  let normalized = value % (Math.PI * 2)
  if (normalized > Math.PI) normalized -= Math.PI * 2
  if (normalized < -Math.PI) normalized += Math.PI * 2
  return normalized
}
