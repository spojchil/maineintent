import { randomUUID } from 'node:crypto'
import type {
  InformationGrant,
  InformationInterfaceId,
  InformationInvalidationEvent,
  InformationReferenceIssueRequest,
  InformationReferenceIssuer,
  InformationScopeSnapshot,
  InformationSelectorRef,
} from './contracts/index.js'

interface StoredReference {
  ref: InformationSelectorRef
  kind: string
  payload: unknown
  principalId: string
  grantId: string
  audience: InformationGrant['audience']
  allowedInterfaces: readonly InformationInterfaceId[]
  dimension?: string
  screenRevision?: number
}

export interface InformationRefStoreOptions {
  maxEntries?: number
  maxEntriesPerPrincipal?: number
  maxEntriesPerInterface?: number
  maxPayloadBytes?: number
  maxIssuesPerIssuer?: number
  ttlMs?: number
  now?: () => Date
}

export class InformationRefStore {
  readonly #entries = new Map<string, StoredReference>()
  readonly #maxEntries: number
  readonly #maxEntriesPerPrincipal: number
  readonly #maxEntriesPerInterface: number
  readonly #maxPayloadBytes: number
  readonly #maxIssuesPerIssuer: number
  readonly #ttlMs: number
  readonly #now: () => Date

  constructor(options: InformationRefStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 2_048
    this.#maxEntriesPerPrincipal = options.maxEntriesPerPrincipal ?? 512
    this.#maxEntriesPerInterface = options.maxEntriesPerInterface ?? 256
    this.#maxPayloadBytes = options.maxPayloadBytes ?? 8_192
    this.#maxIssuesPerIssuer = options.maxIssuesPerIssuer ?? 32
    this.#ttlMs = options.ttlMs ?? 60_000
    this.#now = options.now ?? (() => new Date())
    if ([
      this.#maxEntries,
      this.#maxEntriesPerPrincipal,
      this.#maxEntriesPerInterface,
      this.#maxPayloadBytes,
      this.#maxIssuesPerIssuer,
      this.#ttlMs,
    ].some((value) => !Number.isInteger(value) || value < 1)) {
      throw new Error('Information reference limits must be positive integers')
    }
  }

  issuer(input: {
    interfaceId: InformationInterfaceId
    principalId: string
    grant: InformationGrant
    scope: InformationScopeSnapshot
  }): InformationReferenceIssuer {
    let issued = 0
    return {
      issue: <Payload>(request: InformationReferenceIssueRequest<Payload>) => {
        issued += 1
        if (issued > this.#maxIssuesPerIssuer) {
          throw new Error('Information reference per-read issue limit exceeded')
        }
        return this.#issue(input, request)
      },
    }
  }

  resolve<Payload>(input: {
    ref: InformationSelectorRef
    targetInterface: InformationInterfaceId
    principalId: string
    grant: InformationGrant
    scope: InformationScopeSnapshot
    acceptedKinds?: readonly string[]
  }): Payload | undefined {
    const stored = this.#entries.get(input.ref.id)
    if (!stored || !sameRef(stored.ref, input.ref)) return undefined
    if (isExpired(stored.ref.validUntil, this.#now())) {
      this.#entries.delete(input.ref.id)
      return undefined
    }
    if (stored.principalId !== input.principalId ||
        stored.grantId !== input.grant.id ||
        stored.audience !== input.grant.audience) return undefined
    if (!stored.allowedInterfaces.includes(input.targetInterface)) return undefined
    if (stored.ref.connectionEpoch !== input.scope.connectionEpoch ||
        stored.ref.worldId !== input.scope.worldId ||
        stored.dimension !== input.scope.dimension) return undefined
    if (stored.ref.screenInstanceId !== undefined &&
        (stored.ref.screenInstanceId !== input.scope.screenInstanceId ||
         stored.screenRevision !== input.scope.screenRevision)) return undefined
    if (input.acceptedKinds && !input.acceptedKinds.includes(stored.kind)) return undefined
    return cloneBoundedJson(stored.payload, this.#maxPayloadBytes, 'reference payload') as Payload
  }

  invalidate(event: InformationInvalidationEvent): void {
    for (const [id, stored] of this.#entries) {
      const remove = event.kind === 'grant_ended'
        ? stored.grantId === event.grantId
        : event.kind === 'connection_changed'
          ? stored.ref.connectionEpoch !== event.connectionEpoch
          : event.kind === 'world_changed'
            ? stored.ref.worldId !== event.worldId || stored.dimension !== event.dimension
            : stored.ref.screenInstanceId !== undefined &&
              (stored.ref.screenInstanceId !== event.screenInstanceId ||
               stored.screenRevision !== event.screenRevision)
      if (remove) this.#entries.delete(id)
    }
  }

  size(): number {
    return this.#entries.size
  }

  #issue<Payload>(
    input: {
      interfaceId: InformationInterfaceId
      principalId: string
      grant: InformationGrant
      scope: InformationScopeSnapshot
    },
    request: InformationReferenceIssueRequest<Payload>,
  ): InformationSelectorRef {
    if (request.allowedInterfaces.length === 0) {
      throw new Error('Information reference requires an allowed target interface')
    }
    if (!request.kind.trim() ||
        !Number.isInteger(request.basedOnInformationRevision) ||
        request.basedOnInformationRevision < 0 ||
        (request.validUntil !== undefined && Number.isNaN(Date.parse(request.validUntil)))) {
      throw new Error('Information reference metadata is invalid')
    }
    if (request.bindToScreen &&
        (!input.scope.screenInstanceId || input.scope.screenRevision === undefined)) {
      throw new Error('Screen-bound information reference requires an active screen revision')
    }
    this.#evictExpired()
    if (this.#entries.size >= this.#maxEntries ||
        this.#count((stored) => stored.principalId === input.principalId) >= this.#maxEntriesPerPrincipal ||
        this.#count((stored) => stored.ref.interfaceId === input.interfaceId) >= this.#maxEntriesPerInterface) {
      throw new Error('Information reference capacity exceeded')
    }
    const payload = cloneBoundedJson(request.payload, this.#maxPayloadBytes, 'reference payload')
    const now = this.#now()
    const maximumValidUntil = now.getTime() + this.#ttlMs
    if (request.validUntil !== undefined && Date.parse(request.validUntil) > maximumValidUntil) {
      throw new Error('Information reference lifetime exceeds its limit')
    }
    const validUntil = request.validUntil ?? new Date(maximumValidUntil).toISOString()
    const ref: InformationSelectorRef = Object.freeze({
      protocol: 'mineintent.information-selector-ref.v1',
      id: `iref_${randomUUID()}`,
      interfaceId: input.interfaceId,
      connectionEpoch: input.scope.connectionEpoch,
      ...(input.scope.worldId ? { worldId: input.scope.worldId } : {}),
      ...(request.bindToScreen && input.scope.screenInstanceId
        ? { screenInstanceId: input.scope.screenInstanceId }
        : {}),
      basedOnInformationRevision: request.basedOnInformationRevision,
      validUntil,
    })
    this.#entries.set(ref.id, {
      ref,
      kind: request.kind,
      payload,
      principalId: input.principalId,
      grantId: input.grant.id,
      audience: input.grant.audience,
      allowedInterfaces: Object.freeze([...request.allowedInterfaces]),
      ...(input.scope.dimension ? { dimension: input.scope.dimension } : {}),
      ...(request.bindToScreen ? { screenRevision: input.scope.screenRevision } : {}),
    })
    return ref
  }

  #evictExpired(): void {
    for (const [id, stored] of this.#entries) {
      if (isExpired(stored.ref.validUntil, this.#now())) this.#entries.delete(id)
    }
  }

  #count(predicate: (stored: StoredReference) => boolean): number {
    let count = 0
    for (const stored of this.#entries.values()) {
      if (predicate(stored)) count += 1
    }
    return count
  }
}

function isExpired(validUntil: string | undefined, now: Date): boolean {
  return validUntil !== undefined && Date.parse(validUntil) <= now.getTime()
}

function sameRef(left: InformationSelectorRef, right: InformationSelectorRef): boolean {
  return left.protocol === right.protocol &&
    left.id === right.id &&
    left.interfaceId === right.interfaceId &&
    left.connectionEpoch === right.connectionEpoch &&
    left.worldId === right.worldId &&
    left.screenInstanceId === right.screenInstanceId &&
    left.basedOnInformationRevision === right.basedOnInformationRevision &&
    left.validUntil === right.validUntil
}

function cloneBoundedJson<T>(value: T, maxBytes: number, label: string): T {
  let serialized: string | undefined
  try {
    serialized = JSON.stringify(value)
  } catch {
    throw new Error(`Information ${label} must be JSON serializable`)
  }
  if (serialized === undefined || Buffer.byteLength(serialized, 'utf8') > maxBytes) {
    throw new Error(`Information ${label} exceeds its byte limit`)
  }
  return JSON.parse(serialized) as T
}
