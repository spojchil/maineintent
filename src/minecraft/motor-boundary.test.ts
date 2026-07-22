import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { test } from 'node:test'

test('production motor boundary contains no target search or omniscient pathfinder', () => {
  const contracts = readFileSync(new URL('./contracts.ts', import.meta.url), 'utf8')
  const driver = readFileSync(new URL('./motor-driver.ts', import.meta.url), 'utf8')
  const factory = readFileSync(new URL('./mineflayer-bot-factory.ts', import.meta.url), 'utf8')
  const packageJson = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
    dependencies?: Record<string, string>
  }

  for (const forbidden of ['findNearestBlock', 'findBlock', 'navigateToPlayer', 'nearestThreat', 'inventoryCount']) {
    assert.equal(contracts.includes(forbidden), false, `motor contract leaks ${forbidden}`)
    assert.equal(driver.includes(forbidden), false, `motor driver performs ${forbidden}`)
  }
  assert.equal(packageJson.dependencies?.['mineflayer-pathfinder'], undefined)
  assert.equal(factory.includes('loadPlugin'), false)
})
