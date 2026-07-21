import { Vec3 } from 'vec3'
import type {
  AabbValue,
  BlockPosition,
  BlockReadResult,
  ProtocolBlockSnapshot,
  ProtocolEntitySnapshot,
  Vec3Value,
} from './contracts.js'
import type { BlockLike, BotLike, EntityLike, ItemLike, VectorLike } from './internal.js'

export function finiteNumber(value: unknown, field: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`Invalid finite number: ${field}`)
  return value
}

export function vectorDto(value: VectorLike, field = 'vector'): Vec3Value {
  return {
    x: finiteNumber(value.x, `${field}.x`),
    y: finiteNumber(value.y, `${field}.y`),
    z: finiteNumber(value.z, `${field}.z`),
  }
}

function itemName(item: ItemLike | null | undefined): string | undefined {
  return typeof item?.name === 'string' && item.name.length > 0 ? item.name : undefined
}

export function entityDto(entity: EntityLike, epoch: number): ProtocolEntitySnapshot {
  const equipment = (entity.equipment ?? []).flatMap((item, slot) => {
    const name = itemName(item)
    return name ? [{ slot, itemName: name, count: item?.count ?? 1 }] : []
  })
  return {
    entityKey: `${epoch}:${entity.id}`,
    protocolEntityId: entity.id,
    type: entity.type ?? 'unknown',
    ...(entity.name ? { name: entity.name } : {}),
    ...(entity.username ? { username: entity.username } : {}),
    ...(entity.uuid ? { uuid: entity.uuid } : {}),
    position: vectorDto(entity.position, 'entity.position'),
    velocity: vectorDto(entity.velocity ?? { x: 0, y: 0, z: 0 }, 'entity.velocity'),
    yaw: finiteNumber(entity.yaw ?? 0, 'entity.yaw'),
    pitch: finiteNumber(entity.pitch ?? 0, 'entity.pitch'),
    ...(entity.headYaw === undefined ? {} : { headYaw: finiteNumber(entity.headYaw, 'entity.headYaw') }),
    width: finiteNumber(entity.width ?? 0.6, 'entity.width'),
    height: finiteNumber(entity.height ?? 1.8, 'entity.height'),
    onGround: Boolean(entity.onGround),
    ...(entity.pose ? { pose: entity.pose } : {}),
    ...(itemName(entity.heldItem) ? { heldItemName: itemName(entity.heldItem) } : {}),
    equipment,
    valid: entity.isValid !== false,
  }
}

function safeProperties(block: BlockLike): Record<string, string | number | boolean> {
  const raw = block.getProperties?.() ?? {}
  return Object.fromEntries(Object.entries(raw).filter((entry): entry is [string, string | number | boolean] =>
    ['string', 'number', 'boolean'].includes(typeof entry[1])))
}

export function blockDto(block: BlockLike): ProtocolBlockSnapshot {
  const position = vectorDto(block.position, 'block.position')
  const collisionShapes = (block.shapes ?? []).filter(shape => shape.length === 6).map(shape =>
    shape.map((value, index) => finiteNumber(value, `block.shape.${index}`)) as AabbValue)
  return {
    position: { x: Math.floor(position.x), y: Math.floor(position.y), z: Math.floor(position.z) },
    name: block.name ?? 'unknown',
    stateId: finiteNumber(block.stateId ?? 0, 'block.stateId'),
    properties: safeProperties(block),
    collisionShapes,
    transparentHint: Boolean(block.transparent),
    boundingBox: block.boundingBox === 'empty' ? 'empty' : 'block',
  }
}

export function readBlock(bot: BotLike, position: BlockPosition): BlockReadResult {
  const minY = bot.game?.minY ?? -64
  const height = bot.game?.height ?? 384
  if (position.y < minY || position.y >= minY + height) return { status: 'out_of_world' }
  // prismarine-world's real getBlock() calls Vec3 methods (e.g. .floored()) on the position;
  // a plain {x,y,z} object throws inside it, so it must be a real Vec3 instance here.
  const block = bot.world?.getBlock(new Vec3(position.x, position.y, position.z))
  return block ? { status: 'loaded', block: blockDto(block) } : { status: 'unloaded' }
}
