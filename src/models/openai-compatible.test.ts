import assert from 'node:assert/strict'
import { test } from 'node:test'
import { OpenAICompatibleModelProvider } from './openai-compatible.js'
import type { DecisionContext } from './contracts.js'

test('OpenAI-compatible provider validates a strict structured decision without exposing its key', async () => {
  let authorization = ''
  const provider = new OpenAICompatibleModelProvider({ baseUrl: 'https://model.invalid/v1', apiKey: 'sk-test-secret', model: 'small-model', fetch: async (_input, init) => {
    authorization = new Headers(init?.headers).get('authorization') ?? ''
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify({
      protocol: 'mineintent.companion-decision.v1', speech: '走吧。', attention: { kind: 'player', target: 'Alex' },
      activity: { operation: 'start_wood_collection', summary: '一起收集木材' }, intent: { kind: 'collect', summary: '找附近的树' },
      action: { skill: 'collect_wood', args: { count: 4, maxDistance: 32 }, purpose: '参与共同收集' }, memory: null,
    }) } }], usage: { prompt_tokens: 12, completion_tokens: 8 } }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  const result = await provider.run(context(), new AbortController().signal)
  assert.equal(result.decision.action?.skill, 'collect_wood')
  assert.equal(result.usage?.outputTokens, 8)
  assert.equal(authorization, 'Bearer sk-test-secret')
  assert.doesNotMatch(JSON.stringify(result), /sk-test-secret/u)
})

function context(): DecisionContext {
  return {
    runId: 'run-1', trigger: { type: 'player_chat', text: '一起收集木头吧', eventId: 'event-1' }, primaryPlayer: 'Alex',
    profile: { profileId: 'test', versionId: 'v1', content: '你是伙伴。', sourcePath: 'profile.md' },
    snapshot: {
      protocol: 'mineintent.minecraft.snapshot.v1', snapshotRevision: 1, lifecycleRevision: 1, capturedAt: new Date().toISOString(),
      processSessionId: 'session', connectionEpoch: 1, connectionAttemptId: 'attempt',
      world: { worldId: 'world', dimension: 'overworld', minecraftVersion: '1.21.1', protocolVersion: 767, gameMode: 'survival', minY: -64, height: 384 },
      self: { entityKey: 'self', username: 'Bot', position: { x: 0, y: 64, z: 0 }, velocity: { x: 0, y: 0, z: 0 }, yaw: 0, pitch: 0, onGround: true, alive: true, health: 20, food: 20, foodSaturation: 5, effects: [] },
      inventory: { selectedHotbarSlot: 0, slots: [] }, trackedPlayers: [],
    }, activity: undefined, recentEvents: [], memories: [], availableSkills: ['collect_wood'],
  }
}
