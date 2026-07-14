import assert from 'node:assert/strict'
import test from 'node:test'
import type { InformationGrant, InformationScopeSnapshot } from './contracts/index.js'
import { InformationCursorStore } from './cursor-store.js'
import { InformationRefStore } from './ref-store.js'

const scope: InformationScopeSnapshot = {
  processSessionId: 'process-1',
  connectionState: 'play',
  connectionEpoch: 4,
  worldId: 'world-1',
  dimension: 'minecraft:overworld',
  uiRevision: 8,
  screenInstanceId: 'screen-1',
  screenRevision: 3,
  capturedAt: '2026-07-14T00:00:00.000Z',
}

const grant: InformationGrant = {
  id: 'grant-1',
  principalId: 'model-1',
  audience: 'companion',
  allowedInterfaces: '*',
  purpose: 'model_tool',
}

test('opaque references bind principal, grant, scope, target and full ref content', () => {
  const store = new InformationRefStore({ now: () => new Date('2026-07-14T00:00:00.000Z') })
  const ref = store.issuer({
    interfaceId: 'inventory_information',
    principalId: 'model-1',
    grant,
    scope,
  }).issue({
    kind: 'item',
    payload: { slot: 5, internalId: 72 },
    allowedInterfaces: ['item_tooltip_information'],
    basedOnInformationRevision: 11,
    bindToScreen: true,
  })

  assert.deepEqual(store.resolve({
    ref,
    targetInterface: 'item_tooltip_information',
    principalId: 'model-1',
    grant,
    scope,
    acceptedKinds: ['item'],
  }), { slot: 5, internalId: 72 })
  assert.equal(store.resolve({
    ref: { ...ref, basedOnInformationRevision: 12 },
    targetInterface: 'item_tooltip_information',
    principalId: 'model-1',
    grant,
    scope,
  }), undefined)
  assert.equal(store.resolve({
    ref,
    targetInterface: 'current_status',
    principalId: 'model-1',
    grant,
    scope,
  }), undefined)
  assert.equal(store.resolve({
    ref,
    targetInterface: 'item_tooltip_information',
    principalId: 'other-model',
    grant,
    scope,
  }), undefined)
  assert.equal(store.resolve({
    ref,
    targetInterface: 'item_tooltip_information',
    principalId: 'model-1',
    grant,
    scope: { ...scope, dimension: 'minecraft:the_nether' },
  }), undefined)

  store.invalidate({ kind: 'screen_changed', screenInstanceId: 'screen-2', screenRevision: 1 })
  assert.equal(store.size(), 0)
})

test('cursors bind query shape and are one-time continuations', () => {
  const store = new InformationCursorStore({ now: () => new Date('2026-07-14T00:00:00.000Z') })
  const cursor = store.issue({
    interfaceId: 'inventory_information',
    fields: ['slots'],
    informationRevision: 9,
    limit: 20,
    pageState: { offset: 20 },
    principalId: 'model-1',
    grant,
    scope,
  })
  assert.equal(store.resolve({
    cursor,
    interfaceId: 'inventory_information',
    fields: ['slots', 'selected'],
    limit: 20,
    principalId: 'model-1',
    grant,
    scope,
  }), undefined)
  assert.deepEqual(store.resolve<{ offset: number }>({
    cursor,
    interfaceId: 'inventory_information',
    fields: ['slots'],
    limit: 20,
    principalId: 'model-1',
    grant,
    scope,
  }), { state: { offset: 20 }, informationRevision: 9 })
  assert.equal(store.resolve({
    cursor,
    interfaceId: 'inventory_information',
    fields: ['slots'],
    limit: 20,
    principalId: 'model-1',
    grant,
    scope,
  }), undefined)
})
