import type { RelativeDirection } from '../geometry.js'

export interface SoundObservation {
  soundName?: string
  category?: string
  distance: number
  direction: RelativeDirection
  volume: number
  pitch: number
  observedAt: string
}

export interface SoundHistoryPort {
  recent(limit: number): readonly SoundObservation[]
  revision(): number
}
