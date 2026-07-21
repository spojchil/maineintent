import assert from 'node:assert/strict'
import { test } from 'node:test'
import { distanceBetween, lookDirection, relativeBearing } from './geometry.js'

test('distanceBetween computes 3D euclidean distance', () => {
  assert.equal(distanceBetween({ x: 0, y: 0, z: 0 }, { x: 3, y: 0, z: 4 }), 5)
  assert.equal(distanceBetween({ x: 1, y: 1, z: 1 }, { x: 1, y: 1, z: 1 }), 0)
})

test('lookDirection points south at yaw 0 pitch 0', () => {
  const direction = lookDirection(0, 0)
  assert.ok(Math.abs(direction.x) < 1e-9)
  assert.ok(Math.abs(direction.z - 1) < 1e-9)
  assert.ok(Math.abs(direction.y) < 1e-9)
})

test('relativeBearing classifies target position relative to self facing', () => {
  const self = { x: 0, y: 64, z: 0 }
  assert.equal(relativeBearing(0, self, { x: 0, y: 64, z: 5 }), 'ahead')
  assert.equal(relativeBearing(0, self, { x: 0, y: 64, z: -5 }), 'behind')
  assert.equal(relativeBearing(0, self, { x: -5, y: 64, z: 0 }), 'right')
  assert.equal(relativeBearing(0, self, { x: 5, y: 64, z: 0 }), 'left')
})

test('relativeBearing rotates with self yaw', () => {
  const self = { x: 0, y: 64, z: 0 }
  // facing east (yaw = -PI/2 in this convention: lookDirection(-PI/2,0) -> x=1,z=0)
  const facingEastYaw = -Math.PI / 2
  assert.equal(relativeBearing(facingEastYaw, self, { x: 5, y: 64, z: 0 }), 'ahead')
})

test('relativeBearing defaults to ahead when target is exactly at self position', () => {
  const self = { x: 0, y: 64, z: 0 }
  assert.equal(relativeBearing(0, self, { x: 0, y: 64, z: 0 }), 'ahead')
})
