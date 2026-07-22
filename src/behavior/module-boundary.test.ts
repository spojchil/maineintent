import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('Behavior dispatch cannot consume raw client state or free-text decision summaries', () => {
  const source = readFileSync(new URL('./behavior-synthesizer.ts', import.meta.url), 'utf8')
  for (const forbidden of [
    '../minecraft', 'mineflayer', 'ProtocolObservationSource', '.description', 'desiredOutcome', '.summary',
  ]) {
    assert.equal(source.includes(forbidden), false, `Behavior synthesizer contains forbidden dependency ${forbidden}`)
  }
})
