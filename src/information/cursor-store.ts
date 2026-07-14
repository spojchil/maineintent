import { randomUUID } from 'node:crypto'
import type {
  InformationGrant,
  InformationInterfaceId,
  InformationInvalidationEvent,
  InformationScopeSnapshot,
  InformationSelectorRef,
} from './contracts/index.js'

interface StoredCursor {
  id: string
  interfaceId: InformationInterfaceId
  fields: readonly string[]
  selectorId?: string
  informationRevision: number
  limit: number
  pageState: unknown
  principalId: string
  grantId: string
  audience: InformationGrant['audience']
  connectionEpoch: number
  worldId?: string
  dimension?: string
  screenInstanceId?: string
  screenRevision?: number
  validUntil?: string
}

export interface InformationCursorStoreOptions {
  maxEntries?: number
  ttlMs?: number
  now?: () => Date
}

export class InformationCursorStore {
  readonly #entries = new Map<string, StoredCursor>()
  readonly #maxEntries: number
  readonly #ttlMs: number
  readonly #now: () => Date

  constructor(options: InformationCursorStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 2_048
    this.#ttlMs = options.ttlMs ?? 60_000
    this.#now = options.now ?? (() => new Date())
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1 ||
        !Number.isInteger(this.#ttlMs) || this.#ttlMs < 1) {
      throw new Error('Information cursor limits must be positive')
    }
  }

  issue<PageState>(input: {
    interfaceId: InformationInterfaceId
    fields: readonly string[]
    selector?: InformationSelectorRef
    informationRevision: number
    limit: number
    pageState: PageState
    principalId: string
    grant: InformationGrant
    scope: InformationScopeSnapshot
  }): string {
    if (!Number.isInteger(input.informationRevision) || input.informationRevision < 0 ||
        !Number.isInteger(input.limit) || input.limit < 1) {
      throw new Error('Information cursor metadata is invalid')
    }
    this.#evictExpired()
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (!oldest) break
      this.#entries.delete(oldest)
    }
    const id = `icur_${randomUUID()}`
    this.#entries.set(id, {
      id,
      interfaceId: input.interfaceId,
      fields: Object.freeze([...input.fields]),
      ...(input.selector ? { selectorId: input.selector.id } : {}),
      informationRevision: input.informationRevision,
      limit: input.limit,
      pageState: structuredClone(input.pageState),
      principalId: input.principalId,
      grantId: input.grant.id,
      audience: input.grant.audience,
      connectionEpoch: input.scope.connectionEpoch,
      ...(input.scope.worldId ? { worldId: input.scope.worldId } : {}),
      ...(input.scope.dimension ? { dimension: input.scope.dimension } : {}),
      ...(input.scope.screenInstanceId ? {
        screenInstanceId: input.scope.screenInstanceId,
        screenRevision: input.scope.screenRevision,
      } : {}),
      validUntil: new Date(this.#now().getTime() + this.#ttlMs).toISOString(),
    })
    return id
  }

  resolve<PageState>(input: {
    cursor: string
    interfaceId: InformationInterfaceId
    fields: readonly string[]
    selector?: InformationSelectorRef
    limit: number
    principalId: string
    grant: InformationGrant
    scope: InformationScopeSnapshot
  }): { state: PageState; informationRevision: number } | undefined {
    const stored = this.#entries.get(input.cursor)
    if (!stored || isExpired(stored.validUntil, this.#now())) {
      this.#entries.delete(input.cursor)
      return undefined
    }
    if (stored.interfaceId !== input.interfaceId ||
        stored.principalId !== input.principalId ||
        stored.grantId !== input.grant.id ||
        stored.audience !== input.grant.audience ||
        stored.limit !== input.limit ||
        stored.selectorId !== input.selector?.id ||
        stored.connectionEpoch !== input.scope.connectionEpoch ||
        stored.worldId !== input.scope.worldId ||
        stored.dimension !== input.scope.dimension ||
        stored.screenInstanceId !== input.scope.screenInstanceId ||
        stored.screenRevision !== input.scope.screenRevision ||
        !sameStrings(stored.fields, input.fields)) return undefined
    this.#entries.delete(input.cursor)
    return {
      state: structuredClone(stored.pageState) as PageState,
      informationRevision: stored.informationRevision,
    }
  }

  invalidate(event: InformationInvalidationEvent): void {
    for (const [id, stored] of this.#entries) {
      const remove = event.kind === 'grant_ended'
        ? stored.grantId === event.grantId
        : event.kind === 'connection_changed'
          ? stored.connectionEpoch !== event.connectionEpoch
          : event.kind === 'world_changed'
            ? stored.worldId !== event.worldId || stored.dimension !== event.dimension
            : stored.screenInstanceId !== event.screenInstanceId ||
              stored.screenRevision !== event.screenRevision
      if (remove) this.#entries.delete(id)
    }
  }

  size(): number {
    return this.#entries.size
  }

  #evictExpired(): void {
    for (const [id, stored] of this.#entries) {
      if (isExpired(stored.validUntil, this.#now())) this.#entries.delete(id)
    }
  }
}

function isExpired(validUntil: string | undefined, now: Date): boolean {
  return validUntil !== undefined && Date.parse(validUntil) <= now.getTime()
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index])
}
