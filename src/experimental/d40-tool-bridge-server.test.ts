import assert from 'node:assert/strict'
import { test } from 'node:test'
import { D40ToolBridgeServer, type D40ToolInvocation } from './index.js'

test('D40 tool bridge is loopback-only, authenticated and forwards one bounded invocation', async () => {
  const seen: D40ToolInvocation[] = []
  const bridge = new D40ToolBridgeServer(async invocation => {
    seen.push(invocation)
    return { status: 'completed', viewport: { visibleEntities: [] } }
  }, 'test-token-that-is-long-enough')
  const address = await bridge.start()
  try {
    assert.equal(address.host, '127.0.0.1')
    assert.equal(address.url, `http://127.0.0.1:${address.port}/v1/experiment/d40/tool`)
    const response = await invoke(address.url, address.token, {
      runId: 'run-1', name: 'move_input', arguments: { direction: 'forward', duration_ms: 250 },
    })
    assert.equal(response.status, 200)
    assert.deepEqual(await response.json(), { status: 'completed', viewport: { visibleEntities: [] } })
    assert.deepEqual(seen, [{ runId: 'run-1', name: 'move_input', arguments: { direction: 'forward', duration_ms: 250 } }])
  } finally {
    await bridge.stop()
  }
})

test('D40 tool bridge rejects unauthenticated, malformed and oversized requests before the handler', async () => {
  let calls = 0
  const bridge = new D40ToolBridgeServer(async () => { calls++; return {} }, 'test-token-that-is-long-enough')
  const address = await bridge.start()
  try {
    const unauthorized = await fetch(address.url, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
    })
    assert.equal(unauthorized.status, 401)

    const malformed = await invoke(address.url, address.token, { runId: 'run-1', name: 'look_relative' })
    assert.equal(malformed.status, 400)

    const oversized = await invoke(address.url, address.token, {
      runId: 'run-1', name: 'look_relative', arguments: { padding: 'x'.repeat(33_000) },
    })
    assert.equal(oversized.status, 413)
    assert.equal(calls, 0)
  } finally {
    await bridge.stop()
  }
})

test('D40 tool bridge bounds handler failures and keeps the endpoint usable', async () => {
  let fail = true
  const bridge = new D40ToolBridgeServer(async () => {
    if (fail) throw new Error('x'.repeat(2_000))
    return { status: 'completed' }
  }, 'test-token-that-is-long-enough')
  const address = await bridge.start()
  try {
    const failed = await invoke(address.url, address.token, { runId: 'run-1', name: 'look_relative', arguments: {} })
    assert.equal(failed.status, 500)
    const error = await failed.json() as { error: string }
    assert.equal(error.error.length, 500)
    fail = false
    assert.equal((await invoke(address.url, address.token, {
      runId: 'run-1', name: 'look_relative', arguments: { yaw_degrees: 5, pitch_degrees: 0 },
    })).status, 200)
  } finally {
    await bridge.stop()
  }
})

function invoke(url: string, token: string, value: unknown): Promise<Response> {
  return fetch(url, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify(value),
  })
}
