import assert from 'node:assert/strict'
import type {
  InformationProvider,
  InformationProviderContext,
  InformationFieldDefinition,
  ProviderReadRequest,
} from '../contracts/index.js'

export interface ProviderContractFixture<
  Values extends object,
  Selector,
  PageState,
> {
  context: InformationProviderContext
  request: ProviderReadRequest<Values, Selector, PageState>
}

export async function assertInformationProviderContract<
  Values extends object,
  Selector,
  PageState,
>(
  provider: InformationProvider<Values, Selector, PageState>,
  fixture: ProviderContractFixture<Values, Selector, PageState>,
): Promise<void> {
  const fieldIds = Object.keys(provider.definition.fields)
  const definitions = provider.definition.fields as unknown as Record<
    string,
    InformationFieldDefinition<unknown>
  >
  assert.ok(fieldIds.length > 0, 'provider must define fields')
  assert.equal(new Set(fieldIds).size, fieldIds.length, 'provider field ids must be unique')
  for (const fieldId of fieldIds) {
    const field = definitions[fieldId]!
    assert.ok(field.description.trim(), `${fieldId} must have a description`)
    assert.ok(field.valueType.trim(), `${fieldId} must have a value type`)
    assert.ok(field.sourceKinds.length > 0, `${fieldId} must declare a source kind`)
  }

  const availability = provider.availability(fixture.context)
  assert.ok(Number.isInteger(availability.informationRevision))
  assert.ok(availability.informationRevision >= 0)

  const result = await provider.read(
    fixture.context,
    fixture.request,
    AbortSignal.timeout(provider.definition.limits.timeoutMs),
  )
  assert.ok(Number.isInteger(result.informationRevision))
  assert.ok(result.informationRevision >= 0)
  const requested = new Set<string>(fixture.request.fields)
  const unavailable = new Set<string>()
  for (const item of result.unavailable) {
    assert.ok(requested.has(item.field), `provider returned unrequested unavailable field ${item.field}`)
    assert.ok(!unavailable.has(item.field), `provider repeated unavailable field ${item.field}`)
    unavailable.add(item.field)
  }
  for (const [fieldId, value] of Object.entries(result.values)) {
    assert.ok(requested.has(fieldId), `provider returned unrequested value ${fieldId}`)
    assert.ok(!unavailable.has(fieldId), `${fieldId} cannot be both available and unavailable`)
    const definition = definitions[fieldId]!
    assert.ok(definition.valueSchema.safeParse(value).success, `${fieldId} failed its runtime schema`)
  }
  for (const fieldId of requested) {
    assert.ok(fieldId in result.values || unavailable.has(fieldId), `${fieldId} was omitted without reason`)
  }
}
