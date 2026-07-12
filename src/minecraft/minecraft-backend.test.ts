import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'
import type { BackendEventEnvelope, MinecraftBackendConfig, ProtocolSoundPayload } from './contracts.js'
import { defaultMinecraftBackendConfig, parseMinecraftBackendConfig } from './config.js'
import type { BlockLike, BotLike, EntityLike, MineflayerBotFactory, PlayerLike, SafeBotOptions } from './internal.js'
import { BackendNotReadyError, MinecraftBackend, StaleBackendEpochError } from './minecraft-backend.js'

class FakeBot extends EventEmitter implements BotLike {
  username = 'MineIntentBot'
  version = '1.21.1'
  protocolVersion = 767
  entity = {
    id: 1,
    type: 'player',
    username: 'MineIntentBot',
    position: { x: 1, y: 64, z: 2 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    width: 0.6,
    height: 1.8,
    onGround: true,
    effects: {},
    equipment: [],
  }
  entities: Record<string, EntityLike> = { 1: this.entity }
  players: Record<string, PlayerLike> = { MineIntentBot: { username: 'MineIntentBot', uuid: 'bot-uuid', entity: this.entity } }
  game = { dimension: 'overworld', gameMode: 'survival', difficulty: 'easy', minY: -64, height: 384, serverViewDistance: 10 }
  health = 20
  food = 20
  foodSaturation = 5
  inventory = { slots: [{ name: 'oak_log', count: 3 }, null] }
  quickBarSlot = 0
  time = { timeOfDay: 1000 }
  isRaining = false
  clearCount = 0
  quitReasons: string[] = []
  endReasons: string[] = []
  chatMessages: string[] = []
  blocks = new Map<string, BlockLike>()
  world = { getBlock: (position: { x: number; y: number; z: number }) => this.blocks.get(`${position.x},${position.y},${position.z}`) ?? null }

  quit(reason?: string): void {
    this.quitReasons.push(reason ?? '')
    this.emit('end', reason ?? 'quit')
  }
  end(reason?: string): void {
    this.endReasons.push(reason ?? '')
    this.emit('end', reason ?? 'end')
  }
  clearControlStates(): void { this.clearCount++ }
  chat(message: string): void { this.chatMessages.push(message) }
}

class FakeFactory implements MineflayerBotFactory {
  bots: FakeBot[] = []
  options: SafeBotOptions[] = []
  create(options: SafeBotOptions): BotLike {
    this.options.push(options)
    const bot = new FakeBot()
    bot.username = options.username
    bot.entity.username = options.username
    this.bots.push(bot)
    return bot
  }
}

function config(overrides: Partial<MinecraftBackendConfig> = {}): MinecraftBackendConfig {
  return {
    worldId: 'paper-test-world',
    server: { host: 'localhost', port: 25565, version: '1.21.1' },
    identity: { username: 'MineIntentBot', auth: 'offline' },
    ...defaultMinecraftBackendConfig,
    timeouts: { connectMs: 100, loginMs: 100, spawnMs: 100, stopMs: 20 },
    reconnect: { ...defaultMinecraftBackendConfig.reconnect, enabled: false, initialDelayMs: 1, maxDelayMs: 2, stableResetMs: 10 },
    ...overrides,
  }
}

function makeBackend(overrides: Partial<MinecraftBackendConfig> = {}) {
  const factory = new FakeFactory()
  let id = 0
  const backend = new MinecraftBackend(config(overrides), { botFactory: factory, id: () => `id-${++id}`, random: { next: () => 0.5 } })
  return { backend, factory }
}

async function makeReady(backend: MinecraftBackend, factory: FakeFactory) {
  const controller = new AbortController()
  const started = backend.start(controller.signal)
  const bot = factory.bots.at(-1)!
  bot.emit('connect')
  bot.emit('login')
  bot.emit('spawn')
  return { ready: await started, bot, controller }
}

test('strict config rejects unknown fields and unsupported versions', () => {
  assert.throws(() => parseMinecraftBackendConfig({ ...config(), extra: true }))
  assert.throws(() => parseMinecraftBackendConfig({ ...config(), server: { host: 'localhost', port: 25565, version: '1.21.2' } }))
})

test('connection_requested is safe before Mineflayer injects the game plugin', async () => {
  class PreLoginFactory extends FakeFactory {
    override create(options: SafeBotOptions): BotLike {
      const bot = super.create(options) as FakeBot
      bot.game = undefined as never
      return bot
    }
  }
  const factory = new PreLoginFactory()
  const backend = new MinecraftBackend(config(), { botFactory: factory })
  const started = backend.start(new AbortController().signal)
  await backend.stop('pre-login cleanup')
  await assert.rejects(started, error => error instanceof DOMException && error.name === 'AbortError')
})

test('AbortSignal before ready performs a deliberate stop and rejects start', async () => {
  const { backend, factory } = makeBackend()
  const controller = new AbortController()
  const started = backend.start(controller.signal)
  controller.abort()
  await assert.rejects(started, error => error instanceof DOMException && error.name === 'AbortError')
  assert.equal(backend.state().status, 'stopped')
  assert.equal(factory.bots[0]?.clearCount, 1)
  assert.equal(factory.bots.length, 1)
})

test('connection timeout seals the attempt and faults when reconnect is disabled', async () => {
  const { backend } = makeBackend({ timeouts: { connectMs: 5, loginMs: 10, spawnMs: 10, stopMs: 5 } })
  const started = backend.start(new AbortController().signal)
  await assert.rejects(started, /reconnect_disabled/)
  assert.equal(backend.state().status, 'faulted')
})

test('connect/login/spawn becomes ready and produces a detached plain snapshot', async () => {
  const { backend, factory } = makeBackend()
  assert.throws(() => backend.snapshot(), BackendNotReadyError)
  const { ready, bot } = await makeReady(backend, factory)

  assert.equal(backend.state().status, 'ready')
  assert.equal(ready.snapshot.world.worldId, 'paper-test-world')
  assert.deepEqual(ready.snapshot.self.position, { x: 1, y: 64, z: 2 })
  assert.equal(ready.snapshot.inventory.slots[0]?.itemName, 'oak_log')
  assert.equal(ready.snapshot.trackedPlayers[0]?.username, 'MineIntentBot')
  assert.equal(factory.options[0]?.logErrors, false)
  backend.sendChat('你好')
  assert.deepEqual(bot.chatMessages, ['你好'])

  bot.entity.position.x = 99
  assert.equal(ready.snapshot.self.position.x, 1)
  assert.equal(Object.getPrototypeOf(ready.snapshot.self.position), Object.prototype)
  await backend.stop('test complete')
})

test('death and respawn are distinct from dimension transition', async () => {
  const { backend, factory } = makeBackend()
  const events: BackendEventEnvelope[] = []
  backend.subscribe(event => events.push(event))
  const { bot } = await makeReady(backend, factory)

  bot.health = 0
  bot.emit('death')
  assert.equal(backend.state().status, 'dead')
  assert.equal(backend.snapshot().self.alive, false)
  assert.equal(backend.snapshot().self.health, 0)
  bot.emit('respawn')
  bot.health = 20
  bot.emit('spawn')
  assert.equal(backend.state().status, 'ready')

  bot.emit('respawn')
  bot.game.dimension = 'the_nether'
  bot.emit('game')
  bot.emit('spawn')

  const lifecycle = events.filter(event => event.kind === 'lifecycle').map(event => (event.payload as { type: string }).type)
  assert.equal(lifecycle.filter(type => type === 'died').length, 1)
  assert.equal(lifecycle.filter(type => type === 'respawned').length, 1)
  assert.equal(lifecycle.filter(type => type === 'dimension_changed').length, 1)
  await backend.stop('test complete')
})

test('kicked/error/end is sealed as one close and fatal kicks do not reconnect', async () => {
  const { backend, factory } = makeBackend()
  const events: BackendEventEnvelope[] = []
  backend.subscribe(event => events.push(event))
  const { bot } = await makeReady(backend, factory)

  bot.emit('kicked', 'You are not whitelisted', false)
  bot.emit('end', 'disconnect')
  bot.emit('end', 'duplicate')

  assert.equal(backend.state().status, 'faulted')
  const closed = events.filter(event => event.kind === 'lifecycle' && (event.payload as { type?: string }).type === 'connection_closed')
  assert.equal(closed.length, 1)
  assert.equal(factory.bots.length, 1)
})

test('structured server shutdown kick is flattened and remains retryable', async () => {
  const { backend, factory } = makeBackend({ reconnect: { ...config().reconnect, enabled: true, initialDelayMs: 1, maxDelayMs: 1 } })
  const events: BackendEventEnvelope[] = []
  backend.subscribe(event => events.push(event))
  const { bot } = await makeReady(backend, factory)
  bot.emit('kicked', { translate: 'multiplayer.disconnect.server_shutdown' }, true)
  bot.emit('end', 'socketClosed')

  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(factory.bots.length, 2)
  const closeEvent = events.find(event => event.kind === 'lifecycle' && (event.payload as { type?: string }).type === 'connection_closed')
  const close = (closeEvent?.payload as { close?: { code?: string; kick?: { text?: string } } }).close
  assert.equal(close?.code, 'server_shutdown')
  assert.match(close?.kick?.text ?? '', /server_shutdown/)
  await backend.stop('test complete')
})

test('retryable close creates a fresh epoch and stale observation source is rejected', async () => {
  const { backend, factory } = makeBackend({ reconnect: { ...config().reconnect, enabled: true, initialDelayMs: 1, maxDelayMs: 1 } })
  const { bot } = await makeReady(backend, factory)
  const oldSource = backend.observationSource()
  bot.emit('end', 'server restarting')

  await new Promise(resolve => setTimeout(resolve, 10))
  assert.equal(factory.bots.length, 2)
  const next = factory.bots[1]!
  next.emit('connect')
  next.emit('login')
  next.emit('spawn')
  await new Promise(resolve => setTimeout(resolve, 0))

  assert.equal(backend.state().status, 'ready')
  assert.equal(backend.snapshot().connectionEpoch, 2)
  assert.throws(() => oldSource.selfPose(), StaleBackendEpochError)
  await backend.stop('test complete')
})

test('observation source emits plain entity/block/sound DTOs and deduplicates compatibility sound', async () => {
  const { backend, factory } = makeBackend()
  const { bot } = await makeReady(backend, factory)
  const source = backend.observationSource()
  const events: BackendEventEnvelope[] = []
  source.subscribe(event => events.push(event))

  const zombie = {
    id: 7,
    type: 'mob',
    name: 'zombie',
    position: { x: 3, y: 64, z: 4 },
    velocity: { x: 0, y: 0, z: 0 },
    yaw: 0,
    pitch: 0,
    width: 0.6,
    height: 1.95,
    onGround: true,
    equipment: [],
  }
  bot.entities[7] = zombie
  bot.emit('entitySpawn', zombie)

  const stone = {
    position: { x: 2, y: 64, z: 2 },
    name: 'stone',
    stateId: 1,
    shapes: [[0, 0, 0, 1, 1, 1]],
    transparent: false,
    boundingBox: 'block',
    getProperties: () => ({}),
  }
  bot.blocks.set('2,64,2', stone)
  bot.emit('blockUpdate', null, stone)
  bot.emit('soundEffectHeard', 'minecraft:entity.zombie.ambient', { x: 3, y: 64, z: 4 }, 1, 1)
  bot.emit('hardcodedSoundEffectHeard', 0, 'master', { x: 3, y: 64, z: 4 }, 1, 1)

  assert.equal(source.listTrackedEntities().some(entity => entity.entityKey === '1:7'), true)
  assert.equal(source.readBlock({ x: 2, y: 64, z: 2 }).status, 'loaded')
  assert.equal(events.filter(event => event.kind === 'entity').length, 1)
  assert.equal(events.filter(event => event.kind === 'block').length, 1)
  const sounds = events.filter(event => event.kind === 'sound')
  assert.equal(sounds.length, 1)
  assert.equal((sounds[0]!.payload as ProtocolSoundPayload).soundName, 'minecraft:entity.zombie.ambient')
  assert.equal('emit' in (sounds[0]!.payload as object), false)
  await backend.stop('test complete')
})

test('stop is idempotent, clears owned listeners and never reconnects', async () => {
  const { backend, factory } = makeBackend({ reconnect: { ...config().reconnect, enabled: true } })
  const { bot } = await makeReady(backend, factory)
  await Promise.all([backend.stop('shutdown'), backend.stop('shutdown')])

  assert.equal(backend.state().status, 'stopped')
  assert.equal(bot.clearCount, 1)
  assert.equal(bot.listenerCount('spawn'), 0)
  assert.equal(bot.listenerCount('end'), 0)
  await new Promise(resolve => setTimeout(resolve, 5))
  assert.equal(factory.bots.length, 1)
})

test('twenty start/stop cycles leave every Bot listener-free', async () => {
  const { backend, factory } = makeBackend()
  for (let cycle = 0; cycle < 20; cycle++) {
    const { bot } = await makeReady(backend, factory)
    backend.observationSource().subscribe(() => {}) // intentionally not unsubscribed
    await backend.stop(`cycle-${cycle}`)
    assert.equal(bot.eventNames().length, 0)
  }
  assert.equal(factory.bots.length, 20)
  assert.equal(backend.state().status, 'stopped')
})
