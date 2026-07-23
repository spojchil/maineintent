import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentServiceModelProvider } from './agent-service-client.js'
import type { ContextPackageV2 } from './contracts.js'

test('agent service provider forwards V2 context and schema and returns raw output', async () => {
  let requestBody = ''
  let requestHeaders: Headers | undefined
  const rawOutput = { protocol: 'mineintent.decision.v2', effects: [] }
  const provider = new AgentServiceModelProvider({
    baseUrl: 'http://127.0.0.1:8765',
    toolCallbackUrl: 'http://127.0.0.1:43210/v1/experiment/d40/tool',
    toolCallbackToken: 'test-callback-token-long-enough',
    fetch: async (input, init) => {
      assert.equal(String(input), 'http://127.0.0.1:8765/v1/decide')
      requestBody = String(init?.body)
      requestHeaders = new Headers(init?.headers)
      return new Response(JSON.stringify({
        model: 'small-model',
        usage: { inputTokens: 12, outputTokens: 8 },
        rawOutput,
      }), { status: 200, headers: { 'content-type': 'application/json' } })
    },
  })
  const result = await provider.runDecision({
    context: context(),
    outputSchema: { type: 'object', additionalProperties: false },
    signal: new AbortController().signal,
  })
  assert.deepEqual(result.rawOutput, rawOutput)
  assert.equal(result.usage?.outputTokens, 8)
  const request = JSON.parse(requestBody) as Record<string, Record<string, unknown>>
  assert.equal(request.context?.protocol, 'mineintent.context.v2')
  assert.equal(request.outputSchema?.additionalProperties, false)
  assert.equal(requestHeaders?.get('x-mineintent-tool-executor-url'), 'http://127.0.0.1:43210/v1/experiment/d40/tool')
  assert.equal(requestHeaders?.get('x-mineintent-tool-executor-token'), 'test-callback-token-long-enough')
})

test('agent service provider omits D40 callback headers unless both callback values are configured', async () => {
  let headers: Headers | undefined
  const provider = new AgentServiceModelProvider({ baseUrl: 'http://127.0.0.1:8765', fetch: async (_input, init) => {
    headers = new Headers(init?.headers)
    return new Response(JSON.stringify({ rawOutput: {}, model: 'small-model' }), { status: 200 })
  } })
  await provider.runDecision({ context: context(), outputSchema: {}, signal: new AbortController().signal })
  assert.equal(headers?.has('x-mineintent-tool-executor-url'), false)
  assert.equal(headers?.has('x-mineintent-tool-executor-token'), false)
  assert.throws(() => new AgentServiceModelProvider({
    baseUrl: 'http://127.0.0.1:8765', toolCallbackUrl: 'http://127.0.0.1:1234/tool',
  }), /configured together/u)
  assert.throws(() => new AgentServiceModelProvider({
    baseUrl: 'http://127.0.0.1:8765',
    toolCallbackUrl: 'https://example.com/tool',
    toolCallbackToken: 'test-callback-token-long-enough',
  }), /loopback HTTP URL/u)
})

test('agent service provider only exposes the D40 callback to player-chat decision runs', async () => {
  const seen: Headers[] = []
  const provider = new AgentServiceModelProvider({
    baseUrl: 'http://127.0.0.1:8765',
    toolCallbackUrl: 'http://127.0.0.1:43210/v1/experiment/d40/tool',
    toolCallbackToken: 'test-callback-token-long-enough',
    fetch: async (_input, init) => {
      seen.push(new Headers(init?.headers))
      return new Response(JSON.stringify({ rawOutput: {}, model: 'small-model' }), { status: 200 })
    },
  })
  for (const triggerType of ['startup', 'action_result', 'danger'] as const) {
    await provider.runDecision({ context: context(triggerType), outputSchema: {}, signal: new AbortController().signal })
  }
  assert.equal(seen.length, 3)
  for (const headers of seen) {
    assert.equal(headers.has('x-mineintent-tool-executor-url'), false)
    assert.equal(headers.has('x-mineintent-tool-executor-token'), false)
  }
})

test('agent service provider surfaces a bounded service error message', async () => {
  const provider = new AgentServiceModelProvider({ baseUrl: 'http://127.0.0.1:8765', fetch: async () =>
    new Response(JSON.stringify({ error: 'model request failed upstream' }), { status: 502 }) })
  await assert.rejects(provider.runDecision({
    context: context(), outputSchema: {}, signal: new AbortController().signal,
  }), /model request failed upstream/u)
})

test('agent service provider rejects a malformed success envelope', async () => {
  const provider = new AgentServiceModelProvider({ baseUrl: 'http://127.0.0.1:8765', fetch: async () =>
    new Response(JSON.stringify({ decision: {}, model: 'small-model' }), { status: 200 }) })
  await assert.rejects(provider.runDecision({
    context: context(), outputSchema: {}, signal: new AbortController().signal,
  }), /rawOutput/u)
})

function context(triggerType = 'player_chat'): ContextPackageV2 {
  return {
    protocol: 'mineintent.context.v2',
    ref: {
      runId: 'run-1', companionId: 'companion', sessionId: 'session-1', worldId: 'world',
      companionRevision: 0, throughEventSequence: 1, profileVersion: 'profile-1', capabilityRevision: 'cap-1',
    },
    createdAt: '2026-07-22T00:00:00.000Z',
    trigger: { eventIds: ['event-1'], route: 'new', reason: 'player message', priority: 70 },
    limits: { maxInputTokens: 16_000, reservedOutputTokens: 3_000, estimatedInputTokens: 1 },
    fragments: [
      {
        id: 'fragment-1', section: 'product_constraints',
        source: { kind: 'runtime', ids: ['constraints-1'], trust: 'runtime_authoritative' },
        content: {}, budget: { estimatedTokens: 1, originalEstimatedTokens: 1, truncated: false },
      },
      {
        id: 'fragment_trigger', section: 'trigger_events',
        source: {
          kind: triggerType === 'player_chat' ? 'player' : 'event', ids: ['event-1'],
          trust: triggerType === 'player_chat' ? 'player_statement' : 'runtime_authoritative',
        },
        content: { id: 'event-1', type: triggerType },
        budget: { estimatedTokens: 1, originalEstimatedTokens: 1, truncated: false },
      },
    ],
    omissions: [],
  }
}
