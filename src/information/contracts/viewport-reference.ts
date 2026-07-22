import { z } from 'zod'

const pointSchema = z.strictObject({
  x: z.number().finite(),
  y: z.number().finite(),
  z: z.number().finite(),
})

const blockPositionSchema = z.strictObject({
  x: z.number().int(),
  y: z.number().int(),
  z: z.number().int(),
})

const evidenceIdsSchema = z.array(z.string().min(1).max(256)).max(64)

/**
 * Private payload retained behind an opaque viewport ref. Exact positions and entity keys
 * are available only to Grounding and scoped controllers; they are never model-facing values.
 */
export const viewportObservationRefPayloadSchema = z.discriminatedUnion('kind', [
  z.strictObject({
    kind: z.literal('block'),
    name: z.string().min(1).max(160),
    position: blockPositionSchema,
    evidenceIds: evidenceIdsSchema,
  }),
  z.strictObject({
    kind: z.literal('entity'),
    entityKey: z.string().min(1).max(256),
    type: z.string().min(1).max(160),
    name: z.string().min(1).max(256).optional(),
    username: z.string().min(1).max(256).optional(),
    position: pointSchema,
    evidenceIds: evidenceIdsSchema,
  }),
])

export type ViewportObservationRefPayload = z.infer<typeof viewportObservationRefPayloadSchema>
