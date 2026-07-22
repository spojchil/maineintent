import { randomUUID } from 'node:crypto'
import type { GroundedTarget, ResolvedGroundedTarget } from './contracts.js'

interface StoredGroundedTarget extends ResolvedGroundedTarget {}

export interface GroundedReferentStoreOptions {
  capacity?: number
  now?: () => Date
}

export class GroundedReferentStore {
  readonly #entries = new Map<string, StoredGroundedTarget>()
  readonly #capacity: number
  readonly #now: () => Date

  constructor(options: GroundedReferentStoreOptions = {}) {
    this.#capacity = options.capacity ?? 256
    if (!Number.isSafeInteger(this.#capacity) || this.#capacity <= 0) {
      throw new Error('Grounded referent capacity must be a positive safe integer')
    }
    this.#now = options.now ?? (() => new Date())
  }

  issue(input: Omit<ResolvedGroundedTarget, 'handle'>): ResolvedGroundedTarget {
    this.#evictExpired()
    const expiry = Date.parse(input.validUntil)
    if (!Number.isFinite(expiry) || expiry <= this.#now().getTime()) {
      throw new Error('Grounded referent expiry must be a future timestamp')
    }
    if (this.#entries.size >= this.#capacity) throw new Error('Grounded referent capacity exceeded')
    const handle = `ground_${randomUUID()}`
    const stored: StoredGroundedTarget = structuredClone({ handle, ...input })
    this.#entries.set(handle, stored)
    return structuredClone(stored)
  }

  resolve(input: {
    handle: string
    decisionRunId: string
    effectId: string
    worldId: string
    epoch: number
  }): ResolvedGroundedTarget | undefined {
    const stored = this.#entries.get(input.handle)
    if (!stored) return undefined
    if (Date.parse(stored.validUntil) <= this.#now().getTime()) {
      this.#entries.delete(input.handle)
      return undefined
    }
    if (stored.decisionRunId !== input.decisionRunId || stored.effectId !== input.effectId ||
        stored.worldId !== input.worldId || stored.epoch !== input.epoch) return undefined
    return structuredClone(stored)
  }

  isCurrent(input: {
    handle: string
    decisionRunId: string
    effectId: string
    worldId: string
    epoch: number
  }): boolean {
    return this.resolve(input) !== undefined
  }

  revoke(handle: string): void { this.#entries.delete(handle) }

  invalidateWorld(worldId: string, epoch: number): void {
    for (const [handle, stored] of this.#entries) {
      if (stored.worldId !== worldId || stored.epoch !== epoch) this.#entries.delete(handle)
    }
  }

  size(): number { this.#evictExpired(); return this.#entries.size }

  #evictExpired(): void {
    const now = this.#now().getTime()
    for (const [handle, stored] of this.#entries) {
      if (Date.parse(stored.validUntil) <= now) this.#entries.delete(handle)
    }
  }
}

export function targetHasKnownPosition(target: GroundedTarget): target is Exclude<GroundedTarget, { kind: 'identity' }> {
  return target.kind === 'block' || target.kind === 'entity'
}
