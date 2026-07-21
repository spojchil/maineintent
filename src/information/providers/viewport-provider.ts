import { z } from 'zod'
import type { InformationProvider, InformationProviderContext, InformationProviderDefinition, ProviderAvailability, ProviderReadRequest, ProviderReadResult } from '../contracts/index.js'
import { nearbyTrackedEntities, raycastLookedAtBlock, type PerceptionPort } from '../source-ports/perception.js'

export interface ViewportValues {
  lookedAtBlock: { name: string; distance: number } | null
  nearbyTrackedEntities: Array<{
    type: string
    name?: string
    username?: string
    distance: number
    direction: 'ahead' | 'right' | 'behind' | 'left'
  }>
}

const lookedAtBlockSchema = z.object({ name: z.string().min(1), distance: z.number().min(0) }).nullable()
const nearbyEntitySchema = z.array(z.object({
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  distance: z.number().min(0),
  direction: z.enum(['ahead', 'right', 'behind', 'left']),
}))

const MAX_LOOK_DISTANCE = 6
const MAX_ENTITY_DISTANCE = 16
const MAX_ENTITIES = 10

/**
 * "Reasonable vision" for a standing-still player: a bounded raycast for what's directly
 * ahead, plus a distance-sorted list of protocol-tracked nearby entities. This intentionally
 * skips FOV/occlusion/texture modeling from the shelved viewport design (issue #34/#68) —
 * it answers "what's in front of you" and "what's nearby", not full first-person perception.
 */
export class ViewportInformationProvider implements InformationProvider<ViewportValues> {
  readonly #port: PerceptionPort
  #revision = 0
  #lastSignature = ''

  constructor(port: PerceptionPort) { this.#port = port }

  readonly definition: InformationProviderDefinition<ViewportValues> = {
    id: 'viewport_information',
    description: '站立不动时的合理视觉：正前方看到的方块，以及附近协议追踪到的实体',
    schemaRevision: 'viewport-information:1',
    audiences: ['companion'] as const,
    fields: {
      lookedAtBlock: {
        description: '视线正前方最近的非空气方块；超出已加载范围或6格内均为空气时为 null',
        valueSchema: lookedAtBlockSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      nearbyTrackedEntities: {
        description: '16格内协议追踪到的实体，按距离排序；这是候选列表，不代表一定在视线内可见',
        valueSchema: nearbyEntitySchema, valueType: 'array', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
    },
    scopeDependencies: ['connection', 'world'] as const,
    limits: { maxFieldsPerRead: 2, maxResultBytes: 16_384, timeoutMs: 2_000 },
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
