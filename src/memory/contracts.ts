export type MemoryKind = 'episode' | 'place' | 'commitment' | 'player_preference'

export interface MemoryEvidence { kind: 'event' | 'action_result'; id: string }

export interface MemoryRecord {
  protocol: 'mineintent.memory.v1'
  id: string
  worldId: string
  kind: MemoryKind
  summary: string
  keywords: string[]
  evidence: MemoryEvidence[]
  createdAt: string
  status: 'active'
}

export interface MemorySearchResult { record: MemoryRecord; score: number }
