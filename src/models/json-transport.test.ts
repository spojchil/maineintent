import assert from 'node:assert/strict'
import { test } from 'node:test'
import { JsonTransportError, readJsonResponse, stringifyJson } from './json-transport.js'

test('strict JSON transport preserves Unicode and rejects lossy numbers', () => {
  assert.equal(stringifyJson({ message: '一起玩😀' }), '{"message":"一起玩😀"}')
  assert.throws(() => stringifyJson({ value: Number.NaN }), JsonTransportError)
  assert.throws(() => stringifyJson({ value: Number.POSITIVE_INFINITY }), JsonTransportError)
  assert.throws(() => stringifyJson({ value: Number.MAX_SAFE_INTEGER + 1 }), JsonTransportError)
})

test('strict JSON transport rejects unpaired surrogates and byte overflow', () => {
  assert.throws(() => stringifyJson({ value: '\ud800' }), JsonTransportError)
  assert.throws(() => stringifyJson({ value: '界界' }, 8), /exceeds/u)
})

test('strict JSON response reading enforces encoding, syntax and body limits', async () => {
  const valid = await readJsonResponse(new Response('{"message":"你好😀"}'))
  assert.deepEqual(valid, { message: '你好😀' })

  await assert.rejects(readJsonResponse(new Response('NaN')), /valid JSON/u)
  await assert.rejects(readJsonResponse(new Response('"\\ud800"')), /unpaired Unicode surrogate/u)
  await assert.rejects(readJsonResponse(new Response(new Uint8Array([0xff]))), /valid UTF-8/u)
  await assert.rejects(readJsonResponse(new Response('123456789'), 8), /exceeds/u)
})
