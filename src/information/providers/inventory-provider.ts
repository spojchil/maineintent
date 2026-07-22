import { z } from 'zod'
import type {
  InformationProvider, InformationProviderContext, InformationProviderDefinition,
  ProviderAvailability, ProviderReadRequest, ProviderReadResult,
} from '../contracts/index.js'
import type { InventoryPort } from '../source-ports/inventory.js'

export interface InventoryValues {
  selectedHotbarSlot: number
  slots: Array<{ slot: number; itemName: string; count: number }>
}

const slotSchema = z.object({
  slot: z.number().int().min(0),
  itemName: z.string().min(1),
  count: z.number().int().positive(),
})

/** Own-inventory projection; exact internal durability and item metadata remain driver-private. */
export class InventoryProvider implements InformationProvider<InventoryValues> {
  readonly #port: InventoryPort
  #revision = 0
  #lastSignature = ''

  constructor(port: InventoryPort) { this.#port = port }

  readonly definition: InformationProviderDefinition<InventoryValues> = {
    id: 'inventory_information',
    description: '可结构化检查的自身背包内容与当前选中快捷栏槽',
    schemaRevision: 'inventory-information:2',
    audiences: ['companion'] as const,
    fields: {
      selectedHotbarSlot: {
        description: '当前选中的快捷栏槽位（0-8）', valueSchema: z.number().int().min(0).max(8), valueType: 'number',
        precision: 'exactly_displayed', sourceKinds: ['client_state'],
      },
      slots: {
        description: '自身背包中所有非空槽位；不含隐藏 NBT、精确耐久和外部容器内容',
        valueSchema: z.array(slotSchema), valueType: 'array', precision: 'displayed', sourceKinds: ['client_state'],
      },
    },
    scopeDependencies: ['connection', 'world'] as const,
    limits: { maxFieldsPerRead: 2, maxResultBytes: 16_384, timeoutMs: 2_000 },
  }

  availability(): ProviderAvailability<InventoryValues> {
    return { overall: 'available', informationRevision: this.#revisionFor(project(this.#port.current())), fields: {} }
  }

  async read(
    context: InformationProviderContext,
    request: ProviderReadRequest<InventoryValues, never, never>,
    _signal: AbortSignal,
  ): Promise<ProviderReadResult<InventoryValues, never>> {
    const inventory = project(this.#port.current())
    const revision = this.#revisionFor(inventory)
    const values: Partial<InventoryValues> = {}
    for (const field of request.fields) Object.assign(values, { [field]: structuredClone(inventory[field]) })
    return {
      informationRevision: revision, values, unavailable: [],
      source: {
        kind: 'client_state', adapterRevision: 'inventory-provider.v2', sourceRevision: revision,
        acquisition: 'structured_ui_equivalent',
      },
      observedAt: context.now, evidenceIds: [],
    }
  }

  #revisionFor(inventory: InventoryValues): number {
    const signature = JSON.stringify(inventory)
    if (signature !== this.#lastSignature) { this.#lastSignature = signature; this.#revision++ }
    return this.#revision
  }
}

function project(inventory: ReturnType<InventoryPort['current']>): InventoryValues {
  return {
    selectedHotbarSlot: inventory.selectedHotbarSlot,
    slots: inventory.slots.map(({ slot, itemName, count }) => ({ slot, itemName, count })),
  }
}
