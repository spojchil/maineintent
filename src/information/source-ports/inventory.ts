export interface InventorySlotSnapshot {
  slot: number
  itemName: string
  count: number
  metadata?: number
  durabilityUsed?: number
}

export interface InventoryStateSnapshot {
  selectedHotbarSlot: number
  slots: InventorySlotSnapshot[]
}

export interface InventoryPort {
  current(): InventoryStateSnapshot
}
