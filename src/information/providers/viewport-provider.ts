import { z } from 'zod'
import type {
  InformationProvider, InformationProviderContext, InformationProviderDefinition,
  ProviderAvailability, ProviderReadRequest, ProviderReadResult, ViewportObservationRefPayload,
} from '../contracts/index.js'
import {
  raycastLookedAtBlock, standingOnBlock, viewRelativePosition, visibleBlocks, visibleEntities,
  type PerceptionPort,
} from '../source-ports/perception.js'

export interface ViewportValues {
  standingOnBlock: { ref: string; name: string; relativePosition: [number, number, number] } | null
  lookedAtBlock: { ref: string; name: string; distance: number; relativePosition: [number, number, number] } | null
  visibleEntities: Array<{
    ref: string
    type: string
    name?: string
    username?: string
    distanceBand: 'very_near' | 'near' | 'medium' | 'far'
    direction: 'ahead' | 'right' | 'behind' | 'left'
    relativePosition: [number, number, number]
  }>
  visibleBlocks: {
    blocks: Array<{ ref: string; relativePosition: [number, number, number]; name: string }>
    truncated: boolean
  }
}

const relativePositionSchema = z.tuple([z.number(), z.number(), z.number()])
const standingOnBlockSchema = z.object({
  ref: z.string().min(1), name: z.string().min(1), relativePosition: relativePositionSchema,
}).nullable()
const lookedAtBlockSchema = z.object({
  ref: z.string().min(1), name: z.string().min(1), distance: z.number().min(0), relativePosition: relativePositionSchema,
}).nullable()
const visibleEntitySchema = z.array(z.object({
  ref: z.string().min(1),
  type: z.string().min(1),
  name: z.string().min(1).optional(),
  username: z.string().min(1).optional(),
  distanceBand: z.enum(['very_near', 'near', 'medium', 'far']),
  direction: z.enum(['ahead', 'right', 'behind', 'left']),
  relativePosition: relativePositionSchema,
}))
const visibleBlocksSchema = z.object({
  blocks: z.array(z.object({
    ref: z.string().min(1),
    relativePosition: relativePositionSchema,
    name: z.string().min(1),
  })),
  truncated: z.boolean(),
})

const MAX_LOOK_DISTANCE = 4.5
const MAX_ENTITY_DISTANCE = 32
const MAX_ENTITIES = 8
const MAX_VISIBLE_BLOCKS = 256
const VIEW_HALF_ANGLE = (45 * Math.PI) / 180
const VISIBLE_BLOCKS_OPTIONS = {
  horizontalRadius: 32,
  verticalRadius: 20,
  maxDistance: 32,
  halfAngle: VIEW_HALF_ANGLE,
  limit: MAX_VISIBLE_BLOCKS,
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
    schemaRevision: 'viewport-information:7',
    audiences: ['companion'] as const,
    fields: {
      standingOnBlock: {
        description: '由当前脚下位置推断的方块；含不透明引用和量化的[右,上,前]观察相对坐标，无法形成证据时为 null',
        valueSchema: standingOnBlockSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      lookedAtBlock: {
        description: '准星精确射线首先命中的可见方块；含不透明引用和量化的[右,上,前]观察相对坐标，约受原版 4.5 格交互距离约束',
        valueSchema: lookedAtBlockSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      visibleEntities: {
        description: '通过视锥与多点遮挡验证的当前可见实体；含不透明引用和量化的[右,上,前]观察相对坐标，不包含仅被协议追踪的墙后或背后实体',
        valueSchema: visibleEntitySchema, valueType: 'array', precision: 'inferred', sourceKinds: ['viewport_projection'],
      },
      visibleBlocks: {
        description: '当前视野内通过粗略遮挡验证的方块表面；每项含不透明引用、[右,上,前] 相对位置和名称，可能截断',
        valueSchema: visibleBlocksSchema, valueType: 'object', precision: 'inferred', sourceKinds: ['viewport_projection'],
        notes: '透明材质依据客户端 hint 保守近似；不是像素级渲染结果',
      },
    },
    scopeDependencies: ['connection', 'world', 'dimension'] as const,
    limits: { maxFieldsPerRead: 4, maxResultBytes: 65_536, timeoutMs: 5_000 },
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
    const pose = this.#port.selfPose()
    const evidenceIds = [`viewport_${context.scope.connectionEpoch}_${revision}`]
    const validUntil = new Date(Date.parse(context.now) + 15_000).toISOString()
    const values: Partial<ViewportValues> = {}
    if (request.fields.includes('standingOnBlock')) {
      const block = standingOnBlock(this.#port)
      values.standingOnBlock = block ? {
        ref: this.#issueBlockRef(context, revision, validUntil, evidenceIds, block).id,
        name: block.name,
        relativePosition: viewRelativePosition(pose, block.position),
      } : null
    }
    if (request.fields.includes('lookedAtBlock')) {
      const block = raycastLookedAtBlock(this.#port, MAX_LOOK_DISTANCE)
      values.lookedAtBlock = block ? {
        ref: this.#issueBlockRef(context, revision, validUntil, evidenceIds, block).id,
        name: block.name,
        distance: block.distance,
        relativePosition: viewRelativePosition(pose, block.position),
      } : null
    }
    if (request.fields.includes('visibleEntities')) {
      values.visibleEntities = visibleEntities(this.#port, MAX_ENTITY_DISTANCE, VIEW_HALF_ANGLE, MAX_ENTITIES).map(entity => ({
        ref: context.refs.issue<ViewportObservationRefPayload>({
          kind: 'viewport.entity',
          payload: {
            kind: 'entity', entityKey: entity.entityKey, type: entity.type,
            ...(entity.name ? { name: entity.name } : {}),
            ...(entity.username ? { username: entity.username } : {}),
            position: entity.position, evidenceIds,
          },
          allowedInterfaces: ['viewport_information'],
          basedOnInformationRevision: revision,
          validUntil,
        }).id,
        type: entity.type,
        ...(entity.name ? { name: entity.name } : {}),
        ...(entity.username ? { username: entity.username } : {}),
        distanceBand: entity.distanceBand,
        direction: entity.direction,
        relativePosition: viewRelativePosition(pose, entity.position),
      }))
    }
    if (request.fields.includes('visibleBlocks')) {
      const result = await visibleBlocks(this.#port, VISIBLE_BLOCKS_OPTIONS, signal)
      values.visibleBlocks = {
        blocks: result.blocks.map(block => ({
          ref: this.#issueBlockRef(context, revision, validUntil, evidenceIds, block).id,
          relativePosition: viewRelativePosition(pose, block.position),
          name: block.name,
        })),
        truncated: result.truncated,
      }
    }
    return {
      informationRevision: revision, values, unavailable: [],
      source: {
        kind: 'viewport_projection', adapterRevision: 'viewport-provider.v3', sourceRevision: revision,
        acquisition: 'current_perception',
      },
      observedAt: context.now, validUntil, evidenceIds,
    }
  }

  #issueBlockRef(
    context: InformationProviderContext,
    revision: number,
    validUntil: string,
    evidenceIds: string[],
    block: { name: string; position: { x: number; y: number; z: number } },
  ) {
    return context.refs.issue<ViewportObservationRefPayload>({
      kind: 'viewport.block',
      payload: { kind: 'block', name: block.name, position: block.position, evidenceIds },
      allowedInterfaces: ['viewport_information'],
      basedOnInformationRevision: revision,
      validUntil,
    })
  }

  #revisionFor(): number {
    const signature = JSON.stringify({ pose: this.#port.selfPose(), sourceRevision: this.#port.revision() })
    if (signature !== this.#lastSignature) { this.#lastSignature = signature; this.#revision++ }
    return this.#revision
  }
}
