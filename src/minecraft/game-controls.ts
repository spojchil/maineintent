import type { Bot } from 'mineflayer'
import pathfinderModule, { Movements } from 'mineflayer-pathfinder'
import { Vec3 } from 'vec3'
import type { BlockPosition, GameBlockTarget, GameThreat, MinecraftControlsApi, Vec3Value } from './contracts.js'

const HOSTILE_MOBS = new Set([
  'blaze', 'bogged', 'breeze', 'cave_spider', 'creeper', 'drowned', 'elder_guardian', 'enderman',
  'endermite', 'evoker', 'ghast', 'guardian', 'hoglin', 'husk', 'magma_cube', 'phantom', 'piglin_brute',
  'pillager', 'ravager', 'shulker', 'silverfish', 'skeleton', 'slime', 'spider', 'stray', 'vex',
  'vindicator', 'warden', 'witch', 'wither', 'wither_skeleton', 'zoglin', 'zombie', 'zombie_villager',
])
const { goals } = pathfinderModule

export class MineflayerGameControls implements MinecraftControlsApi {
  readonly #bot: Bot

  constructor(bot: Bot) { this.#bot = bot }

  findNearestBlock(names: readonly string[], maxDistance: number): GameBlockTarget | undefined {
    const ids = names.flatMap(name => {
      const block = this.#bot.registry.blocksByName[name]
      return block ? [block.id] : []
    })
    if (!ids.length) return undefined
    const block = this.#bot.findBlock({ matching: ids, maxDistance })
    return block ? { name: block.name, position: vector(block.position) } : undefined
  }

  async navigateNear(position: Vec3Value, range: number, signal: AbortSignal): Promise<void> {
    const movements = new Movements(this.#bot)
    movements.canDig = false
    movements.allow1by1towers = false
    this.#bot.pathfinder.setMovements(movements)
    await this.#goto(new goals.GoalNear(position.x, position.y, position.z, range), signal)
  }

  async navigateToPlayer(username: string, range: number, signal: AbortSignal): Promise<void> {
    const player = Object.values(this.#bot.players).find(candidate => candidate.username.toLocaleLowerCase() === username.toLocaleLowerCase())
    if (!player?.entity) throw new Error(`Player ${username} is not currently visible`)
    await this.navigateNear(vector(player.entity.position), range, signal)
  }

  async dig(position: BlockPosition, signal: AbortSignal): Promise<GameBlockTarget> {
    throwIfAborted(signal)
    const block = this.#bot.blockAt(new Vec3(position.x, position.y, position.z))
    if (!block || block.name === 'air') throw new Error('Target block is no longer present')
    if (!this.#bot.canDigBlock(block)) throw new Error(`Block ${block.name} is not reachable for digging`)
    const abort = () => this.#bot.stopDigging()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await this.#bot.dig(block, true)
      throwIfAborted(signal)
      return { name: block.name, position: vector(block.position) }
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }

  inventoryCount(names: readonly string[]): number {
    const accepted = new Set(names)
    return this.#bot.inventory.items().filter(item => accepted.has(item.name)).reduce((sum, item) => sum + item.count, 0)
  }

  nearestThreat(maxDistance: number): GameThreat | undefined {
    const origin = this.#bot.entity.position
    return Object.values(this.#bot.entities)
      .filter(entity => entity.isValid && entity.name && HOSTILE_MOBS.has(entity.name))
      .map(entity => ({ name: entity.name!, position: vector(entity.position), distance: origin.distanceTo(entity.position) }))
      .filter(threat => threat.distance <= maxDistance)
      .sort((left, right) => left.distance - right.distance)[0]
  }

  stop(): void {
    this.#bot.pathfinder.stop()
    this.#bot.stopDigging()
    this.#bot.clearControlStates()
  }

  async #goto(goal: InstanceType<typeof goals.Goal>, signal: AbortSignal): Promise<void> {
    throwIfAborted(signal)
    const abort = () => this.#bot.pathfinder.stop()
    signal.addEventListener('abort', abort, { once: true })
    try {
      await this.#bot.pathfinder.goto(goal)
      throwIfAborted(signal)
    } catch (error) {
      throwIfAborted(signal)
      throw error
    } finally {
      signal.removeEventListener('abort', abort)
    }
  }
}

function vector(value: { x: number; y: number; z: number }): Vec3Value {
  return { x: value.x, y: value.y, z: value.z }
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new DOMException(String(signal.reason ?? 'aborted'), 'AbortError')
}
