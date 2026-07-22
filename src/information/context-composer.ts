import type { InformationInterfaceId, InformationReadResult, TrustedInformationCaller } from './contracts/index.js'
import type { InformationRuntime } from './runtime.js'

export interface PassiveObservations {
  catalogRevision?: string
  reads: Array<InformationReadResult<Record<string, unknown>>>
  omissions: Array<{ interfaceId: InformationInterfaceId; reason: string }>
}

interface ReadPlanEntry {
  interfaceId: InformationInterfaceId
  schemaRevision: string
  fields: readonly string[]
}

const READ_PLAN: readonly ReadPlanEntry[] = [
  { interfaceId: 'current_status', schemaRevision: 'current-status:2', fields: ['health', 'food', 'oxygen', 'experienceLevel', 'statusEffects'] },
  { interfaceId: 'inventory_information', schemaRevision: 'inventory-information:2', fields: ['selectedHotbarSlot', 'slots'] },
  { interfaceId: 'sound_information', schemaRevision: 'sound-information:2', fields: ['recentSounds'] },
  { interfaceId: 'viewport_information', schemaRevision: 'viewport-information:7', fields: ['standingOnBlock', 'lookedAtBlock', 'visibleEntities', 'visibleBlocks'] },
]

/**
 * The deterministic, single-shot Context Composer: reads a fixed, known-small field set from
 * each passive-observation interface once per decision. Not a model-facing tool loop — see
 * docs/design/information-runtime.md section 15 for why that was dropped.
 */
export async function composePassiveObservations(
  runtime: InformationRuntime,
  caller: TrustedInformationCaller,
  signal: AbortSignal,
): Promise<PassiveObservations> {
  const observations: PassiveObservations = { reads: [], omissions: [] }
  const catalog = runtime.catalog(caller, { operation: 'list_interfaces' })
  if (catalog.protocol !== 'mineintent.information-catalog.v1') {
    for (const plan of READ_PLAN) observations.omissions.push({ interfaceId: plan.interfaceId, reason: catalog.code })
    return observations
  }
  observations.catalogRevision = catalog.catalogRevision

  for (const plan of READ_PLAN) {
    const response = await runtime.query(caller, {
      interfaceId: plan.interfaceId, operation: 'read', schemaRevision: plan.schemaRevision, fields: [...plan.fields],
    }, signal)
    if (response.protocol !== 'mineintent.information-read.v1') {
      const reason = response.protocol === 'mineintent.information-error.v1' ? response.code : 'invalid_request'
      observations.omissions.push({ interfaceId: plan.interfaceId, reason })
      continue
    }
    observations.reads.push(response)
  }
  return observations
}
