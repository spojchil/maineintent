import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { Bot } from 'mineflayer'
import { Vec3 } from 'vec3'
import { MineflayerMotorDriver } from './motor-driver.js'

test('motor driver exposes bounded look without selecting a target', async () => {
  const bot = fakeBot()
  const driver = new MineflayerMotorDriver(bot as unknown as Bot)
  await driver.look(0.25, -0.1, new AbortController().signal)
  assert.deepEqual(bot.lookCalls, [{ yaw: 0.25, pitch: -0.1, force: false }])
  await assert.rejects(driver.look(Number.NaN, 0, new AbortController().signal), TypeError)
  await assert.rejects(driver.look(0, Math.PI, new AbortController().signal), RangeError)
})

test('motor look returns promptly when its controller is cancelled', async () => {
  let finish!: () => void
  const bot = fakeBot()
  bot.look = (yaw: number, pitch: number, force: boolean) => {
    bot.lookCalls.push({ yaw, pitch, force })
    return new Promise<void>(resolve => { finish = resolve })
  }
  const driver = new MineflayerMotorDriver(bot as unknown as Bot)
  const controller = new AbortController()
  const pending = driver.look(0.5, 0, controller.signal)
  controller.abort('superseded')
  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
  finish()
})

test('dig feedback is explicitly client-predicted and release clears owned inputs', async () => {
  const bot = fakeBot()
  const driver = new MineflayerMotorDriver(bot as unknown as Bot)
  assert.deepEqual(await driver.dig({ x: 1, y: 64, z: -2 }, new AbortController().signal), {
    stage: 'client_predicted', name: 'oak_log', position: { x: 1, y: 64, z: -2 },
  })
  driver.releaseAll()
  assert.equal(bot.stopDiggingCalls, 1)
  assert.equal(bot.clearControlStatesCalls, 1)
})

function fakeBot() {
  const block = { name: 'oak_log', position: new Vec3(1, 64, -2) }
  return {
    lookCalls: [] as Array<{ yaw: number; pitch: number; force: boolean }>,
    stopDiggingCalls: 0,
    clearControlStatesCalls: 0,
    async look(yaw: number, pitch: number, force: boolean) { this.lookCalls.push({ yaw, pitch, force }) },
    blockAt(position: Vec3) { return position.equals(block.position) ? block : null },
    canDigBlock(candidate: unknown) { return candidate === block },
    async dig() {},
    stopDigging() { this.stopDiggingCalls++ },
    clearControlStates() { this.clearControlStatesCalls++ },
  }
}
