import type {
  InformationGrant,
  InformationInterfaceId,
  InformationProviderDescriptor,
  InformationScopeSnapshot,
} from './contracts/index.js'

export type InformationAuthorizationResult =
  | { allowed: true }
  | { allowed: false; reason: 'audience_denied' }

export interface InformationAccessPolicy {
  resolve(grantId: string, principalId: string): InformationGrant | undefined
  authorize(
    grant: InformationGrant,
    provider: InformationProviderDescriptor,
    operation: 'catalog' | 'help' | 'read',
    fields: readonly string[],
    scope: InformationScopeSnapshot,
  ): InformationAuthorizationResult
}

function isExpired(validUntil: string | undefined, now: string): boolean {
  return validUntil !== undefined && Date.parse(validUntil) <= Date.parse(now)
}

function includesInterface(
  allowed: '*' | readonly InformationInterfaceId[],
  interfaceId: InformationInterfaceId,
): boolean {
  return allowed === '*' || allowed.includes(interfaceId)
}

export class InMemoryInformationAccessPolicy implements InformationAccessPolicy {
  readonly #grants = new Map<string, Readonly<InformationGrant>>()

  put(grant: InformationGrant): void {
    this.#grants.set(grant.id, Object.freeze({
      ...grant,
      allowedInterfaces: grant.allowedInterfaces === '*'
        ? '*'
        : Object.freeze([...grant.allowedInterfaces]),
      allowedFields: grant.allowedFields
        ? Object.freeze(Object.fromEntries(
            Object.entries(grant.allowedFields).map(([key, values]) => [
              key,
              values ? Object.freeze([...values]) : values,
            ]),
          ))
        : undefined,
    }))
  }

  revoke(grantId: string): void {
    this.#grants.delete(grantId)
  }

  resolve(grantId: string, principalId: string): InformationGrant | undefined {
    const grant = this.#grants.get(grantId)
    if (!grant || grant.principalId !== principalId) return undefined
    return grant
  }

  authorize(
    grant: InformationGrant,
    provider: InformationProviderDescriptor,
    _operation: 'catalog' | 'help' | 'read',
    fields: readonly string[],
    scope: InformationScopeSnapshot,
  ): InformationAuthorizationResult {
    if (isExpired(grant.validUntil, scope.capturedAt)) return { allowed: false, reason: 'audience_denied' }
    if (!provider.audiences.includes(grant.audience)) return { allowed: false, reason: 'audience_denied' }
    if (!includesInterface(grant.allowedInterfaces, provider.id)) {
      return { allowed: false, reason: 'audience_denied' }
    }
    if (grant.connectionEpoch !== undefined && grant.connectionEpoch !== scope.connectionEpoch) {
      return { allowed: false, reason: 'audience_denied' }
    }
    if (grant.worldId !== undefined && grant.worldId !== scope.worldId) {
      return { allowed: false, reason: 'audience_denied' }
    }
    if (grant.screenInstanceId !== undefined && grant.screenInstanceId !== scope.screenInstanceId) {
      return { allowed: false, reason: 'audience_denied' }
    }
    const fieldAllowlist = grant.allowedFields?.[provider.id]
    if (fieldAllowlist && fields.some((field) => !fieldAllowlist.includes(field))) {
      return { allowed: false, reason: 'audience_denied' }
    }
    return { allowed: true }
  }
}
