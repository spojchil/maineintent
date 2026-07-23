import { randomUUID } from 'node:crypto'
import path from 'node:path'
import { CompanionRuntime, loadCompanionProfile } from '../companion/index.js'
import { JsonlEventJournal } from '../events/index.js'
import { D40ToolBridgeServer } from '../experimental/index.js'
import { FileMemoryStore } from '../memory/index.js'
import { MinecraftBackend } from '../minecraft/index.js'
import { AgentServiceModelProvider } from '../models/index.js'
import { DebugStateStore, LocalDebugServer } from '../telemetry/index.js'
import type { AppConfig } from './config.js'

export class MineIntentApp {
  readonly #config: AppConfig
  #runtime?: CompanionRuntime
  #debugServer?: LocalDebugServer
  #toolBridge?: D40ToolBridgeServer

  constructor(config: AppConfig) { this.#config = config }

  async start(): Promise<{ debugUrl: string }> {
    const profile = await loadCompanionProfile(this.#config.profileFile)
    const debug = new DebugStateStore()
    const backend = new MinecraftBackend(this.#config.minecraft)
    const memory = new FileMemoryStore(path.join(this.#config.dataDirectory, 'memories.json'))
    const journal = new JsonlEventJournal(path.join(this.#config.dataDirectory, 'events.jsonl'), this.#config.minecraft.worldId, randomUUID())
    let runtime: CompanionRuntime | undefined
    const toolBridge = new D40ToolBridgeServer(async invocation => {
      if (!runtime) throw new Error('companion_runtime_not_ready')
      return runtime.executeD40Tool(invocation)
    })
    const toolCallback = await toolBridge.start()
    const model = new AgentServiceModelProvider({
      baseUrl: this.#config.agentServiceUrl,
      // D40 deliberately permits a long, interruptible active-perception sequence.
      timeoutMs: 600_000,
      toolCallbackUrl: toolCallback.url,
      toolCallbackToken: toolCallback.token,
    })
    runtime = new CompanionRuntime({
      backend,
      model,
      memory,
      journal,
      profile,
      debug,
      primaryPlayer: this.#config.primaryPlayer,
      experimentalD40BodyTools: true,
    })
    const debugServer = new LocalDebugServer(debug, this.#config.debugPort)
    this.#runtime = runtime
    this.#debugServer = debugServer
    this.#toolBridge = toolBridge
    let address
    try {
      address = await debugServer.start()
      await runtime.start()
    } catch (error) {
      await Promise.allSettled([runtime.stop('app_start_failed')])
      await Promise.allSettled([debugServer.stop(), toolBridge.stop()])
      this.#runtime = undefined
      this.#debugServer = undefined
      this.#toolBridge = undefined
      throw error
    }
    return { debugUrl: `${address.url}/v1/state` }
  }

  async stop(reason = 'app_stopped'): Promise<void> {
    // Keep the callback listener alive until the runtime has aborted and joined its active
    // model turn; that turn may already have an in-flight Python -> Node tool request.
    const runtimeResult = await Promise.allSettled([this.#runtime?.stop(reason)])
    const serverResults = await Promise.allSettled([this.#debugServer?.stop(), this.#toolBridge?.stop()])
    this.#runtime = undefined
    this.#debugServer = undefined
    this.#toolBridge = undefined
    const failed = [...runtimeResult, ...serverResults]
      .find((result): result is PromiseRejectedResult => result.status === 'rejected')
    if (failed) throw failed.reason
  }
}
