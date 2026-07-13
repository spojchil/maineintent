import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { CompanionRuntime, loadCompanionProfile } from '../companion/index.js'
import { JsonlEventJournal } from '../events/index.js'
import { FileMemoryStore } from '../memory/index.js'
import { MinecraftBackend } from '../minecraft/index.js'
import { OpenAICompatibleModelProvider } from '../models/index.js'
import { DebugStateStore, LocalDebugServer } from '../telemetry/index.js'
import type { AppConfig } from './config.js'

export class MineIntentApp {
  readonly #config: AppConfig
  #runtime?: CompanionRuntime
  #debugServer?: LocalDebugServer

  constructor(config: AppConfig) { this.#config = config }

  async start(): Promise<{ debugUrl: string }> {
    const profile = await loadCompanionProfile(this.#config.profileFile)
    const debug = new DebugStateStore()
    const backend = new MinecraftBackend(this.#config.minecraft)
    const model = new OpenAICompatibleModelProvider(this.#config.model)
    const memory = new FileMemoryStore(path.join(this.#config.dataDirectory, 'memories.json'))
    const journal = new JsonlEventJournal(path.join(this.#config.dataDirectory, 'events.jsonl'), this.#config.minecraft.worldId, randomUUID())
    const runtime = new CompanionRuntime({ backend, model, memory, journal, profile, debug, primaryPlayer: this.#config.primaryPlayer })
    const debugServer = new LocalDebugServer(debug, this.#config.debugPort)
    this.#runtime = runtime
    this.#debugServer = debugServer
    const address = await debugServer.start()
    try { await runtime.start() } catch (error) { await debugServer.stop(); throw error }
    return { debugUrl: `${address.url}/v1/state` }
  }

  async stop(reason = 'app_stopped'): Promise<void> {
    await this.#runtime?.stop(reason)
    await this.#debugServer?.stop()
    this.#runtime = undefined
    this.#debugServer = undefined
  }
}
