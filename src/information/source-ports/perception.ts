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

interface RayHit { voxel: Point3; name: string; distance: number }

/** Steps a ray from `eye` along `direction` and returns the first solid voxel it enters. */
function firstSolidHit(port: PerceptionPort, eye: Point3, direction: Point3, maxDistance: number): RayHit | 'unloaded' | null {
  const steps = Math.floor(maxDistance / STEP)
  for (let step = 1; step <= steps; step++) {
    const distance = step * STEP
    const point: Point3 = {
      x: eye.x + direction.x * distance,
      y: eye.y + direction.y * distance,
      z: eye.z + direction.z * distance,
    }
    const voxel: Point3 = { x: Math.floor(point.x), y: Math.floor(point.y), z: Math.floor(point.z) }
    const block = port.blockAt(voxel)
    if (block === 'unloaded') return 'unloaded'
    if (block.solid) return { voxel, name: block.name, distance }
  }
  return null
}

/**
 * A single ray along the exact current yaw/pitch, matching vanilla's own targeted-block
 * mechanic (block_interaction_range: a fixed-distance raycast through the crosshair,
 * independent of the FOV render setting — see docs research). Not finding anything is a
 * normal, common result, not a sign of broken vision; a wider field of view is a separate,
 * more complex design (full FOV/DDA viewport) intentionally out of scope here.
 */
export function raycastLookedAtBlock(port: PerceptionPort, maxDistance: number): LookedAtBlock | null {
  const pose = port.selfPose()
  const direction = lookDirection(pose.yaw, pose.pitch)
  const eye: Point3 = { x: pose.position.x, y: pose.position.y + EYE_HEIGHT, z: pose.position.z }
  const hit = firstSolidHit(port, eye, direction, maxDistance)
  return hit === 'unloaded' || hit === null ? null : { name: hit.name, distance: hit.distance }
}

export interface VisibleBlock { offset: Point3; distance: number; name: string }

export interface VisibleBlocksOptions {
  horizontalRadius: number
  verticalRadius: number
  maxDistance: number
  /** Half-angle of the view cone, radians. Approximates vanilla's default 70° FOV (half ≈ 35°); a circular cone, not the real rectangular frustum — a coarse approximation, not a claim of exact FOV geometry. */
  halfAngle: number
  limit: number
}

/**
 * Layered visibility filter: exposed-face check (cheap, geometry-only) → frustum+distance cull
 * (cheap) → per-candidate ray occlusion test (the only expensive step, run on survivors only).
 * Blocks are treated as solid unit cubes for the occlusion test — non-full blocks (stairs,
 * fences, torches, carpets) are a known, deliberately deferred simplification (see design
 * discussion); a block fully surrounded by solid neighbors is skipped without ever needing an
 * occlusion test, since it can never be exposed to open air.
 */
export function visibleBlocks(port: PerceptionPort, options: VisibleBlocksOptions): { blocks: VisibleBlock[]; truncated: boolean } {
  const pose = port.selfPose()
  const eye: Point3 = { x: pose.position.x, y: pose.position.y + EYE_HEIGHT, z: pose.position.z }
  const facing = lookDirection(pose.yaw, pose.pitch)
  const cosThreshold = Math.cos(options.halfAngle)
  const selfVoxel: Point3 = { x: Math.floor(pose.position.x), y: Math.floor(pose.position.y), z: Math.floor(pose.position.z) }

  const candidates: VisibleBlock[] = []
  for (let dx = -options.horizontalRadius; dx <= options.horizontalRadius; dx++) {
    for (let dz = -options.horizontalRadius; dz <= options.horizontalRadius; dz++) {
      for (let dy = -options.verticalRadius; dy <= options.verticalRadius; dy++) {
        const voxel: Point3 = { x: selfVoxel.x + dx, y: selfVoxel.y + dy, z: selfVoxel.z + dz }
        const block = port.blockAt(voxel)
        if (block === 'unloaded' || !block.solid) continue
        if (!hasExposedFace(port, voxel)) continue

        const center: Point3 = { x: voxel.x + 0.5, y: voxel.y + 0.5, z: voxel.z + 0.5 }
        const toBlock: Point3 = { x: center.x - eye.x, y: center.y - eye.y, z: center.z - eye.z }
        const distance = Math.hypot(toBlock.x, toBlock.y, toBlock.z)
        if (distance > options.maxDistance) continue
        if (distance > 0 && (toBlock.x * facing.x + toBlock.y * facing.y + toBlock.z * facing.z) / distance < cosThreshold) continue

        if (!isVisibleFromEye(port, eye, voxel, distance)) continue
        candidates.push({ offset: { x: dx, y: dy, z: dz }, distance, name: block.name })
      }
    }
  }

  candidates.sort((left, right) => left.distance - right.distance)
  const truncated = candidates.length > options.limit
  return { blocks: candidates.slice(0, options.limit), truncated }
}

function hasExposedFace(port: PerceptionPort, voxel: Point3): boolean {
  const neighbors: Point3[] = [
    { x: voxel.x + 1, y: voxel.y, z: voxel.z }, { x: voxel.x - 1, y: voxel.y, z: voxel.z },
    { x: voxel.x, y: voxel.y + 1, z: voxel.z }, { x: voxel.x, y: voxel.y - 1, z: voxel.z },
    { x: voxel.x, y: voxel.y, z: voxel.z + 1 }, { x: voxel.x, y: voxel.y, z: voxel.z - 1 },
  ]
  return neighbors.some((neighbor) => {
    const block = port.blockAt(neighbor)
    return block === 'unloaded' || !block.solid
  })
}

function isVisibleFromEye(port: PerceptionPort, eye: Point3, targetVoxel: Point3, distanceToCenter: number): boolean {
  if (distanceToCenter === 0) return true
  const center: Point3 = { x: targetVoxel.x + 0.5, y: targetVoxel.y + 0.5, z: targetVoxel.z + 0.5 }
  const direction: Point3 = {
    x: (center.x - eye.x) / distanceToCenter, y: (center.y - eye.y) / distanceToCenter, z: (center.z - eye.z) / distanceToCenter,
  }
  const hit = firstSolidHit(port, eye, direction, distanceToCenter + STEP)
  if (hit === 'unloaded' || hit === null) return false
  return hit.voxel.x === targetVoxel.x && hit.voxel.y === targetVoxel.y && hit.voxel.z === targetVoxel.z
}

export function standingOnBlock(port: PerceptionPort): { name: string } | null {
  const pose = port.selfPose()
  const below = port.blockAt({
    x: Math.floor(pose.position.x), y: Math.floor(pose.position.y) - 1, z: Math.floor(pose.position.z),
  })
  return below === 'unloaded' ? null : { name: below.name }
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
