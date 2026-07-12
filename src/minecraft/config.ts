import { z } from 'zod'
import type { MinecraftBackendConfig } from './contracts.js'

export const minecraftBackendConfigSchema = z.strictObject({
  worldId: z.string().trim().min(1).max(128),
  server: z.strictObject({
    host: z.string().trim().min(1),
    port: z.number().int().min(1).max(65_535),
    version: z.literal('1.21.1'),
  }),
  identity: z.strictObject({
    username: z.string().trim().min(1).max(64),
    auth: z.enum(['offline', 'microsoft']),
    profilesFolder: z.string().min(1).optional(),
  }),
  timeouts: z.strictObject({
    connectMs: z.number().int().positive(),
    loginMs: z.number().int().positive(),
    spawnMs: z.number().int().positive(),
    stopMs: z.number().int().positive(),
  }),
  reconnect: z.strictObject({
    enabled: z.boolean(),
    initialDelayMs: z.number().int().nonnegative(),
    multiplier: z.number().min(1),
    maxDelayMs: z.number().int().nonnegative(),
    jitterRatio: z.number().min(0).max(1),
    stableResetMs: z.number().int().nonnegative(),
  }),
})

export const defaultMinecraftBackendConfig: Omit<MinecraftBackendConfig, 'worldId' | 'server' | 'identity'> = {
  timeouts: { connectMs: 10_000, loginMs: 20_000, spawnMs: 30_000, stopMs: 5_000 },
  reconnect: {
    enabled: true,
    initialDelayMs: 1_000,
    multiplier: 2,
    maxDelayMs: 30_000,
    jitterRatio: 0.2,
    stableResetMs: 60_000,
  },
}

export function parseMinecraftBackendConfig(input: unknown): MinecraftBackendConfig {
  return minecraftBackendConfigSchema.parse(input) as MinecraftBackendConfig
}

