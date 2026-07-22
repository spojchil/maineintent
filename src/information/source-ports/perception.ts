import { setImmediate as yieldToEventLoop } from 'node:timers/promises'
import { distanceBetween, lookDirection, relativeBearing, type Point3, type RelativeDirection } from '../geometry.js'

export interface PerceptionPose {
  position: Point3
  yaw: number
  pitch: number
}

export interface PerceptionBlock {
  name: string
  /** The block has a visible representation; air is false even though it is transparent. */
  visible: boolean
  /** Conservative optical occlusion hint. Unknown non-transparent blocks must be true. */
  occludes: boolean
}

export interface PerceptionEntityCandidate {
  type: string
  name?: string
  username?: string
  position: Point3
  width?: number
  height?: number
}

export interface PerceptionPort {
  selfPose(): PerceptionPose
  revision(): number
  /** Returns 'unloaded' when the position is outside the currently loaded/known world. */
  blockAt(position: Point3): PerceptionBlock | 'unloaded'
  /** Driver candidates only; callers must prove visibility before publishing them. */
  nearbyEntities(): readonly PerceptionEntityCandidate[]
}

export interface LookedAtBlock { name: string; distance: number }

export interface VisibleEntity {
  type: string
  name?: string
  username?: string
  distanceBand: 'very_near' | 'near' | 'medium' | 'far'
  direction: RelativeDirection
}

const EYE_HEIGHT = 1.62
const STEP = 0.25
const YIELD_EVERY_VOXELS = 2_048

interface RayHit { voxel: Point3; name: string; distance: number }

function firstVisibleHit(
  port: PerceptionPort, eye: Point3, direction: Point3, maxDistance: number,
): RayHit | 'unloaded' | null {
  const steps = Math.floor(maxDistance / STEP)
  for (let step = 1; step <= steps; step++) {
    const distance = step * STEP
    const voxel = voxelAlong(eye, direction, distance)
    const block = port.blockAt(voxel)
    if (block === 'unloaded') return 'unloaded'
    if (block.visible) return { voxel, name: block.name, distance }
  }
  return null
}

function firstOccludingHit(
  port: PerceptionPort, eye: Point3, direction: Point3, maxDistance: number,
): RayHit | 'unloaded' | null {
  const steps = Math.floor(maxDistance / STEP)
  for (let step = 1; step <= steps; step++) {
    const distance = step * STEP
    const voxel = voxelAlong(eye, direction, distance)
    const block = port.blockAt(voxel)
    if (block === 'unloaded') return 'unloaded'
    if (block.occludes) return { voxel, name: block.name, distance }
  }
  return null
}

function voxelAlong(origin: Point3, direction: Point3, distance: number): Point3 {
  return {
    x: Math.floor(origin.x + direction.x * distance),
    y: Math.floor(origin.y + direction.y * distance),
    z: Math.floor(origin.z + direction.z * distance),
  }
}

/** Crosshair-style single ray. Visible non-collision blocks are targets, not invisible air. */
export function raycastLookedAtBlock(port: PerceptionPort, maxDistance: number): LookedAtBlock | null {
  const pose = port.selfPose()
  const direction = lookDirection(pose.yaw, pose.pitch)
  const eye: Point3 = { x: pose.position.x, y: pose.position.y + EYE_HEIGHT, z: pose.position.z }
  const hit = firstVisibleHit(port, eye, direction, maxDistance)
  return hit === 'unloaded' || hit === null ? null : { name: hit.name, distance: hit.distance }
}

export interface VisibleBlock { offset: Point3; distance: number; name: string }

export interface VisibleBlocksOptions {
  horizontalRadius: number
  verticalRadius: number
  maxDistance: number
  halfAngle: number
  limit: number
}

/**
 * Cooperative coarse viewport projection. Geometry is culled before world reads, optical
 * occlusion is checked per survivor, and the loop yields so chat/cancellation can progress.
 */
export async function visibleBlocks(
  port: PerceptionPort,
  options: VisibleBlocksOptions,
  signal?: AbortSignal,
): Promise<{ blocks: VisibleBlock[]; truncated: boolean }> {
  const pose = port.selfPose()
  const eye: Point3 = { x: pose.position.x, y: pose.position.y + EYE_HEIGHT, z: pose.position.z }
  const facing = lookDirection(pose.yaw, pose.pitch)
  const cosThreshold = Math.cos(options.halfAngle)
  const selfVoxel: Point3 = {
    x: Math.floor(pose.position.x), y: Math.floor(pose.position.y), z: Math.floor(pose.position.z),
  }

  const candidates: VisibleBlock[] = []
  let scanned = 0
  for (let dx = -options.horizontalRadius; dx <= options.horizontalRadius; dx++) {
    for (let dz = -options.horizontalRadius; dz <= options.horizontalRadius; dz++) {
      for (let dy = -options.verticalRadius; dy <= options.verticalRadius; dy++) {
        if (++scanned % YIELD_EVERY_VOXELS === 0) {
          signal?.throwIfAborted()
          await yieldToEventLoop()
        }
        const voxel: Point3 = { x: selfVoxel.x + dx, y: selfVoxel.y + dy, z: selfVoxel.z + dz }
        const center: Point3 = { x: voxel.x + 0.5, y: voxel.y + 0.5, z: voxel.z + 0.5 }
        const toBlock: Point3 = { x: center.x - eye.x, y: center.y - eye.y, z: center.z - eye.z }
        const distance = Math.hypot(toBlock.x, toBlock.y, toBlock.z)
        if (distance > options.maxDistance) continue
        if (distance > 0 && dot(toBlock, facing) / distance < cosThreshold) continue

        const block = port.blockAt(voxel)
        if (block === 'unloaded' || !block.visible) continue
        if (!hasExposedFace(port, voxel)) continue
        if (!isVisibleFromEye(port, eye, voxel, distance)) continue
        candidates.push({ offset: { x: dx, y: dy, z: dz }, distance, name: block.name })
      }
    }
  }
  signal?.throwIfAborted()
  candidates.sort((left, right) => left.distance - right.distance)
  return { blocks: candidates.slice(0, options.limit), truncated: candidates.length > options.limit }
}

function hasExposedFace(port: PerceptionPort, voxel: Point3): boolean {
  const neighbors: Point3[] = [
    { x: voxel.x + 1, y: voxel.y, z: voxel.z }, { x: voxel.x - 1, y: voxel.y, z: voxel.z },
    { x: voxel.x, y: voxel.y + 1, z: voxel.z }, { x: voxel.x, y: voxel.y - 1, z: voxel.z },
    { x: voxel.x, y: voxel.y, z: voxel.z + 1 }, { x: voxel.x, y: voxel.y, z: voxel.z - 1 },
  ]
  return neighbors.some((neighbor) => {
    const block = port.blockAt(neighbor)
    return block === 'unloaded' || !block.visible
  })
}

function isVisibleFromEye(port: PerceptionPort, eye: Point3, targetVoxel: Point3, distanceToCenter: number): boolean {
  if (distanceToCenter === 0) return true
  const center: Point3 = { x: targetVoxel.x + 0.5, y: targetVoxel.y + 0.5, z: targetVoxel.z + 0.5 }
  const direction = normalize({ x: center.x - eye.x, y: center.y - eye.y, z: center.z - eye.z }, distanceToCenter)
  const hit = firstOccludingHit(port, eye, direction, distanceToCenter + STEP)
  if (hit === 'unloaded') return false
  if (hit === null) return true
  return sameVoxel(hit.voxel, targetVoxel)
}

export function visibleEntities(
  port: PerceptionPort,
  maxDistance: number,
  halfAngle: number,
  limit: number,
): VisibleEntity[] {
  const pose = port.selfPose()
  const eye: Point3 = { x: pose.position.x, y: pose.position.y + EYE_HEIGHT, z: pose.position.z }
  const facing = lookDirection(pose.yaw, pose.pitch)
  const cosThreshold = Math.cos(halfAngle)
  return port.nearbyEntities().flatMap((entity): VisibleEntity[] => {
    const height = entity.height ?? 1.8
    const center: Point3 = { x: entity.position.x, y: entity.position.y + height / 2, z: entity.position.z }
    const toCenter = { x: center.x - eye.x, y: center.y - eye.y, z: center.z - eye.z }
    const distance = Math.hypot(toCenter.x, toCenter.y, toCenter.z)
    if (distance === 0 || distance > maxDistance || dot(toCenter, facing) / distance < cosThreshold) return []
    const sampleHeights = [0.85, 0.5, 0.15]
    const visible = sampleHeights.some((fraction) => lineIsClear(port, eye, {
      x: entity.position.x, y: entity.position.y + height * fraction, z: entity.position.z,
    }))
    if (!visible) return []
    return [{
      type: entity.type,
      ...(entity.name ? { name: entity.name } : {}),
      ...(entity.username ? { username: entity.username } : {}),
      distanceBand: distance <= 2.5 ? 'very_near' : distance <= 8 ? 'near' : distance <= 24 ? 'medium' : 'far',
      direction: relativeBearing(pose.yaw, pose.position, entity.position),
    }]
  }).slice(0, limit)
}

function lineIsClear(port: PerceptionPort, origin: Point3, target: Point3): boolean {
  const delta = { x: target.x - origin.x, y: target.y - origin.y, z: target.z - origin.z }
  const distance = Math.hypot(delta.x, delta.y, delta.z)
  if (distance === 0) return true
  return firstOccludingHit(port, origin, normalize(delta, distance), Math.max(0, distance - STEP)) === null
}

export function standingOnBlock(port: PerceptionPort): { name: string } | null {
  const pose = port.selfPose()
  const below = port.blockAt({
    x: Math.floor(pose.position.x), y: Math.floor(pose.position.y) - 1, z: Math.floor(pose.position.z),
  })
  return below === 'unloaded' || !below.visible ? null : { name: below.name }
}

/** Converts a world-axis voxel offset to coarse [right, up, forward] view-relative coordinates. */
export function viewRelativeOffset(pose: PerceptionPose, offset: Point3): [number, number, number] {
  const forward = lookDirection(pose.yaw, 0)
  const right = { x: -forward.z, z: forward.x }
  return [
    roundTenth(offset.x * right.x + offset.z * right.z),
    offset.y,
    roundTenth(offset.x * forward.x + offset.z * forward.z),
  ]
}

function dot(left: Point3, right: Point3): number { return left.x * right.x + left.y * right.y + left.z * right.z }
function normalize(value: Point3, length: number): Point3 { return { x: value.x / length, y: value.y / length, z: value.z / length } }
function sameVoxel(left: Point3, right: Point3): boolean { return left.x === right.x && left.y === right.y && left.z === right.z }
function roundTenth(value: number): number { const rounded = Math.round(value * 10) / 10; return Object.is(rounded, -0) ? 0 : rounded }
