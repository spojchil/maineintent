import { z } from 'zod'
import type { InformationProvider, InformationProviderContext, InformationProviderDefinition, ProviderAvailability, ProviderReadRequest, ProviderReadResult } from '../contracts/index.js'
import { nearbyTrackedEntities, raycastLookedAtBlock, standingOnBlock, type PerceptionPort } from '../source-ports/perception.js'

export interface ViewportValues {
  standingOnBlock: { name: string } | null
  lookedAtBlock: { name: string; distance: number } | null
  nearbyTrackedEntities: Array<{
    type: string
    name?: string
    username?: string
    distance: number
    direction: 'ahead' | 'right' | 'behind' | 'left'
  }>
}

const standingOnBlockSchema = z.object({ name: z.string().min(1) }).nullable()
const lookedAtBlockSchema = z.object({ name: z.string().min(1), distance: z.number().min(0) }).nullable()
const nearbyEntitySchema = z.array(z.object({
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  distance: z.number().min(0),
  direction: z.enum(['ahead', 'right', 'behind', 'left']),
}))

// Matches vanilla's default block_interaction_range (4.5 blocks outside Creative).
const MAX_LOOK_DISTANCE = 4.5
const MAX_ENTITY_DISTANCE = 16
const MAX_ENTITIES = 10

/**
 * "Reasonable vision" for a standing-still player: what block you're standing on, a precise
 * crosshair-style raycast for what's directly ahead (matching vanilla's own targeted-block
 * mechanic, not a wider field of view), plus a distance-sorted list of protocol-tracked nearby
 * entities. This intentionally skips FOV/occlusion/texture modeling from the shelved viewport
 * design (issue #34/#68) — that is a separate, more complex design effort.
 */
export class ViewportInformationProvider implements InformationProvider<ViewportValues> {
  readonly #port: PerceptionPort
  #revision = 0
  #lastSignature = ''

  constructor(port: PerceptionPort) { this.#port = port }

  readonly definition: InformationProviderDefinition<ViewportValues> = {
    id: 'viewport_information',
    description: '站立不动时的合理视觉：脚下方块、准星精确指向的方块，以及附近协议追踪到的实体',
    schemaRevision: 'viewport-information:2',
    audiences: ['companion'] as const,
    fields: {
      standingOnBlock: {
        description: '脚下（自身位置正下方）的方块；无法得知时为 null',
        valueSchema: standingOnBlockSchema, valueType: 'object', precision: 'exactly_displayed', sourceKinds: ['viewport_projection'],
      },
      lookedAtBlock: {
        description: '准星精确指向的最近非空气方块，对应原版 block_interaction_range（约4.5格）；' +
          '这是精确的单点指向，不是一个视野范围，没对准任何方块时为 null 是常见且正常的结果',
        valueSchema: lookedAtBlockSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      nearbyTrackedEntities: {
        description: '16格内协议追踪到的实体，按距离排序；这是候选列表，不代表一定在视线内可见',
        valueSchema: nearbyEntitySchema, valueType: 'array', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
    },
    scopeDependencies: ['connection', 'world'] as const,
    limits: { maxFieldsPerRead: 3, maxResultBytes: 16_384, timeoutMs: 2_000 },
  }

  availability(): ProviderAvailability<ViewportValues> {
    return { overall: 'available', informationRevision: this.#revisionFor(), fields: {} }
  }

  async read(
    context: InformationProviderContext,
    request: ProviderReadRequest<ViewportValues, never, never>,
    _signal: AbortSignal,
  ): Promise<ProviderReadResult<ViewportValues, never>> {
    const revision = this.#revisionFor()
    const values: Partial<ViewportValues> = {}
    if (request.fields.includes('standingOnBlock')) values.standingOnBlock = standingOnBlock(this.#port)
    if (request.fields.includes('lookedAtBlock')) values.lookedAtBlock = raycastLookedAtBlock(this.#port, MAX_LOOK_DISTANCE)
    if (request.fields.includes('nearbyTrackedEntities')) {
      values.nearbyTrackedEntities = nearbyTrackedEntities(this.#port, MAX_ENTITY_DISTANCE, MAX_ENTITIES)
    }
    return {
      informationRevision: revision, values, unavailable: [],
      source: { kind: 'viewport_projection', adapterRevision: 'viewport-provider.v1', sourceRevision: revision, acquisition: 'current_perception' },
      observedAt: context.now, evidenceIds: [],
    }
  }

  #revisionFor(): number {
    const pose = this.#port.selfPose()
    const signature = JSON.stringify(pose)
    if (signature !== this.#lastSignature) { this.#lastSignature = signature; this.#revision++ }
    return this.#revision
  }
}
