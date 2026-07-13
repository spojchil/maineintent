import { z } from 'zod'
import { ActionRuntime, type SkillDefinition } from '../actions/index.js'
import type { MinecraftBackendApi, MinecraftControlsApi, Vec3Value } from '../minecraft/contracts.js'

export const WOOD_BLOCKS = [
  'oak_log', 'spruce_log', 'birch_log', 'jungle_log', 'acacia_log', 'dark_oak_log', 'mangrove_log', 'cherry_log',
  'crimson_stem', 'warped_stem', 'stripped_oak_log', 'stripped_spruce_log', 'stripped_birch_log',
  'stripped_jungle_log', 'stripped_acacia_log', 'stripped_dark_oak_log', 'stripped_mangrove_log', 'stripped_cherry_log',
] as const

export interface CompanionActivityView { anchor?: Vec3Value }

export function registerPrototypeSkills(
  runtime: ActionRuntime,
  backend: MinecraftBackendApi,
  primaryPlayer: string,
  activity: () => CompanionActivityView | undefined,
): void {
  runtime.register(followSkill(() => backend.controls(), () => backend.snapshot(), primaryPlayer))
  runtime.register(collectWoodSkill(() => backend.controls()))
  runtime.register(returnSkill(() => backend.controls(), activity))
  runtime.register(waitSkill())
  runtime.register(escapeSkill(() => backend.controls(), () => backend.snapshot().self.position))
}

function followSkill(
  controls: () => MinecraftControlsApi,
  snapshot: () => ReturnType<MinecraftBackendApi['snapshot']>,
  primaryPlayer: string,
): SkillDefinition<{ range: number }, void> {
  return {
    name: 'follow_player', description: '移动到主要玩家附近', inputSchema: z.strictObject({ range: z.number().min(2).max(8) }),
    requiredResources: ['locomotion', 'gaze'], preconditions: ['backend_ready', 'primary_player_visible'],
    expectedEffects: ['distance_to_primary_player_reduced'], defaultTimeoutMs: 60_000, interruptibility: 'immediate',
    execute: async (ctx, args, signal) => {
      await controls().navigateToPlayer(primaryPlayer, args.range, signal)
      ctx.recordSideEffect({ type: 'position_changed', detail: `moved near ${primaryPlayer}` })
    },
    verify: async (_ctx, args) => {
      const state = snapshot()
      const player = state.trackedPlayers.find(item => item.username.toLocaleLowerCase() === primaryPlayer.toLocaleLowerCase())
      const distance = player?.position ? distanceBetween(state.self.position, player.position) : Number.POSITIVE_INFINITY
      return { verified: distance <= args.range + 1, detail: Number.isFinite(distance) ? `player distance ${distance.toFixed(2)}` : 'primary player is not visible' }
    },
    cleanup: () => controls().stop(),
  }
}

export function collectWoodSkill(controls: () => MinecraftControlsApi): SkillDefinition<{ count: number; maxDistance: number }, { before: number; after: number }> {
  return {
    name: 'collect_wood', description: '寻找可见原木，走近、采集并验证背包增量',
    inputSchema: z.strictObject({ count: z.number().int().min(1).max(16), maxDistance: z.number().int().min(8).max(64) }),
    requiredResources: ['locomotion', 'gaze', 'hands', 'inventory', 'interaction'], preconditions: ['backend_ready', 'survival_capable'],
    expectedEffects: ['wood_block_removed', 'wood_inventory_increased'], defaultTimeoutMs: 180_000, interruptibility: 'immediate',
    execute: async (ctx, args, signal) => {
      const game = controls()
      const before = game.inventoryCount(WOOD_BLOCKS)
      let attempts = 0
      while (game.inventoryCount(WOOD_BLOCKS) - before < args.count) {
        ctx.checkpoint()
        if (++attempts > args.count * 4) throw new Error('Too many wood collection attempts without verified pickup')
        const target = game.findNearestBlock(WOOD_BLOCKS, args.maxDistance)
        if (!target) throw new Error(`No visible wood block within ${args.maxDistance} blocks`)
        await game.navigateNear(target.position, 3, signal)
        const dug = await game.dig(target.position, signal)
        ctx.recordSideEffect({ type: 'block_dug', detail: `${dug.name}@${dug.position.x},${dug.position.y},${dug.position.z}` })
        await game.navigateNear(target.position, 1, signal)
        await abortableDelay(750, signal)
      }
      return { before, after: game.inventoryCount(WOOD_BLOCKS) }
    },
    verify: async (_ctx, args, result) => ({
      verified: result.after - result.before >= args.count,
      detail: `wood inventory ${result.before} -> ${result.after}`,
      observedEffects: [`wood_delta=${result.after - result.before}`],
    }),
    cleanup: () => controls().stop(),
  }
}

function returnSkill(
  controls: () => MinecraftControlsApi,
  activity: () => CompanionActivityView | undefined,
): SkillDefinition<Record<string, never>, Vec3Value> {
  return {
    name: 'return_to_anchor', description: '返回当前共同活动开始时记录的地点', inputSchema: z.strictObject({}),
    requiredResources: ['locomotion', 'gaze'], preconditions: ['backend_ready', 'activity_anchor_exists'],
    expectedEffects: ['distance_to_activity_anchor_reduced'], defaultTimeoutMs: 120_000, interruptibility: 'immediate',
    checkPreconditions: async () => activity()?.anchor ? { ok: true } : { ok: false, detail: 'Current activity has no recorded anchor' },
    execute: async (ctx, _args, signal) => {
      const anchor = activity()?.anchor
      if (!anchor) throw new Error('Activity anchor disappeared')
      await controls().navigateNear(anchor, 2, signal)
      ctx.recordSideEffect({ type: 'position_changed', detail: `returned near ${anchor.x},${anchor.y},${anchor.z}` })
      return anchor
    },
    verify: async (_ctx, _args, anchor) => ({ verified: true, detail: `reached activity anchor near ${anchor.x},${anchor.y},${anchor.z}` }),
    cleanup: () => controls().stop(),
  }
}

function waitSkill(): SkillDefinition<{ durationSeconds: number }, void> {
  return {
    name: 'wait', description: '停止身体动作并等待一小段时间', inputSchema: z.strictObject({ durationSeconds: z.number().int().min(1).max(120) }),
    requiredResources: ['locomotion', 'hands', 'interaction'], preconditions: ['backend_ready'], expectedEffects: ['no_new_body_action'],
    defaultTimeoutMs: 125_000, interruptibility: 'immediate',
    execute: async (_ctx, args, signal) => abortableDelay(args.durationSeconds * 1_000, signal),
    verify: async () => ({ verified: true, detail: 'wait interval completed' }),
  }
}

function escapeSkill(controls: () => MinecraftControlsApi, selfPosition: () => Vec3Value): SkillDefinition<Record<string, never>, Vec3Value> {
  return {
    name: 'escape_threat', description: '确定性地远离最近的直接威胁', inputSchema: z.strictObject({}),
    requiredResources: ['locomotion', 'gaze'], preconditions: ['backend_ready', 'nearby_threat'], expectedEffects: ['distance_from_threat_increased'],
    defaultTimeoutMs: 30_000, interruptibility: 'immediate',
    checkPreconditions: async () => controls().nearestThreat(10) ? { ok: true } : { ok: false, detail: 'No nearby threat' },
    execute: async (ctx, _args, signal) => {
      const threat = controls().nearestThreat(10)
      if (!threat) throw new Error('Threat disappeared')
      const self = selfPosition(), dx = self.x - threat.position.x, dz = self.z - threat.position.z
      const length = Math.max(0.1, Math.hypot(dx, dz))
      const target = { x: self.x + dx / length * 10, y: self.y, z: self.z + dz / length * 10 }
      await controls().navigateNear(target, 2, signal)
      ctx.recordSideEffect({ type: 'threat_avoided', detail: threat.name })
      return target
    },
    verify: async () => ({ verified: !controls().nearestThreat(6), detail: 'no hostile entity within six blocks' }),
    cleanup: () => controls().stop(),
  }
}

function distanceBetween(left: Vec3Value, right: Vec3Value): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z)
}

function abortableDelay(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new DOMException(String(signal.reason ?? 'aborted'), 'AbortError'))
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms)
    signal.addEventListener('abort', () => { clearTimeout(timer); reject(new DOMException(String(signal.reason ?? 'aborted'), 'AbortError')) }, { once: true })
  })
}
