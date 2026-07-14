import assert from 'node:assert/strict'
import test from 'node:test'
import {
  informationCatalogRequestSchema,
  informationQueryRequestSchema,
} from './schemas.js'

test('information request schemas are strict and versioned', () => {
  assert.equal(informationCatalogRequestSchema.safeParse({
    operation: 'list_interfaces',
  }).success, true)
  assert.equal(informationCatalogRequestSchema.safeParse({
    operation: 'list_interfaces',
    audience: 'operator',
  }).success, false)
  assert.equal(informationQueryRequestSchema.safeParse({
    interfaceId: 'current_status',
    operation: 'read',
    schemaRevision: 'status:1',
    fields: ['health'],
  }).success, true)
  assert.equal(informationQueryRequestSchema.safeParse({
    interfaceId: 'current_status',
    operation: 'read',
    schemaRevision: 'status:1',
    fields: ['health'],
    worldId: 'forged-world',
  }).success, false)
  assert.equal(informationQueryRequestSchema.safeParse({
    interfaceId: 'not-an-interface',
    operation: 'help',
  }).success, false)
})
