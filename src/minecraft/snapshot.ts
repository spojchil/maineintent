import type { MinecraftSnapshotV1, TrackedPlayerSnapshot } from './contracts.js'
import { entityDto, finiteNumber, vectorDto } from './dto.js'
import type { BotLike } from './internal.js'

export interface SnapshotContext {
  worldId: string
  processSessionId: string
  connectionEpoch: number
  connectionAttemptId: string
  lifecycleRevision: number
  snapshotRevision: number
  capturedAt: string
}

const gameModes = new Set(['survival', 'creative', 'adventure', 'spectator'])

export function readiness(bot: BotLike, allowDead = false): Record<string, boolean> {
  const entity = bot.entity
  const game = bot.game
  return {
    entityPresent: Boolean(entity),
    finitePosition: Boolean(entity && [entity.position.x, entity.position.y, entity.position.z].every(Number.isFinite)),
    finiteYawPitch: Boolean(entity && Number.isFinite(entity.yaw ?? 0) && Number.isFinite(entity.pitch ?? 0)),
    positiveHealth: typeof bot.health === 'number' && (bot.health > 0 || allowDead),
    foodKnown: typeof bot.food === 'number',
    inventoryPresent: Array.isArray(bot.inventory?.slots),
    dimensionKnown: typeof game?.dimension === 'string' && game.dimension.length > 0,
    gameModeKnown: typeof game?.gameMode === 'string' && gameModes.has(game.gameMode),
    versionMatches: bot.version === '1.21.1',
  }
}

export function isReady(bot: BotLike): boolean {
  return Object.values(readiness(bot)).every(Boolean)
}

export function buildSnapshot(bot: BotLike, context: SnapshotContext, allowDead = false): MinecraftSnapshotV1 {
  if (!Object.values(readiness(bot, allowDead)).every(Boolean) || !bot.entity) throw new Error(`Backend is not snapshot-ready: ${JSON.stringify(readiness(bot, allowDead))}`)
  const selfEntity = entityDto(bot.entity, context.connectionEpoch)
  const game = bot.game
  const mode = game?.gameMode
  if (!mode || !gameModes.has(mode)) throw new Error(`Unsupported game mode: ${String(mode)}`)

  const effects = Object.entries(bot.entity.effects ?? {}).map(([name, effect]) => ({
    name,
    amplifier: effect.amplifier ?? 0,
    ...(effect.duration === undefined ? {} : { durationTicks: effect.duration }),
  }))

  const slots = (bot.inventory?.slots ?? []).flatMap((item, slot) => item?.name ? [{
    slot,
    itemName: item.name,
    count: item.count ?? 1,
    ...(item.metadata === undefined ? {} : { metadata: item.metadata }),
    ...(item.durabilityUsed === undefined ? {} : { durabilityUsed: item.durabilityUsed }),
  }] : [])

  const trackedPlayers: TrackedPlayerSnapshot[] = Object.values(bot.players).map(player => {
    const entity = player.entity
    return {
      playerKey: player.uuid ?? player.username,
      ...(player.uuid ? { uuid: player.uuid } : {}),
      username: player.username,
      listed: true,
      entityTracked: Boolean(entity),
      ...(entity ? {
        position: vectorDto(entity.position),
        yaw: finiteNumber(entity.yaw ?? 0, 'player.yaw'),
        pitch: finiteNumber(entity.pitch ?? 0, 'player.pitch'),
        ...(entity.heldItem?.name ? { heldItemName: entity.heldItem.name } : {}),
      } : {}),
    }
  }).sort((a, b) => a.username.localeCompare(b.username))

  return structuredClone({
    protocol: 'mineintent.minecraft.snapshot.v1',
    snapshotRevision: context.snapshotRevision,
    lifecycleRevision: context.lifecycleRevision,
    capturedAt: context.capturedAt,
    processSessionId: context.processSessionId,
    connectionEpoch: context.connectionEpoch,
    connectionAttemptId: context.connectionAttemptId,
    world: {
      worldId: context.worldId,
      dimension: game!.dimension!,
      minecraftVersion: '1.21.1',
      protocolVersion: finiteNumber(bot.protocolVersion ?? 0, 'protocolVersion'),
      gameMode: mode as MinecraftSnapshotV1['world']['gameMode'],
      ...(game?.difficulty ? { difficulty: game.difficulty as MinecraftSnapshotV1['world']['difficulty'] } : {}),
      minY: finiteNumber(game?.minY ?? -64, 'minY'),
      height: finiteNumber(game?.height ?? 384, 'height'),
      ...(game?.serverViewDistance === undefined ? {} : { serverViewDistance: game.serverViewDistance }),
      ...(bot.time?.timeOfDay === undefined ? {} : { timeOfDay: bot.time.timeOfDay }),
      ...(bot.isRaining === undefined ? {} : { isRaining: bot.isRaining }),
    },
    self: {
      entityKey: selfEntity.entityKey,
      username: bot.username,
      position: selfEntity.position,
      velocity: selfEntity.velocity,
      yaw: selfEntity.yaw,
      pitch: selfEntity.pitch,
      onGround: selfEntity.onGround,
      alive: (bot.health ?? 0) > 0,
      health: finiteNumber(bot.health, 'health'),
      food: finiteNumber(bot.food, 'food'),
      foodSaturation: finiteNumber(bot.foodSaturation ?? 0, 'foodSaturation'),
      ...(bot.oxygenLevel === undefined ? {} : { oxygen: bot.oxygenLevel }),
      ...(bot.experience ? { experience: {
        level: bot.experience.level ?? 0,
        progress: bot.experience.progress ?? 0,
        total: bot.experience.points ?? 0,
      } } : {}),
      effects,
    },
    inventory: { selectedHotbarSlot: bot.quickBarSlot ?? 0, slots },
    trackedPlayers,
  } satisfies MinecraftSnapshotV1)
}
