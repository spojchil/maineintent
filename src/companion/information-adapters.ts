import { distanceBetween, relativeBearing, type InformationScopeSnapshot, type InformationScopeSource, type SoundHistoryPort, type SoundObservation } from '../information/index.js'
import type { InventoryPort } from '../information/source-ports/inventory.js'
import type { PerceptionEntityCandidate, PerceptionPort, PerceptionPose } from '../information/source-ports/perception.js'
import type { SelfVitalsPort } from '../information/source-ports/self-vitals.js'
import type { BackendEventEnvelope, MinecraftBackendApi, ProtocolSoundPayload, Unsubscribe } from '../minecraft/contracts.js'

export class BackendSelfVitalsPort implements SelfVitalsPort {
  constructor(private readonly backend: MinecraftBackendApi) {}
  current(): ReturnType<SelfVitalsPort['current']> { return this.backend.snapshot().self }
}

export class BackendInventoryPort implements InventoryPort {
  constructor(private readonly backend: MinecraftBackendApi) {}
  current(): ReturnType<InventoryPort['current']> { return this.backend.snapshot().inventory }
}

export class BackendPerceptionPort implements PerceptionPort {
  constructor(private readonly backend: MinecraftBackendApi) {}

  selfPose(): PerceptionPose {
    return this.backend.observationSource().selfPose()
  }

  revision(): number { return this.backend.observationSource().revision() }

  blockAt(position: PerceptionPose['position']): ReturnType<PerceptionPort['blockAt']> {
    const result = this.backend.observationSource().readBlock(position)
    if (result.status !== 'loaded') return 'unloaded'
    const visible = !['air', 'cave_air', 'void_air'].includes(result.block.name)
    return {
      name: result.block.name,
      visible,
      occludes: visible && !result.block.transparentHint,
    }
  }

  nearbyEntities(): readonly PerceptionEntityCandidate[] {
    let selfEntityKey: string | undefined
    try { selfEntityKey = this.backend.snapshot().self.entityKey } catch { selfEntityKey = undefined }
    return this.backend.observationSource().listTrackedEntities()
      .filter((entity) => entity.entityKey !== selfEntityKey)
      .map((entity) => ({
        entityKey: entity.entityKey,
        type: entity.type,
        ...(entity.name ? { name: entity.name } : {}),
        ...(entity.username ? { username: entity.username } : {}),
        position: entity.position,
        width: entity.width,
        height: entity.height,
      }))
  }
}

const SOUND_HISTORY_CAPACITY = 20
const SOUND_TTL_MS = 5_000
const MAX_SOUND_DISTANCE = 64

// Version-locked 1.21.1 semantic allowlist. Unknown registry names remain unidentified rather
// than being interpreted by splitting arbitrary protocol strings.
const SOUND_SEMANTICS_1_21_1: Readonly<Record<string, string>> = {
  'entity.cow.ambient': 'cow',
  'entity.zombie.ambient': 'zombie',
  'entity.skeleton.ambient': 'skeleton',
  'entity.creeper.primed': 'creeper_fuse',
  'entity.player.hurt': 'player_hurt',
  'entity.player.levelup': 'player_level_up',
  'block.wood.break': 'wood_break',
  'block.wood.place': 'wood_place',
  'block.chest.open': 'container_open',
  'block.chest.close': 'container_close',
}

interface ScopedSoundObservation {
  scopeKey: string
  value: SoundObservation
}

export class SoundHistory implements SoundHistoryPort {
  #entries: ScopedSoundObservation[] = []
  readonly #unsubscribe: Unsubscribe
  readonly #now: () => Date
  #revision = 0

  constructor(private readonly backend: MinecraftBackendApi, now: () => Date = () => new Date()) {
    this.#now = now
    this.#unsubscribe = backend.subscribe((event) => { if (event.kind === 'sound') this.#record(event) })
  }

  recent(limit: number): readonly SoundObservation[] {
    this.#purge()
    return this.#entries.slice(-limit).reverse().map(entry => structuredClone(entry.value))
  }

  revision(): number { this.#purge(); return this.#revision }

  dispose(): void { this.#unsubscribe() }

  #record(event: BackendEventEnvelope): void {
    const payload = event.payload as ProtocolSoundPayload
    let self
    try { self = this.backend.snapshot().self } catch { return }
    const scopeKey = this.#eventScopeKey(event)
    if (!scopeKey) return
    const distance = distanceBetween(self.position, payload.sourcePosition)
    const protocolRange = Math.min(MAX_SOUND_DISTANCE, Math.max(16, 16 * payload.volume))
    if (distance > protocolRange) return
    const observedAtMs = Date.parse(event.occurredAt)
    if (!Number.isFinite(observedAtMs)) return
    const registryName = payload.soundName?.replace(/^minecraft:/u, '')
    const observation: SoundObservation = {
      ...(registryName && SOUND_SEMANTICS_1_21_1[registryName]
        ? { semanticHint: SOUND_SEMANTICS_1_21_1[registryName] }
        : {}),
      distanceBand: distance <= 2.5 ? 'very_near' : distance <= 8 ? 'near' : distance <= 24 ? 'medium' : 'far',
      direction: relativeBearing(self.yaw, self.position, payload.sourcePosition),
      observedAt: event.occurredAt,
      validUntil: new Date(observedAtMs + SOUND_TTL_MS).toISOString(),
    }
    this.#entries.push({ scopeKey, value: observation })
    if (this.#entries.length > SOUND_HISTORY_CAPACITY) this.#entries.shift()
    this.#revision++
  }

  #eventScopeKey(event: BackendEventEnvelope): string | undefined {
    if (!event.dimension) return undefined
    return `${event.connectionEpoch}:${event.dimension}`
  }

  #currentScopeKey(): string | undefined {
    const state = this.backend.state()
    if (state.status !== 'ready' && state.status !== 'dead') return undefined
    try { return `${state.epoch}:${this.backend.snapshot().world.dimension}` } catch { return undefined }
  }

  #purge(): void {
    const before = this.#entries.length
    const scopeKey = this.#currentScopeKey()
    const now = this.#now().getTime()
    this.#entries = this.#entries.filter(entry =>
      scopeKey !== undefined && entry.scopeKey === scopeKey && Date.parse(entry.value.validUntil) > now)
    if (this.#entries.length !== before) this.#revision++
  }
}

const CONNECTED_STATUSES = new Set(['connecting', 'logging_in', 'spawning', 'ready', 'dead'])

export class BackendInformationScopeSource implements InformationScopeSource {
  constructor(private readonly backend: MinecraftBackendApi, private readonly processSessionId: string) {}

  capture(): Readonly<InformationScopeSnapshot> {
    const state = this.backend.state()
    const connectionState = state.status === 'ready' || state.status === 'dead' ? 'play'
      : state.status === 'connecting' || state.status === 'logging_in' || state.status === 'spawning' ? 'connecting'
      : 'disconnected'
    const connectionEpoch = CONNECTED_STATUSES.has(state.status) ? (state as { epoch: number }).epoch : 0
    let worldId: string | undefined
    let dimension: string | undefined
    try {
      const snapshot = this.backend.snapshot()
      worldId = snapshot.world.worldId
      dimension = snapshot.world.dimension
    } catch { /* backend not ready */ }
    return {
      processSessionId: this.processSessionId,
      connectionState,
      connectionEpoch,
      ...(worldId ? { worldId } : {}),
      ...(dimension ? { dimension } : {}),
      uiRevision: 0,
      capturedAt: new Date().toISOString(),
    }
  }
}
