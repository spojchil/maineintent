export interface SelfVitalsSnapshot {
  health: number
  food: number
  foodSaturation: number
  oxygen?: number
  experience?: { level: number; progress: number; total: number }
  effects: Array<{ name: string; amplifier: number; durationTicks?: number }>
}

export interface SelfVitalsPort {
  current(): SelfVitalsSnapshot
}
