import type { RelativeDirection } from '../geometry.js'

export type SoundDistanceBand = 'very_near' | 'near' | 'medium' | 'far'

export interface SoundObservation {
  /** Conservative semantic label from a version-locked registry map; absent means unidentified. */
  semanticHint?: string
  distanceBand: SoundDistanceBand
  direction: RelativeDirection
  observedAt: string
  validUntil: string
}

export interface SoundHistoryPort {
  recent(limit: number): readonly SoundObservation[]
  revision(): number
}
