import { z } from 'zod'
import type {
  InformationProvider, InformationProviderContext, InformationProviderDefinition,
  ProviderAvailability, ProviderReadRequest, ProviderReadResult,
} from '../contracts/index.js'
import {
  raycastLookedAtBlock, standingOnBlock, viewRelativeOffset, visibleBlocks, visibleEntities,
  type PerceptionPort,
} from '../source-ports/perception.js'

export interface ViewportValues {
  standingOnBlock: { name: string } | null
  lookedAtBlock: { name: string; distance: number } | null
  visibleEntities: Array<{
    type: string
    name?: string
    username?: string
    distanceBand: 'very_near' | 'near' | 'medium' | 'far'
    direction: 'ahead' | 'right' | 'behind' | 'left'
  }>
  /** Each tuple is [right, up, forward, name] in the current view-relative frame. */
  visibleBlocks: { blocks: Array<[number, number, number, string]>; truncated: boolean }
}

const standingOnBlockSchema = z.object({ name: z.string().min(1) }).nullable()
const lookedAtBlockSchema = z.object({ name: z.string().min(1), distance: z.number().min(0) }).nullable()
const visibleEntitySchema = z.array(z.object({
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  distanceBand: z.enum(['very_near', 'near', 'medium', 'far']),
  direction: z.enum(['ahead', 'right', 'behind', 'left']),
}))
const visibleBlocksSchema = z.object({
  blocks: z.array(z.tuple([z.number(), z.number(), z.number(), z.string().min(1)])),
  truncated: z.boolean(),
})

const MAX_LOOK_DISTANCE = 4.5
const MAX_ENTITY_DISTANCE = 32
const MAX_ENTITIES = 10
const VIEW_HALF_ANGLE = (45 * Math.PI) / 180
const VISIBLE_BLOCKS_OPTIONS = {
  horizontalRadius: 32,
  verticalRadius: 20,
  maxDistance: 32,
  halfAngle: VIEW_HALF_ANGLE,
  limit: 24,
}

/** Coarse first-person projection; raw tracked entities and loaded blocks never cross this API. */
export class ViewportInformationProvider implements InformationProvider<ViewportValues> {
  readonly #port: PerceptionPort
  #revision = 0
  #lastSignature = ''

  constructor(port: PerceptionPort) { this.#port = port }

  readonly definition: InformationProviderDefinition<ViewportValues> = {
    id: 'viewport_information',
    description: '站立不动时的第一人称近似观察：脚下反馈、准星目标、可见实体和可见方块表面',
    schemaRevision: 'viewport-information:5',
    audiences: ['companion'] as const,
    fields: {
      standingOnBlock: {
        description: '由当前脚下位置推断的方块；无法形成证据时为 null',
        valueSchema: standingOnBlockSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      lookedAtBlock: {
        description: '准星精确射线首先命中的可见方块；约受原版 4.5 格交互距离约束',
        valueSchema: lookedAtBlockSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      visibleEntities: {
        description: '通过视锥与多点遮挡验证的当前可见实体；不包含仅被协议追踪的墙后或背后实体',
        valueSchema: visibleEntitySchema, valueType: 'array', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      visibleBlocks: {
        description: '当前视野内通过粗略遮挡验证的方块表面；每项为 [右,上,前,名称] 视角局部四元组，可能截断',
        valueSchema: visibleBlocksSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
        notes: '透明材质依据客户端 hint 保守近似；不是像素级渲染结果',
      },
    },
    scopeDependencies: ['connection', 'world', 'dimension'] as const,
    limits: { maxFieldsPerRead: 4, maxResultBytes: 32_768, timeoutMs: 5_000 },
  }

  availability(): ProviderAvailability<ViewportValues> {
    return { overall: 'available', informationRevision: this.#revisionFor(), fields: {} }
  }

  async read(
    context: InformationProviderContext,
    request: ProviderReadRequest<ViewportValues, never, never>,
    signal: AbortSignal,
  ): Promise<ProviderReadResult<ViewportValues, never>> {
    const revision = this.#revisionFor()
    const values: Partial<ViewportValues> = {}
    if (request.fields.includes('standingOnBlock')) values.standingOnBlock = standingOnBlock(this.#port)
    if (request.fields.includes('lookedAtBlock')) values.lookedAtBlock = raycastLookedAtBlock(this.#port, MAX_LOOK_DISTANCE)
    if (request.fields.includes('visibleEntities')) {
      values.visibleEntities = visibleEntities(this.#port, MAX_ENTITY_DISTANCE, VIEW_HALF_ANGLE, MAX_ENTITIES)
    }
    if (request.fields.includes('visibleBlocks')) {
      const pose = this.#port.selfPose()
      const result = await visibleBlocks(this.#port, VISIBLE_BLOCKS_OPTIONS, signal)
      values.visibleBlocks = {
        blocks: result.blocks.map((block): [number, number, number, string] => {
          const [right, up, forward] = viewRelativeOffset(pose, block.offset)
          return [right, up, forward, block.name]
        }),
        truncated: result.truncated,
      }
    }
    return {
      informationRevision: revision, values, unavailable: [],
      source: {
        kind: 'viewport_projection', adapterRevision: 'viewport-provider.v2', sourceRevision: revision,
        acquisition: 'current_perception',
      },
      observedAt: context.now, evidenceIds: [],
    }
  }

  #revisionFor(): number {
    const signature = JSON.stringify({ pose: this.#port.selfPose(), sourceRevision: this.#port.revision() })
    if (signature !== this.#lastSignature) { this.#lastSignature = signature; this.#revision++ }
    return this.#revision
  }
}
