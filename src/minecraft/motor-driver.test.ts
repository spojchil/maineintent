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

test('relative look converts player-facing right/down degrees to Mineflayer angles', async () => {
  const bot = fakeBot()
  bot.entity.yaw = 0.4
  bot.entity.pitch = 0.1
  const driver = new MineflayerMotorDriver(bot as unknown as Bot)
  await driver.lookRelative(30, 20, new AbortController().signal)

  assert.equal(bot.lookCalls.length, 1)
  assert.ok(Math.abs(bot.lookCalls[0]!.yaw - (0.4 - Math.PI / 6)) < 1e-12)
  assert.ok(Math.abs(bot.lookCalls[0]!.pitch - (0.1 - Math.PI / 9)) < 1e-12)
  await assert.rejects(driver.lookRelative(91, 0, new AbortController().signal), RangeError)
  await assert.rejects(driver.lookRelative(0, Number.NaN, new AbortController().signal), TypeError)
})

test('short move presses only requested controls and releases them after its hard-bounded hold', async () => {
  const bot = fakeBot()
  const driver = new MineflayerMotorDriver(bot as unknown as Bot)
  await driver.move('forward', 50, true, new AbortController().signal)
  assert.deepEqual(bot.controlStateCalls, [
    { control: 'forward', state: true },
    { control: 'sprint', state: true },
    { control: 'sprint', state: false },
    { control: 'forward', state: false },
  ])

  await assert.rejects(driver.move('forward', 49, false, new AbortController().signal), RangeError)
  await assert.rejects(driver.move('forward', 1_501, false, new AbortController().signal), RangeError)
  await assert.rejects(driver.move('jump' as 'forward', 50, false, new AbortController().signal), TypeError)
})

test('aborting a move immediately releases every control pressed by that move', async () => {
  const bot = fakeBot()
  const driver = new MineflayerMotorDriver(bot as unknown as Bot)
  const controller = new AbortController()
  const pending = driver.move('left', 1_500, true, controller.signal)
  controller.abort('player_interrupted')

  await assert.rejects(pending, error => error instanceof DOMException && error.name === 'AbortError')
  assert.deepEqual(bot.controlStateCalls.slice(-2), [
    { control: 'sprint', state: false },
    { control: 'left', state: false },
  ])
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
    entity: { yaw: 0, pitch: 0 },
    lookCalls: [] as Array<{ yaw: number; pitch: number; force: boolean }>,
    controlStateCalls: [] as Array<{ control: string; state: boolean }>,
    stopDiggingCalls: 0,
    clearControlStatesCalls: 0,
    async look(yaw: number, pitch: number, force: boolean) { this.lookCalls.push({ yaw, pitch, force }) },
    setControlState(control: string, state: boolean) { this.controlStateCalls.push({ control, state }) },
    blockAt(position: Vec3) { return position.equals(block.position) ? block : null },
    canDigBlock(candidate: unknown) { return candidate === block },
    async dig() {},
    stopDigging() { this.stopDiggingCalls++ },
    clearControlStates() { this.clearControlStatesCalls++ },
  }
}
