import type { EventEmitter } from 'node:events'

export interface VectorLike { x: number; y: number; z: number }

export interface ItemLike {
  name?: string
  count?: number
  metadata?: number
  durabilityUsed?: number
}

export interface EntityLike {
  id: number
  type?: string
  name?: string
  username?: string
  uuid?: string
  position: VectorLike
  velocity?: VectorLike
  yaw?: number
  pitch?: number
  headYaw?: number
  width?: number
  height?: number
  onGround?: boolean
  pose?: string
  heldItem?: ItemLike | null
  equipment?: Array<ItemLike | null | undefined>
  isValid?: boolean
  effects?: Record<string, { amplifier?: number; duration?: number }>
}

export interface BlockLike {
  position: VectorLike
  name?: string
  stateId?: number
  shapes?: number[][]
  transparent?: boolean
  boundingBox?: string
  getProperties?: () => Record<string, unknown>
}

export interface PlayerLike {
  username: string
  uuid?: string
  entity?: EntityLike | null
}

export interface BotLike extends EventEmitter {
  username: string
  version?: string
  protocolVersion?: number
  entity?: EntityLike
  entities: Record<string, EntityLike>
  players: Record<string, PlayerLike>
  game?: {
    dimension?: string
    gameMode?: string
    difficulty?: string
    minY?: number
    height?: number
    serverViewDistance?: number
  }
  health?: number
  food?: number
  foodSaturation?: number
  oxygenLevel?: number
  experience?: { level?: number; progress?: number; points?: number }
  inventory?: { slots?: Array<ItemLike | null | undefined>; selectedItem?: ItemLike | null }
  quickBarSlot?: number
  time?: { timeOfDay?: number }
  isRaining?: boolean
  registry?: { effects?: Record<string | number, { name?: string }> }
  world?: { getBlock(position: VectorLike): BlockLike | null }
  quit(reason?: string): void
  end(reason?: string): void
  clearControlStates?: () => void
  chat(message: string): void
}

export interface SafeBotOptions {
  host: string
  port: number
  username: string
  auth: 'offline' | 'microsoft'
  version: '1.21.1'
  profilesFolder?: string
  logErrors: false
}

export interface MineflayerBotFactory {
  create(options: SafeBotOptions): BotLike
}

export interface CancelableTimer { cancel(): void }
export interface Scheduler { timeout(ms: number, callback: () => void): CancelableTimer }
export interface Clock { now(): Date; monotonicMs(): number }
export interface RandomSource { next(): number }

export const systemClock: Clock = {
  now: () => new Date(),
  monotonicMs: () => performance.now(),
}

export const systemScheduler: Scheduler = {
  timeout(ms, callback) {
    const handle = setTimeout(callback, ms)
    return { cancel: () => clearTimeout(handle) }
  },
}

export const systemRandom: RandomSource = { next: () => Math.random() }
