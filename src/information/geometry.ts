export interface Point3 { x: number; y: number; z: number }

export type RelativeDirection = 'ahead' | 'right' | 'behind' | 'left'

export function distanceBetween(a: Point3, b: Point3): number {
  return Math.hypot(a.x - b.x, a.y - b.y, a.z - b.z)
}

/** Minecraft look-direction convention: yaw 0 faces south (+z), increasing clockwise. */
export function lookDirection(yaw: number, pitch: number): Point3 {
  return {
    x: -Math.sin(yaw) * Math.cos(pitch),
    y: -Math.sin(pitch),
    z: Math.cos(yaw) * Math.cos(pitch),
  }
}

export function relativeBearing(selfYaw: number, selfPosition: Point3, targetPosition: Point3): RelativeDirection {
  const dx = targetPosition.x - selfPosition.x
  const dz = targetPosition.z - selfPosition.z
  if (dx === 0 && dz === 0) return 'ahead'
  const targetYaw = Math.atan2(-dx, dz)
  let delta = targetYaw - selfYaw
  delta = ((delta + Math.PI) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI) - Math.PI
  const quarter = Math.PI / 2
  if (delta >= -quarter / 2 && delta < quarter / 2) return 'ahead'
  if (delta >= quarter / 2 && delta < quarter * 3 / 2) return 'right'
  if (delta >= -quarter * 3 / 2 && delta < -quarter / 2) return 'left'
  return 'behind'
}
