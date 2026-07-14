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
  now?: () => Date
}

export class InformationRefStore {
  readonly #entries = new Map<string, StoredReference>()
  readonly #maxEntries: number
  readonly #now: () => Date

  constructor(options: InformationRefStoreOptions = {}) {
    this.#maxEntries = options.maxEntries ?? 2_048
    this.#now = options.now ?? (() => new Date())
    if (!Number.isInteger(this.#maxEntries) || this.#maxEntries < 1) {
      throw new Error('Information reference capacity must be positive')
    }
  }

  issuer(input: {
    interfaceId: InformationInterfaceId
    principalId: string
    grant: InformationGrant
    scope: InformationScopeSnapshot
  }): InformationReferenceIssuer {
    return {
      issue: <Payload>(request: InformationReferenceIssueRequest<Payload>) =>
        this.#issue(input, request),
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
    return stored.payload as Payload
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
    this.#evictExpired()
    while (this.#entries.size >= this.#maxEntries) {
      const oldest = this.#entries.keys().next().value as string | undefined
      if (!oldest) break
      this.#entries.delete(oldest)
    }
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
      ...(request.validUntil ? { validUntil: request.validUntil } : {}),
    })
    this.#entries.set(ref.id, {
      ref,
      kind: request.kind,
      payload: structuredClone(request.payload),
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
