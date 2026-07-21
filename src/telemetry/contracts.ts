import type { PassiveObservations } from '../information/index.js'
import type { BackendState, Vec3Value } from '../minecraft/contracts.js'
import type { BodyResource } from '../actions/contracts.js'

export interface DebugFailureSummary {
  at: string
  source: 'backend' | 'model' | 'action' | 'memory' | 'runtime'
  code: string
  summary: string
}

export interface DebugContextSource {
  id: string
  kind: 'runtime' | 'event' | 'profile' | 'memory' | 'player' | 'skill_registry' | 'summary'
  size: number
}

export interface CompanionDebugState {
  protocol: 'mineintent.debug-state.v1'
  revision: number
  capturedAt: string
  connection: Readonly<BackendState>
  body?: {
    position: Vec3Value
    health: number
    food: number
    inventory: Array<{ itemName: string; count: number }>
  }
  attention?: { kind: string; target?: string }
  activity?: { id: string; kind: string; status: string; summary: string; anchor?: Vec3Value }
  intent?: { kind: string; summary: string }
  currentAction?: { id: string; skill: string; purpose: string; startedAt: string }
  resourceLocks: Readonly<Record<BodyResource, string | undefined>>
  recentFailures: readonly DebugFailureSummary[]
  observations?: PassiveObservations
  decision?: {
    status: 'idle' | 'running' | 'failed'
    runId?: string
    model?: string
    startedAt?: string
    contextSources: readonly DebugContextSource[]
    retrievedMemoryIds: readonly string[]
  }
}

export type DebugStateInput = Omit<CompanionDebugState, 'protocol' | 'revision' | 'capturedAt'>
