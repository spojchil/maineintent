import assert from 'node:assert/strict'
import { test } from 'node:test'
import { AgentServiceModelProvider } from './agent-service-client.js'
import type { ContextPackageV2 } from './contracts.js'

test('agent service provider forwards V2 context and schema and returns raw output', async () => {
  let requestBody = ''
  const rawOutput = { protocol: 'mineintent.decision.v2', effects: [] }
  const provider = new AgentServiceModelProvider({ baseUrl: 'http://127.0.0.1:8765', fetch: async (input, init) => {
    assert.equal(String(input), 'http://127.0.0.1:8765/v1/decide')
    requestBody = String(init?.body)
    return new Response(JSON.stringify({
      model: 'small-model',
      usage: { inputTokens: 12, outputTokens: 8 },
      rawOutput,
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  } })
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

function context(): ContextPackageV2 {
  return {
    protocol: 'mineintent.context.v2',
    ref: {
      runId: 'run-1', companionId: 'companion', sessionId: 'session-1', worldId: 'world',
      companionRevision: 0, throughEventSequence: 1, profileVersion: 'profile-1', capabilityRevision: 'cap-1',
    },
    createdAt: '2026-07-22T00:00:00.000Z',
    trigger: { eventIds: ['event-1'], route: 'new', reason: 'player message', priority: 70 },
    limits: { maxInputTokens: 16_000, reservedOutputTokens: 3_000, estimatedInputTokens: 1 },
    fragments: [{
      id: 'fragment-1', section: 'product_constraints',
      source: { kind: 'runtime', ids: ['constraints-1'], trust: 'runtime_authoritative' },
      content: {}, budget: { estimatedTokens: 1, originalEstimatedTokens: 1, truncated: false },
    }],
    omissions: [],
  }
}
