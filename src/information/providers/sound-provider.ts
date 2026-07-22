import { z } from 'zod'
import type {
  InformationProvider, InformationProviderContext, InformationProviderDefinition,
  ProviderAvailability, ProviderReadRequest, ProviderReadResult,
} from '../contracts/index.js'
import type { SoundHistoryPort } from '../source-ports/sound.js'

export interface SoundValues {
  recentSounds: Array<{
    semanticHint?: string
    distanceBand: 'very_near' | 'near' | 'medium' | 'far'
    direction: 'ahead' | 'right' | 'behind' | 'left'
    observedAt: string
    validUntil: string
  }>
}

const soundSchema = z.object({
  semanticHint: z.string().min(1).optional(),
  distanceBand: z.enum(['very_near', 'near', 'medium', 'far']),
  direction: z.enum(['ahead', 'right', 'behind', 'left']),
  observedAt: z.iso.datetime(),
  validUntil: z.iso.datetime(),
})

const RECENT_SOUND_LIMIT = 20

export class SoundInformationProvider implements InformationProvider<SoundValues> {
  readonly #port: SoundHistoryPort

  constructor(port: SoundHistoryPort) { this.#port = port }

  readonly definition: InformationProviderDefinition<SoundValues> = {
    id: 'sound_information',
    description: '当前仍有效的最近听觉观察，使用方向与距离带而不是协议音源坐标',
    schemaRevision: 'sound-information:2',
    audiences: ['companion'] as const,
    fields: {
      recentSounds: {
        description: '最近听到且尚未过期的声音，按时间从新到旧排列', valueSchema: z.array(soundSchema), valueType: 'array',
        precision: 'inferred', sourceKinds: ['sound_projection'],
        notes: '语义只来自 Minecraft 1.21.1 固定映射；未知声音不按 registry 字符串猜测来源',
      },
    },
    scopeDependencies: ['connection', 'world', 'dimension'] as const,
    limits: { maxFieldsPerRead: 1, maxResultBytes: 16_384, timeoutMs: 2_000 },
  }

  availability(): ProviderAvailability<SoundValues> {
    return { overall: 'available', informationRevision: this.#port.revision(), fields: {} }
  }

  async read(
    context: InformationProviderContext,
    request: ProviderReadRequest<SoundValues, never, never>,
    _signal: AbortSignal,
  ): Promise<ProviderReadResult<SoundValues, never>> {
    const values: Partial<SoundValues> = {}
    const recent = this.#port.recent(RECENT_SOUND_LIMIT)
    if (request.fields.includes('recentSounds')) values.recentSounds = [...recent]
    const revision = this.#port.revision()
    const validUntil = recent.map(item => item.validUntil).sort()[0]
    return {
      informationRevision: revision, values, unavailable: [],
      source: {
        kind: 'sound_projection', adapterRevision: 'sound-provider.v2', sourceRevision: revision,
        acquisition: 'current_perception',
      },
      observedAt: context.now, ...(validUntil ? { validUntil } : {}), evidenceIds: [],
    }
  }
}
