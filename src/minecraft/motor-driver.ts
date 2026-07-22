import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import type { BlockPosition, MinecraftMotorDriverApi, MotorDigFeedback } from './contracts.js'

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
