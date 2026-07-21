import { distanceBetween, lookDirection, relativeBearing, type Point3, type RelativeDirection } from '../geometry.js'

export interface PerceptionPose {
  position: Point3
  yaw: number
  pitch: number
}

export interface PerceptionBlock {
  name: string
  solid: boolean
}

export interface PerceptionEntityCandidate {
  type: string
  name?: string
  username?: string
  position: Point3
}

export interface PerceptionPort {
  selfPose(): PerceptionPose
  /** Returns 'unloaded' when the position is outside the currently loaded/known world. */
  blockAt(position: Point3): PerceptionBlock | 'unloaded'
  /** Protocol-tracked entities excluding self; a candidate list, not proof of line of sight. */
  nearbyEntities(): readonly PerceptionEntityCandidate[]
}

export interface LookedAtBlock {
  name: string
  distance: number
}

export interface NearbyTrackedEntity {
  type: string
  name?: string
  username?: string
  distance: number
  direction: RelativeDirection
}

const EYE_HEIGHT = 1.62
const STEP = 0.25

export function raycastLookedAtBlock(port: PerceptionPort, maxDistance: number): LookedAtBlock | null {
  const pose = port.selfPose()
  const direction = lookDirection(pose.yaw, pose.pitch)
  const eye: Point3 = { x: pose.position.x, y: pose.position.y + EYE_HEIGHT, z: pose.position.z }
  const steps = Math.floor(maxDistance / STEP)
  for (let step = 1; step <= steps; step++) {
    const distance = step * STEP
    const point: Point3 = {
      x: eye.x + direction.x * distance,
      y: eye.y + direction.y * distance,
      z: eye.z + direction.z * distance,
    }
    const block = port.blockAt({ x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) })
    if (block === 'unloaded') return null
    if (block.solid) return { name: block.name, distance }
  }
  return null
}

export function nearbyTrackedEntities(
  port: PerceptionPort,
  maxDistance: number,
  limit: number,
): NearbyTrackedEntity[] {
  const pose = port.selfPose()
  return port.nearbyEntities()
    .map((entity) => ({
      type: entity.type,
      ...(entity.name ? { name: entity.name } : {}),
      ...(entity.username ? { username: entity.username } : {}),
      distance: distanceBetween(pose.position, entity.position),
      direction: relativeBearing(pose.yaw, pose.position, entity.position),
    }))
    .filter((entity) => entity.distance <= maxDistance)
    .sort((left, right) => left.distance - right.distance)
    .slice(0, limit)
}
