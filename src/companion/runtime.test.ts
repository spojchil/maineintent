import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { test } from 'node:test'
import { JsonlEventJournal } from '../events/index.js'
import { FileMemoryStore } from '../memory/index.js'
import type {
  BackendEventEnvelope, BackendReady, BackendState, MinecraftBackendApi, MinecraftMotorDriverApi,
  MinecraftSnapshotV1, MotorDigFeedback, ProtocolObservationSource, Unsubscribe,
} from '../minecraft/contracts.js'
import type { CompanionDecisionV2, ContextPackageV2, ModelProvider, RawModelRunResult } from '../models/index.js'
import { DebugStateStore } from '../telemetry/index.js'
import { CompanionRuntime } from './runtime.js'

test('V2 runtime applies social/state effects, rejects ungrounded execution, obeys stop and recalls memory', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-v2-'))
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
    assert.equal(first.activity()?.status, 'proposed')
    assert.equal(firstBackend.sent.some(message => message.includes('先看看')), true)
    assert.equal(firstBackend.sent.some(message => message.includes('已经开始')), false)
    assert.equal(JSON.stringify(firstModel.contexts).includes('collect_wood'), false)
    assert.equal(JSON.stringify(firstModel.contexts).includes('availableSkills'), false)

    firstBackend.chat('记住我们今天开始一起收集木材')
    await settle(first)
    const memories = await new FileMemoryStore(memoryFile).list('test-world')
    assert.equal(memories.length, 1)
    assert.match(memories[0]!.summary, /一起开始收集木材/u)

    const releasesBeforeStop = firstBackend.motorInstance.releases
    firstBackend.chat('停下')
    await waitFor(() => firstBackend.motorInstance.releases > releasesBeforeStop &&
      firstBackend.sent.some(message => message.includes('停下')))
    await first.stop('restart_test')

    const secondBackend = new FakeBackend()
    const secondModel = new ScriptedModel()
    const second = createRuntime(secondBackend, secondModel, memoryFile, path.join(root, 'events-2.jsonl'))
    await second.start()
    await settle(second)
    assert.equal(memoryFragments(secondModel.contexts[0]!).length, 1)
    assert.equal(secondModel.debug.snapshot().decision?.retrievedMemoryIds.length, 1)
    await second.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('V2 runtime waits for the self chunk and preserves the complete Information Read envelope', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-chunk-'))
  try {
    const backend = new FakeBackend()
    backend.chunkLoadsAfterReadBlockCalls = 3
    const model = new ScriptedModel()
    const runtime = createRuntime(backend, model, path.join(root, 'memories.json'), path.join(root, 'events.jsonl'))
    await runtime.start()
    await settle(runtime)
    const viewport = observationReads(model.contexts[0]!).find(read => read.interfaceId === 'viewport_information')
    assert.equal((viewport?.values.standingOnBlock as { name?: string } | undefined)?.name, 'grass_block')
    assert.match(String((viewport?.values.standingOnBlock as { ref?: string } | undefined)?.ref), /^iref_/u)
    assert.equal(typeof viewport?.readId, 'string')
    assert.equal('snapshot' in (model.contexts[0] as unknown as Record<string, unknown>), false)
    await runtime.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('V2 runtime grounds, synthesizes and visually verifies look-at-me before terminal speech', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-gaze-'))
  try {
    const backend = new FakeBackend()
    const model = new ScriptedModel()
    const journalFile = path.join(root, 'events.jsonl')
    const runtime = createRuntime(backend, model, path.join(root, 'memories.json'), journalFile)
    await runtime.start()
    await settle(runtime)
    backend.chat('看向我')
    await settle(runtime)

    assert.ok(backend.motorInstance.looks.length > 1)
    assert.ok(Math.abs(Math.abs(backend.yaw) - Math.PI) < 0.1)
    assert.equal(backend.sent.some(message => message.includes('转过来')), true)
    assert.equal(backend.sent.some(message => message.includes('看到你')), true)
    const events = readFileSync(journalFile, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as { type: string; payload: any })
    assert.ok(events.some(event => event.type === 'embodiment.grounding.finished' && event.payload.groundingStatus === 'partial'))
    assert.ok(events.some(event => event.type === 'embodiment.behavior.synthesized' && event.payload.modes?.includes('bounded_scan_for_identity')))
    assert.ok(events.some(event => event.type === 'embodiment.controller.evidence' && event.payload.stage === 'outcome_verified'))
    assert.ok(events.some(event => event.type === 'embodiment.controller.terminal' && event.payload.status === 'completed'))
    assert.equal(JSON.stringify(events).includes('entity-alex'), false)
    await runtime.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('safety stop cancels an in-flight gaze and suppresses completion speech', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-gaze-stop-'))
  try {
    const backend = new FakeBackend()
    backend.blockMotorLook = true
    const journalFile = path.join(root, 'events.jsonl')
    const runtime = createRuntime(backend, new ScriptedModel(), path.join(root, 'memories.json'), journalFile)
    await runtime.start()
    await settle(runtime)
    backend.chat('看向我')
    await waitFor(() => backend.motorInstance.looks.length > 0)
    backend.chat('停下')
    await settle(runtime)

    assert.ok(backend.motorInstance.releases > 0)
    assert.equal(backend.sent.some(message => message.includes('看到你')), false)
    const events = readFileSync(journalFile, 'utf8').trim().split(/\r?\n/u).map(line => JSON.parse(line) as { type: string; payload: any })
    assert.ok(events.some(event => event.type === 'embodiment.controller.terminal' && event.payload.status === 'cancelled'))
    await runtime.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test('D40 tool seam performs relative look and movement, then returns a ref-free fresh viewport', async () => {
  const root = mkdtempSync(path.join(tmpdir(), 'mineintent-runtime-d40-'))
  try {
    const backend = new FakeBackend()
    const model = new D40ScriptedModel()
    const journalFile = path.join(root, 'events.jsonl')
    const runtime = createRuntime(backend, model, path.join(root, 'memories.json'), journalFile, true)
    model.execute = invocation => runtime.executeD40Tool(invocation)
    await runtime.start()
    await settle(runtime)
    assert.equal(model.contexts.length, 0, 'D40 must not create a startup model turn')

    backend.chat('看看那只羊，然后走过去')
    await settle(runtime)

    assert.deepEqual(backend.motorInstance.relativeLooks, [{ yawDegrees: 30, pitchDegrees: 0 }])
    assert.deepEqual(backend.motorInstance.moves, [{ direction: 'forward', durationMs: 250, sprint: false }])
    assert.equal(model.toolResults.length, 2)
    assert.equal(model.contexts.length, 1)
    assert.equal(triggerType(model.contexts[0]!), 'player_chat')
    assert.equal(JSON.stringify(model.toolResults).includes('"ref"'), false)
    assert.equal(JSON.stringify(model.toolResults).includes('iref_'), false)
    const firstViewport = (model.toolResults[0] as { viewport: { visibleBlocks: { blocks: unknown[] } } }).viewport
    assert.ok(firstViewport.visibleBlocks.blocks.length > 0)
    assert.ok(firstViewport.visibleBlocks.blocks.length <= 256)
    assert.ok(firstViewport.visibleBlocks.blocks.every(block =>
      Array.isArray(block) && block.length === 4 && typeof block[0] === 'string' &&
      block.slice(1).every(value => typeof value === 'number')))
    assert.equal(backend.sent.some(message => message.includes('走近了一点')), true)
    assert.equal(backend.motorInstance.looks.length, 0, 'legacy grounded gaze must not run in D40 mode')

    const events = readFileSync(journalFile, 'utf8').trim().split(/\r?\n/u)
      .map(line => JSON.parse(line) as { type: string; payload: any })
    assert.equal(events.filter(event => event.type === 'experiment.d40.body_tool.started').length, 2)
    assert.equal(events.filter(event => event.type === 'experiment.d40.body_tool.terminal' && event.payload.status === 'completed').length, 2)
    assert.equal(events.some(event => event.type === 'experiment.d40.embodied_intent.rejected'), true)
    await runtime.stop('test_complete')
  } finally { rmSync(root, { recursive: true, force: true }) }
})

function createRuntime(
  backend: FakeBackend,
  model: ScriptedModel,
  memoryFile: string,
  journalFile: string,
  experimentalD40BodyTools = false,
): CompanionRuntime {
  const debug = new DebugStateStore()
  model.debug = debug
  return new CompanionRuntime({
    backend,
    model,
    memory: new FileMemoryStore(memoryFile),
    journal: new JsonlEventJournal(journalFile, 'test-world', `session-${Date.now()}`),
    profile: { profileId: 'test', versionId: 'v1', content: '你是可靠的朋友。', sourcePath: 'profile.md' },
    debug,
    primaryPlayer: 'Alex',
    speechIntervalMs: 1,
    experimentalD40BodyTools,
  })
}

class ScriptedModel implements ModelProvider {
  contexts: ContextPackageV2[] = []
  debug = new DebugStateStore()

  async runDecision(input: { context: ContextPackageV2 }): Promise<RawModelRunResult> {
    const context = structuredClone(input.context)
    this.contexts.push(context)
    const text = triggerText(context)
    const triggerEventId = context.trigger.eventIds[0]!
    if (triggerType(context) === 'startup') {
      return result(decision(context, [{
        id: 'speech_greeting', kind: 'speech',
        text: memoryFragments(context).length ? '我回来了，还记得我们一起玩的事。' : '我来了，一起玩吧。',
        audience: { kind: 'primary_player' }, timing: 'now', purpose: 'social',
      }]))
    }
    if (text.includes('看向我')) return result(decision(context, [
      {
        id: 'embodied_gaze', kind: 'embodied_intent', summary: '与说话者建立视觉共同注意', desiredOutcome: '看向说话者',
        semanticGoal: {
          schema: 'mineintent.semantic-goal.v1',
          objective: { kind: 'state', state: {
            id: 'state_attention', concept: 'self.attention_includes', description: '自身视觉注意覆盖说话者',
            arguments: {
              observer: { kind: 'self' }, subject: { kind: 'referent_role', role: 'speaker' },
            },
          } },
          methodGuidance: [],
        },
        referents: [{ role: 'speaker', selection: { kind: 'message_referent', eventId: triggerEventId, expression: '我' } }],
        constraints: { maxDurationMs: 8_000, interruptibility: 'immediate' },
      },
      {
        id: 'speech_gaze_started', kind: 'speech', text: '好，我转过来看看。', audience: { kind: 'primary_player' },
        timing: 'after_intent_accepted', dependsOn: ['embodied_gaze'], purpose: 'coordinate',
      },
      {
        id: 'speech_gaze_done', kind: 'speech', text: '看到你了。', audience: { kind: 'primary_player' },
        timing: 'after_intent_terminal', dependsOn: ['embodied_gaze'], terminalCondition: 'completed', purpose: 'report',
      },
    ]))
    if (text.includes('记住')) return result(decision(context, [{
      id: 'memory_shared_activity', kind: 'memory_candidate', memoryKind: 'episode',
      content: '与 Alex 一起开始收集木材。', sourceClaim: 'player_stated',
      evidenceEventIds: [triggerEventId], subjects: ['Alex', 'companion'], confidence: 0.9,
    }]))
    if (text.includes('一起收集')) return result(decision(context, [
      {
        id: 'activity_collect', kind: 'activity', operation: 'propose', summary: '与 Alex 一起收集木材',
        companionContribution: '一起观察环境并参与收集', reason: '玩家提出共同活动', evidenceEventIds: [triggerEventId],
      },
      {
        id: 'intent_collect', kind: 'intent', operation: 'set', summary: '寻找合法可见的木材来源',
        reason: '参与刚提出的共同活动', completionSignals: ['获得可用木材'],
      },
      {
        id: 'embodied_collect', kind: 'embodied_intent', summary: '增加随身木材', desiredOutcome: '背包中有更多可用木材',
        semanticGoal: {
          schema: 'mineintent.semantic-goal.v1',
          objective: { kind: 'state', state: {
            id: 'state_wood_available', concept: 'inventory.contains_material', description: '自身背包含有至少一份木材',
            arguments: {
              subject: { kind: 'self' }, material: { kind: 'value', value: 'wood' }, minimum: { kind: 'value', value: 1, unit: 'item' },
            },
          } },
          methodGuidance: [],
        },
        referents: [], constraints: { maxDurationMs: 60_000, interruptibility: 'immediate' },
      },
      {
        id: 'speech_observe', kind: 'speech', text: '我先看看周围。', audience: { kind: 'primary_player' },
        timing: 'now', purpose: 'coordinate',
      },
      {
        id: 'speech_started', kind: 'speech', text: '我已经开始收集了。', audience: { kind: 'primary_player' },
        timing: 'after_intent_accepted', dependsOn: ['embodied_collect'], purpose: 'coordinate',
      },
    ]))
    return result(decision(context, []))
  }
}

class D40ScriptedModel extends ScriptedModel {
  execute?: (invocation: { runId: string; name: string; arguments: unknown }) => Promise<unknown>
  toolResults: unknown[] = []

  override async runDecision(input: { context: ContextPackageV2 }): Promise<RawModelRunResult> {
    const text = triggerText(input.context)
    if (!text.includes('羊')) return super.runDecision(input)
    assert.ok(this.execute)
    this.contexts.push(structuredClone(input.context))
    this.toolResults.push(await this.execute({
      runId: input.context.ref.runId,
      name: 'look_relative',
      arguments: { yaw_degrees: 30, pitch_degrees: 0 },
    }))
    this.toolResults.push(await this.execute({
      runId: input.context.ref.runId,
      name: 'move_input',
      arguments: { direction: 'forward', duration_ms: 250 },
    }))
    const triggerEventId = input.context.trigger.eventIds[0]!
    return result(decision(input.context, [
      {
        id: 'embodied_d40_hallucination',
        kind: 'embodied_intent',
        summary: '错误地再次要求旧视觉闭环',
        desiredOutcome: '看向玩家所说的羊',
        semanticGoal: {
          schema: 'mineintent.semantic-goal.v1',
          objective: { kind: 'state', state: {
            id: 'state_d40_attention',
            concept: 'self.attention_includes',
            description: '视觉注意覆盖玩家所说的羊',
            arguments: { observer: { kind: 'self' }, subject: { kind: 'referent_role', role: 'sheep' } },
          } },
          methodGuidance: [],
        },
        referents: [{ role: 'sheep', selection: {
          kind: 'message_referent', eventId: triggerEventId, expression: '那只羊',
        } }],
        constraints: { maxDurationMs: 5_000, interruptibility: 'immediate' },
      },
      {
        id: 'speech_d40_done',
        kind: 'speech',
        text: '看到了，我也走近了一点。',
        audience: { kind: 'primary_player' },
        timing: 'now',
        purpose: 'reply',
      },
    ]))
  }
}

function decision(context: ContextPackageV2, effects: CompanionDecisionV2['effects']): CompanionDecisionV2 {
  return {
    protocol: 'mineintent.decision.v2',
    runId: context.ref.runId,
    context: structuredClone(context.ref),
    summary: effects.length ? '回应当前情境并提出必要效果' : '暂时观察，不产生新效果',
    effects,
  }
}

function result(rawOutput: CompanionDecisionV2): RawModelRunResult {
  return { rawOutput, model: 'scripted-test' }
}

function triggerType(context: ContextPackageV2): string {
  const fragment = context.fragments.find(item => item.id === 'fragment_trigger')
  return String((fragment?.content as Record<string, unknown> | undefined)?.type ?? '')
}

function triggerText(context: ContextPackageV2): string {
  const fragment = context.fragments.find(item => item.id === 'fragment_trigger')
  return String((fragment?.content as Record<string, unknown> | undefined)?.text ?? '')
}

function memoryFragments(context: ContextPackageV2) {
  return context.fragments.filter(fragment => fragment.section === 'retrieved_memories')
}

function observationReads(context: ContextPackageV2): Array<Record<string, any>> {
  return context.fragments
    .filter(fragment => fragment.section === 'observations')
    .map(fragment => fragment.content)
    .filter((content): content is Record<string, any> => Boolean(content && typeof content === 'object' && 'interfaceId' in content))
}

class FakeMotor implements MinecraftMotorDriverApi {
  constructor(readonly owner: FakeBackend) {}
  releases = 0
  looks: Array<{ yaw: number; pitch: number }> = []
  relativeLooks: Array<{ yawDegrees: number; pitchDegrees: number }> = []
  moves: Array<{ direction: 'forward' | 'back' | 'left' | 'right'; durationMs: number; sprint: boolean }> = []
  async look(yaw: number, pitch: number, signal: AbortSignal): Promise<void> {
    this.looks.push({ yaw, pitch })
    if (this.owner.blockMotorLook) {
      await new Promise<void>((_resolve, reject) => {
        const abort = () => reject(new DOMException('aborted', 'AbortError'))
        signal.addEventListener('abort', abort, { once: true })
      })
    }
    this.owner.yaw = yaw
    this.owner.pitch = pitch
    this.owner.perceptionRevision++
  }
  async lookRelative(yawDegrees: number, pitchDegrees: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    this.relativeLooks.push({ yawDegrees, pitchDegrees })
    this.owner.yaw -= yawDegrees * Math.PI / 180
    this.owner.pitch -= pitchDegrees * Math.PI / 180
    this.owner.perceptionRevision++
  }
  async move(
    direction: 'forward' | 'back' | 'left' | 'right',
    durationMs: number,
    sprint: boolean | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) throw new DOMException('aborted', 'AbortError')
    this.moves.push({ direction, durationMs, sprint: sprint ?? false })
    this.owner.position = { ...this.owner.position, z: this.owner.position.z - 1 }
    this.owner.perceptionRevision++
  }
  async dig(position: { x: number; y: number; z: number }): Promise<MotorDigFeedback> {
    return { stage: 'client_predicted', name: 'oak_log', position }
  }
  releaseAll(): void { this.releases++ }
}

class FakeBackend extends EventEmitter implements MinecraftBackendApi {
  position = { x: 0, y: 64, z: 0 }
  yaw = 0
  pitch = 0
  blockMotorLook = false
  perceptionRevision = 1
  sent: string[] = []
  motorInstance = new FakeMotor(this)
  chunkLoadsAfterReadBlockCalls = 0
  #state: BackendState = { status: 'idle' }
  #snapshotRevision = 0
  #readBlockCalls = 0

  async start(): Promise<BackendReady> {
    this.#state = { status: 'ready', epoch: 1, attemptId: 'attempt', readyAt: new Date().toISOString() }
    return { processSessionId: 'session', connectionEpoch: 1, connectionAttemptId: 'attempt', snapshot: this.snapshot() }
  }
  async stop(reason: string): Promise<void> { this.#state = { status: 'stopped', reason } }
  state(): Readonly<BackendState> { return structuredClone(this.#state) }
  snapshot(): Readonly<MinecraftSnapshotV1> {
    return {
      protocol: 'mineintent.minecraft.snapshot.v1', snapshotRevision: ++this.#snapshotRevision, lifecycleRevision: 1,
      capturedAt: new Date().toISOString(), processSessionId: 'session', connectionEpoch: 1, connectionAttemptId: 'attempt',
      world: { worldId: 'test-world', dimension: 'overworld', minecraftVersion: '1.21.1', protocolVersion: 767, gameMode: 'survival', minY: -64, height: 384, timeOfDay: 1000 },
      self: { entityKey: 'self', username: 'MineIntentBot', position: this.position, velocity: { x: 0, y: 0, z: 0 }, yaw: this.yaw, pitch: this.pitch, onGround: true, alive: true, health: 20, food: 20, foodSaturation: 5, effects: [] },
      inventory: { selectedHotbarSlot: 0, slots: [] },
      trackedPlayers: [{ playerKey: 'alex', username: 'Alex', listed: true, entityTracked: true, position: { x: 0, y: 64, z: 1 } }],
    }
  }
  subscribe(listener: (event: BackendEventEnvelope) => void): Unsubscribe { this.on('backend', listener); return () => this.off('backend', listener) }
  observationSource(): ProtocolObservationSource {
    return {
      epoch: () => 1,
      revision: () => this.perceptionRevision,
      selfPose: () => ({ position: this.position, velocity: { x: 0, y: 0, z: 0 }, yaw: this.yaw, pitch: this.pitch }),
      listTrackedEntities: () => [{
        entityKey: '1:alex', protocolEntityId: 1, type: 'player', username: 'Alex',
        position: { x: 0, y: 64, z: 1 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0,
        width: 0.6, height: 1.8, onGround: true, equipment: [], valid: true,
      }],
      readBlock: (position) => {
        this.#readBlockCalls++
        if (position.y !== Math.floor(this.position.y) - 1) return {
          status: 'loaded',
          block: { position, name: 'air', stateId: 0, properties: {}, collisionShapes: [], transparentHint: true, boundingBox: 'empty' },
        }
        if (this.#readBlockCalls <= this.chunkLoadsAfterReadBlockCalls) return { status: 'unloaded' }
        return { status: 'loaded', block: { position, name: 'grass_block', stateId: 1, properties: {}, collisionShapes: [], transparentHint: false, boundingBox: 'block' } }
      },
      subscribe: () => () => {},
    }
  }
  motor(): MinecraftMotorDriverApi { return this.motorInstance }
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
async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('condition was not reached before timeout')
    await delay(5)
  }
}
function randomId(): string { return `event-${Date.now()}-${Math.random()}` }
