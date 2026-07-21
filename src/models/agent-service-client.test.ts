import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentServiceModelProvider } from './agent-service-client.js'
import type { DecisionContext } from './contracts.js'

test('agent service provider forwards the decision context and validates the returned decision', async () => {
  let requestBody = ''
  const provider = new AgentServiceModelProvider({ baseUrl: 'http://127.0.0.1:8765', fetch: async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8765/v1/decide')
    requestBody = String(init?.body)
    return new Response(JSON.stringify({
      model: 'small-model',
      usage: { inputTokens: 12, outputTokens: 8 },
      decision: {
        protocol: 'mineintent.companion-decision.v1', speech: '走吧。', attention: { kind: 'player', target: 'Alex' },
        activity: { operation: 'start_wood_collection', summary: '一起收集木材' }, intent: { kind: 'collect', summary: '找附近的树' },
        action: { skill: 'collect_wood', args: { count: 4, maxDistance: 32 }, purpose: '参与共同收集' }, memory: null,
      },
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
  const result = await provider.run(context(), new AbortController().signal)
  assert.equal(result.decision.action?.skill, 'collect_wood')
  assert.equal(result.usage?.outputTokens, 8)
  assert.equal(JSON.parse(requestBody).runId, 'run-1')
})

test('agent service provider surfaces the service error message on failure', async () => {
  const provider = new AgentServiceModelProvider({ baseUrl: 'http://127.0.0.1:8765', fetch: async () =>
    new Response(JSON.stringify({ error: 'model decision failed validation: attention: missing keys' }), { status: 502 }) })
  await assert.rejects(provider.run(context(), new AbortController().signal), /model decision failed validation/u)
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
    }, activity: undefined, recentEvents: [], memories: [], observations: { omissions: [] }, availableSkills: ['collect_wood'],
  }
}
