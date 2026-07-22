import { z } from 'zod'
import type {
  InformationProvider, InformationProviderContext, InformationProviderDefinition,
  ProviderAvailability, ProviderReadRequest, ProviderReadResult,
} from '../contracts/index.js'
import type { SelfVitalsPort } from '../source-ports/self-vitals.js'

export interface CurrentStatusValues {
  health: number
  food: number
  oxygen: number
  experienceLevel: number
  statusEffects: Array<{ name: string; amplifier: number }>
}

const statusEffectSchema = z.object({
  name: z.string().min(1),
  amplifier: z.number().int(),
})

interface CurrentStatusProjection {
  values: Partial<CurrentStatusValues>
  unavailable: ProviderReadResult<CurrentStatusValues, never>['unavailable']
}

/**
 * Projects only values a vanilla HUD can communicate. Raw saturation, exact effect ticks and
 * experience totals stay in the driver snapshot and never cross the Information boundary.
 */
export class CurrentStatusProvider implements InformationProvider<CurrentStatusValues> {
  readonly #port: SelfVitalsPort
  #revision = 0
  #lastSignature = ''

  constructor(port: SelfVitalsPort) { this.#port = port }

  readonly definition: InformationProviderDefinition<CurrentStatusValues> = {
    id: 'current_status',
    description: '当前原版 HUD 可表达的生命、饥饿、空气、经验等级和状态效果',
    schemaRevision: 'current-status:2',
    audiences: ['companion'] as const,
    fields: {
      health: {
        description: '生命条可分辨的当前生命值', valueSchema: z.number().int().min(0), valueType: 'number',
        precision: 'quantized', sourceKinds: ['hud_projection'],
        notes: '向上量化到整点生命值；不暴露协议中的不可见小数',
      },
      food: {
        description: '当前饥饿条显示值（0-20）', valueSchema: z.number().int().min(0).max(20), valueType: 'number',
        precision: 'exactly_displayed', sourceKinds: ['hud_projection'],
      },
      oxygen: {
        description: '空气条当前显示值；没有空气条证据时不可用', valueSchema: z.number().int().min(0), valueType: 'number',
        precision: 'quantized', sourceKinds: ['hud_projection'],
      },
      experienceLevel: {
        description: 'HUD 显示的当前经验等级', valueSchema: z.number().int().min(0), valueType: 'number',
        precision: 'exactly_displayed', sourceKinds: ['hud_projection'],
      },
      statusEffects: {
        description: '当前 HUD 可识别的状态效果及等级，不含隐藏的精确剩余 tick',
        valueSchema: z.array(statusEffectSchema), valueType: 'array', precision: 'displayed', sourceKinds: ['hud_projection'],
      },
    },
    scopeDependencies: ['connection', 'world'] as const,
    limits: { maxFieldsPerRead: 5, maxResultBytes: 8_192, timeoutMs: 2_000 },
  }

  availability(): ProviderAvailability<CurrentStatusValues> {
    const projection = project(this.#port.current())
    const fields = Object.fromEntries(projection.unavailable.map(item => [item.field, item.reason]))
    return {
      overall: projection.unavailable.length === 0 ? 'available' : 'partially_available',
      informationRevision: this.#revisionFor(projection), fields,
    }
  }

  async read(
    context: InformationProviderContext,
    request: ProviderReadRequest<CurrentStatusValues, never, never>,
    _signal: AbortSignal,
  ): Promise<ProviderReadResult<CurrentStatusValues, never>> {
    const projection = project(this.#port.current())
    const revision = this.#revisionFor(projection)
    const values: Partial<CurrentStatusValues> = {}
    const unavailable: ProviderReadResult<CurrentStatusValues, never>['unavailable'] = []
    for (const field of request.fields) {
      const missing = projection.unavailable.find(item => item.field === field)
      if (missing) { unavailable.push(missing); continue }
      const value = projection.values[field]
      if (value !== undefined) Object.assign(values, { [field]: structuredClone(value) })
    }
    return {
      informationRevision: revision, values, unavailable,
      source: {
        kind: 'hud_projection', adapterRevision: 'current-status-provider.v2', sourceRevision: revision,
        acquisition: 'structured_ui_equivalent',
      },
      observedAt: context.now, evidenceIds: [],
    }
  }

  #revisionFor(projection: CurrentStatusProjection): number {
    const signature = JSON.stringify(projection)
    if (signature !== this.#lastSignature) { this.#lastSignature = signature; this.#revision++ }
    return this.#revision
  }
}

function project(vitals: ReturnType<SelfVitalsPort['current']>): CurrentStatusProjection {
  const values: Partial<CurrentStatusValues> = {
    health: Math.max(0, Math.ceil(vitals.health)),
    food: Math.max(0, Math.min(20, Math.round(vitals.food))),
    statusEffects: vitals.effects.map(effect => ({ name: effect.name, amplifier: effect.amplifier })),
  }
  const unavailable: CurrentStatusProjection['unavailable'] = []
  if (vitals.oxygen === undefined) unavailable.push({ field: 'oxygen', reason: 'not_currently_displayed' })
  else values.oxygen = Math.max(0, Math.round(vitals.oxygen))
  if (vitals.experience === undefined) unavailable.push({ field: 'experienceLevel', reason: 'not_supported' })
  else values.experienceLevel = Math.max(0, Math.floor(vitals.experience.level))
  return { values, unavailable }
}
