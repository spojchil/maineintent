import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { JsonlEventJournal } from '../events/index.js'
import { FileMemoryStore } from '../memory/index.js'
import type {
  BackendEventEnvelope, BackendReady, BackendState, GameBlockTarget, GameThreat, MinecraftBackendApi,
  MinecraftControlsApi, MinecraftSnapshotV1, ProtocolObservationSource, Unsubscribe, Vec3Value,
} from '../minecraft/contracts.js'
import type { CompanionDecision, DecisionContext, ModelProvider, ModelRunResult } from '../models/index.js'
import { DebugStateStore } from '../telemetry/index.js'
import { CompanionRuntime } from './runtime.js'

test('companion runtime completes wood activity, obeys stop and recalls the episode after restart', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-'))
  try {
    const memoryFile = path.join(root, 'memories.json')
    const firstBackend = new FakeBackend()
    const firstModel = new ScriptedModel()
    const first = createRuntime(firstBackend, firstModel, memoryFile, path.join(root, 'events-1.jsonl'))
    await first.start()
    await settle(first)
    assert.match(firstBackend.sent[0] ?? '', /来了/u)

    firstBackend.chat('一起收集些木头吧')
    await settle(first)
    assert.equal(firstBackend.wood, 1)
    assert.equal(first.activity()?.status, 'active')

    firstBackend.chat('等一下')
    await delay(30)
    assert.equal(first.activity()?.status, 'paused')
    assert.equal(firstBackend.controlsInstance.stops > 0, true)
    assert.equal(firstBackend.sent.some(message => message.includes('停下')), true)

    firstBackend.chat('够了，我们回刚才那里吧')
    await settle(first)
    assert.equal(first.activity()?.status, 'completed')
    const memories = await new FileMemoryStore(memoryFile).list('test-world')
    assert.equal(memories.length, 1)
    assert.match(memories[0]!.summary, /一起收集木材/u)
    assert.equal(memories[0]!.evidence.some(item => item.kind === 'action_result'), true)
    await first.stop('restart_test')

    const secondBackend = new FakeBackend()
    const secondModel = new ScriptedModel()
    const second = createRuntime(secondBackend, secondModel, memoryFile, path.join(root, 'events-2.jsonl'))
    await second.start()
    await settle(second)
    assert.equal(secondModel.contexts[0]?.memories.length, 1)
    secondBackend.chat('上次我们做了什么？')
    await settle(second)
    assert.equal(secondBackend.sent.some(message => message.includes('收集了木材')), true)
    assert.equal(secondModel.debug.snapshot().decision?.retrievedMemoryIds.length, 1)
    await second.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('companion runtime waits for the self chunk to load before its first decision', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-chunk-'))
  try {
    const backend = new FakeBackend()
    backend.chunkLoadsAfterReadBlockCalls = 3
    const model = new ScriptedModel()
    const runtime = createRuntime(backend, model, path.join(root, 'memories.json'), path.join(root, 'events.jsonl'))
    await runtime.start()
    await settle(runtime)
    assert.equal(model.contexts[0]?.observations.viewport?.standingOnBlock?.name, 'grass_block')
    await runtime.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function createRuntime(backend: FakeBackend, model: ScriptedModel, memoryFile: string, journalFile: string): CompanionRuntime {
  const debug = new DebugStateStore()
  model.debug = debug
  return new CompanionRuntime({
    backend, model, memory: new FileMemoryStore(memoryFile),
    journal: new JsonlEventJournal(journalFile, 'test-world', `session-${Date.now()}`),
    profile: { profileId: 'test', versionId: 'v1', content: '你是可靠的朋友。', sourcePath: 'profile.md' },
    debug, primaryPlayer: 'Alex', speechIntervalMs: 1,
  })
}

class ScriptedModel implements ModelProvider {
  contexts: DecisionContext[] = []
  debug = new DebugStateStore()

  async run(context: DecisionContext): Promise<ModelRunResult> {
    this.contexts.push(structuredClone(context))
    const text = context.trigger.text ?? ''
    if (context.trigger.type === 'startup') return result(decision({ speech: context.memories.length ? '我还记得上次的事。' : '我来了，一起玩吧。' }))
    if (text.includes('一起收集')) return result(decision({
      speech: '好，我们一起找树。', activity: { operation: 'start_wood_collection', summary: '和 Alex 一起收集木材' },
      intent: { kind: 'collect', summary: '采集一块原木' }, action: { skill: 'collect_wood', args: { count: 1, maxDistance: 16 }, purpose: '参与共同收集' },
    }))
    if (text.includes('回刚才')) return result(decision({
      speech: '够了，我们回去。', activity: { operation: 'complete', summary: '收集完成，回到出发地点' },
      intent: { kind: 'return', summary: '回到活动锚点' }, action: { skill: 'return_to_anchor', args: {}, purpose: '一起返回' },
    }))
    if (text.includes('上次')) return result(decision({ speech: context.memories.length ? '上次我们一起收集了木材。' : '我没有找到上次的记录。' }))
    return result(decision({ speech: null }))
  }
}

function decision(overrides: Partial<CompanionDecision>): CompanionDecision {
  return {
    protocol: 'mineintent.companion-decision.v1', speech: null,
    attention: { kind: 'player', target: 'Alex' }, activity: { operation: 'keep', summary: '保持当前活动' },
    intent: { kind: 'observe', summary: '留意玩家和环境' }, action: null, memory: null, ...overrides,
  }
}
function result(value: CompanionDecision): ModelRunResult { return { decision: value, model: 'scripted-test' } }

class FakeControls implements MinecraftControlsApi {
  constructor(readonly owner: FakeBackend) {}
  stops = 0
  findNearestBlock(): GameBlockTarget { return { name: 'oak_log', position: { x: 2, y: 64, z: 0 } } }
  async navigateNear(position: Vec3Value): Promise<void> { this.owner.position = { ...position } }
  async navigateToPlayer(): Promise<void> { this.owner.position = { x: 0, y: 64, z: 1 } }
  async dig(position: Vec3Value): Promise<GameBlockTarget> { this.owner.wood++; return { name: 'oak_log', position } }
  inventoryCount(): number { return this.owner.wood }
  nearestThreat(): GameThreat | undefined { return undefined }
  stop(): void { this.stops++ }
}

class FakeBackend extends EventEmitter implements MinecraftBackendApi {
  position = { x: 0, y: 64, z: 0 }
  wood = 0
  sent: string[] = []
  controlsInstance = new FakeControls(this)
  chunkLoadsAfterReadBlockCalls = 0
  #state: BackendState = { status: 'idle' }
  #revision = 0
  #readBlockCalls = 0

  async start(): Promise<BackendReady> {
    this.#state = { status: 'ready', epoch: 1, attemptId: 'attempt', readyAt: new Date().toISOString() }
    return { processSessionId: 'session', connectionEpoch: 1, connectionAttemptId: 'attempt', snapshot: this.snapshot() }
  }
  async stop(reason: string): Promise<void> { this.#state = { status: 'stopped', reason } }
  state(): Readonly<BackendState> { return structuredClone(this.#state) }
  snapshot(): Readonly<MinecraftSnapshotV1> {
    return {
      protocol: 'mineintent.minecraft.snapshot.v1', snapshotRevision: ++this.#revision, lifecycleRevision: 1,
      capturedAt: new Date().toISOString(), processSessionId: 'session', connectionEpoch: 1, connectionAttemptId: 'attempt',
      world: { worldId: 'test-world', dimension: 'overworld', minecraftVersion: '1.21.1', protocolVersion: 767, gameMode: 'survival', minY: -64, height: 384, timeOfDay: 1000 },
      self: { entityKey: 'self', username: 'MineIntentBot', position: this.position, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, alive: true, health: 20, food: 20, foodSaturation: 5, effects: [] },
      inventory: { selectedHotbarSlot: 0, slots: this.wood ? [{ slot: 9, itemName: 'oak_log', count: this.wood }] : [] },
      trackedPlayers: [{ playerKey: 'alex', username: 'Alex', listed: true, entityTracked: true, position: { x: 0, y: 64, z: 1 } }],
    }
  }
  subscribe(listener: (event: BackendEventEnvelope) => void): Unsubscribe { this.on('backend', listener); return () => this.off('backend', listener) }
  observationSource(): ProtocolObservationSource {
    return {
      epoch: () => 1,
      selfPose: () => ({ position: this.position, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0 }),
      listTrackedEntities: () => [{
        entityKey: '1:alex', protocolEntityId: 1, type: 'player', username: 'Alex',
        position: { x: 0, y: 64, z: 1 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
        width: 0.6, height: 1.8, onGround: true, equipment: [], valid: true,
      }],
      readBlock: (position) => {
        this.#readBlockCalls++
        if (position.y !== Math.floor(this.position.y) - 1) return { status: 'unloaded' }
        if (this.#readBlockCalls <= this.chunkLoadsAfterReadBlockCalls) return { status: 'unloaded' }
        return { status: 'loaded', block: { position, name: 'grass_block', stateId: 1, properties: {}, collisionShapes: [], transparentHint: false, boundingBox: 'block' } }
      },
      subscribe: () => () => {},
    }
  }
  controls(): MinecraftControlsApi { return this.controlsInstance }
  sendChat(message: string): void { this.sent.push(message) }
  chat(text: string): void {
    this.emit('backend', {
      protocol: 'mineintent.minecraft.backend-event.v1', id: randomId(), kind: 'chat', occurredAt: new Date().toISOString(),
      processSessionId: 'session', connectionEpoch: 1, connectionAttemptId: 'attempt', worldId: 'test-world', dimension: 'overworld',
      payload: { senderUsername: 'Alex', plainText: text, position: 'chat' },
    } satisfies BackendEventEnvelope)
  }
}

async function settle(runtime: CompanionRuntime): Promise<void> {
  await delay(30); await runtime.idle(); await delay(50); await runtime.idle(); await delay(20)
}
function delay(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
function randomId(): string { return `event-${Date.now()}-${Math.random()}` }
