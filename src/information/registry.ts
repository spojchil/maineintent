import { createHash } from 'node:crypto'
import {
  INFORMATION_AUDIENCES,
  INFORMATION_SCOPE_DEPENDENCIES,
  INFORMATION_SOURCE_KINDS,
  informationInterfaceIdSchema,
  type FieldId,
  type InformationFieldDefinition,
  type InformationProvider,
  type InformationProviderContext,
  type InformationProviderDefinition,
  type InformationProviderDescriptor,
  type ProviderAvailability,
  type ProviderReadRequest,
  type ProviderReadResult,
} from './contracts/index.js'

export interface RegisteredInformationProvider {
  readonly definition: InformationProviderDefinition<Record<string, unknown>>
  availability(context: InformationProviderContext): ProviderAvailability<Record<string, unknown>>
  read(
    context: InformationProviderContext,
    request: ProviderReadRequest<Record<string, unknown>, unknown, unknown>,
    signal: AbortSignal,
  ): Promise<ProviderReadResult<Record<string, unknown>, unknown>>
}

function eraseProvider<Values extends object, Selector, PageState>(
  provider: InformationProvider<Values, Selector, PageState>,
): RegisteredInformationProvider {
  const definition = freezeDefinition(provider.definition)
  return {
    definition: definition as unknown as InformationProviderDefinition<Record<string, unknown>>,
    availability: (context) => provider.availability(context) as unknown as ProviderAvailability<Record<string, unknown>>,
    read: async (context, request, signal) => provider.read(
      context,
      request as unknown as ProviderReadRequest<Values, Selector, PageState>,
      signal,
    ) as unknown as Promise<ProviderReadResult<Record<string, unknown>, unknown>>,
  }
}

function freezeDefinition<Values extends object>(
  definition: InformationProviderDefinition<Values>,
): InformationProviderDefinition<Values> {
  const entries = Object.entries(definition.fields) as Array<
    [string, InformationFieldDefinition<unknown>]
  >
  const fields = Object.fromEntries(entries.map(([id, field]) => [
    id,
    Object.freeze({
      ...field,
      sourceKinds: Object.freeze([...field.sourceKinds]),
      ...(field.requires ? { requires: Object.freeze([...field.requires]) } : {}),
    }),
  ])) as InformationProviderDefinition<Values>['fields']
  return Object.freeze({
    ...definition,
    audiences: Object.freeze([...definition.audiences]),
    scopeDependencies: Object.freeze([...definition.scopeDependencies]),
    fields: Object.freeze(fields),
    ...(definition.selectors ? {
      selectors: Object.freeze({
        ...definition.selectors,
        acceptsKinds: Object.freeze([...definition.selectors.acceptsKinds]),
      }),
    } : {}),
    ...(definition.pagination ? { pagination: Object.freeze({ ...definition.pagination }) } : {}),
    limits: Object.freeze({ ...definition.limits }),
  })
}

function validateDefinition<Values extends object>(
  definition: InformationProviderDefinition<Values>,
): void {
  informationInterfaceIdSchema.parse(definition.id)
  if (!definition.description.trim()) throw new Error(`Provider ${definition.id} has no description`)
  if (!definition.schemaRevision.trim()) throw new Error(`Provider ${definition.id} has no schema revision`)
  if (definition.audiences.length === 0) throw new Error(`Provider ${definition.id} has no audience`)
  if (new Set(definition.audiences).size !== definition.audiences.length ||
      definition.audiences.some((audience) => !INFORMATION_AUDIENCES.includes(audience))) {
    throw new Error(`Provider ${definition.id} has invalid audiences`)
  }
  if (new Set(definition.scopeDependencies).size !== definition.scopeDependencies.length ||
      definition.scopeDependencies.some((dependency) =>
        !INFORMATION_SCOPE_DEPENDENCIES.includes(dependency))) {
    throw new Error(`Provider ${definition.id} has invalid scope dependencies`)
  }

  const fields = Object.entries(definition.fields) as Array<
    [FieldId<Values>, InformationProviderDefinition<Values>['fields'][FieldId<Values>]]
  >
  if (fields.length === 0) throw new Error(`Provider ${definition.id} has no fields`)
  for (const [fieldId, field] of fields) {
    if (!fieldId.trim()) throw new Error(`Provider ${definition.id} has an empty field id`)
    if (!field.description.trim()) throw new Error(`Provider ${definition.id}.${fieldId} has no description`)
    if (!field.valueType.trim()) throw new Error(`Provider ${definition.id}.${fieldId} has no value type`)
    if (!field.valueSchema || typeof field.valueSchema.safeParse !== 'function') {
      throw new Error(`Provider ${definition.id}.${fieldId} has no runtime schema`)
    }
    if (field.sourceKinds.length === 0) {
      throw new Error(`Provider ${definition.id}.${fieldId} has no source kind`)
    }
    if (new Set(field.sourceKinds).size !== field.sourceKinds.length ||
        field.sourceKinds.some((kind) => !INFORMATION_SOURCE_KINDS.includes(kind))) {
      throw new Error(`Provider ${definition.id}.${fieldId} has invalid source kinds`)
    }
  }

  const { limits } = definition
  if (!Number.isInteger(limits.maxFieldsPerRead) || limits.maxFieldsPerRead < 1) {
    throw new Error(`Provider ${definition.id} has an invalid field limit`)
  }
  if (!Number.isInteger(limits.maxResultBytes) || limits.maxResultBytes < 1) {
    throw new Error(`Provider ${definition.id} has an invalid byte limit`)
  }
  if (!Number.isInteger(limits.timeoutMs) || limits.timeoutMs < 1) {
    throw new Error(`Provider ${definition.id} has an invalid timeout`)
  }
  if (definition.pagination) {
    if (!Number.isInteger(definition.pagination.defaultLimit) ||
        !Number.isInteger(definition.pagination.maxLimit) ||
        definition.pagination.defaultLimit < 1 ||
        definition.pagination.maxLimit < definition.pagination.defaultLimit) {
      throw new Error(`Provider ${definition.id} has invalid pagination limits`)
    }
  }
  if (definition.selectors &&
      (definition.selectors.acceptsKinds.length === 0 ||
       new Set(definition.selectors.acceptsKinds).size !== definition.selectors.acceptsKinds.length)) {
    throw new Error(`Provider ${definition.id} has invalid selector kinds`)
  }
}

export class InformationRegistry {
  readonly #providers = new Map<string, RegisteredInformationProvider>()
  #sealed = false
  #targetMinecraftVersion?: string
  #catalogRevision?: string

  register<Values extends object, Selector, PageState>(
    provider: InformationProvider<Values, Selector, PageState>,
  ): void {
    if (this.#sealed) throw new Error('Information registry is sealed')
    validateDefinition(provider.definition)
    if (this.#providers.has(provider.definition.id)) {
      throw new Error(`Duplicate information provider: ${provider.definition.id}`)
    }
    this.#providers.set(provider.definition.id, eraseProvider(provider))
  }

  seal(targetMinecraftVersion: string): void {
    if (this.#sealed) throw new Error('Information registry is already sealed')
    if (!targetMinecraftVersion.trim()) throw new Error('Target Minecraft version is required')
    if (this.#providers.size === 0) throw new Error('Information registry has no providers')
    this.#targetMinecraftVersion = targetMinecraftVersion
    const canonical = this.descriptors().map((descriptor) => ({
      ...descriptor,
      audiences: [...descriptor.audiences].sort(),
      fieldIds: [...descriptor.fieldIds].sort(),
    }))
    const hash = createHash('sha256')
      .update(JSON.stringify({ targetMinecraftVersion, providers: canonical }))
      .digest('hex')
      .slice(0, 16)
    this.#catalogRevision = `catalog:${targetMinecraftVersion}:${hash}`
    this.#sealed = true
  }

  provider(id: string): RegisteredInformationProvider | undefined {
    this.#requireSealed()
    return this.#providers.get(id)
  }

  descriptors(): readonly InformationProviderDescriptor[] {
    return [...this.#providers.values()]
      .map(({ definition }) => ({
        id: definition.id,
        description: definition.description,
        schemaRevision: definition.schemaRevision,
        audiences: [...definition.audiences],
        fieldIds: Object.keys(definition.fields).sort(),
      }))
      .sort((left, right) => left.id.localeCompare(right.id))
  }

  catalogRevision(): string {
    this.#requireSealed()
    return this.#catalogRevision!
  }

  targetMinecraftVersion(): string {
    this.#requireSealed()
    return this.#targetMinecraftVersion!
  }

  #requireSealed(): void {
    if (!this.#sealed) throw new Error('Information registry must be sealed before use')
  }
}
