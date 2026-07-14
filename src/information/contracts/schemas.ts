import { z } from 'zod'
import {
  INFORMATION_AUDIENCES,
  INFORMATION_AVAILABILITIES,
  INFORMATION_ERROR_CODES,
  INFORMATION_INTERFACE_IDS,
  INFORMATION_SOURCE_KINDS,
} from './v1.js'

export const informationInterfaceIdSchema = z.enum(INFORMATION_INTERFACE_IDS)
export const informationAudienceSchema = z.enum(INFORMATION_AUDIENCES)
export const informationSourceKindSchema = z.enum(INFORMATION_SOURCE_KINDS)
export const informationAvailabilitySchema = z.enum(INFORMATION_AVAILABILITIES)
export const informationErrorCodeSchema = z.enum(INFORMATION_ERROR_CODES)

export const informationCatalogRequestSchema = z.object({
  operation: z.literal('list_interfaces'),
  knownCatalogRevision: z.string().min(1).max(160).optional(),
}).strict()

export const informationSelectorRefSchema = z.object({
  protocol: z.literal('mineintent.information-selector-ref.v1'),
  id: z.string().min(16).max(160),
  interfaceId: informationInterfaceIdSchema,
  connectionEpoch: z.number().int().nonnegative(),
  worldId: z.string().min(1).max(256).optional(),
  screenInstanceId: z.string().min(1).max(256).optional(),
  basedOnInformationRevision: z.number().int().nonnegative(),
  validUntil: z.iso.datetime().optional(),
}).strict()

const helpRequestSchema = z.object({
  interfaceId: informationInterfaceIdSchema,
  operation: z.literal('help'),
  availability: z.enum(['all', 'current']).optional(),
  search: z.string().min(1).max(160).optional(),
  fields: z.array(z.string().min(1).max(160)).max(128).optional(),
}).strict()

const readRequestSchema = z.object({
  interfaceId: informationInterfaceIdSchema,
  operation: z.literal('read'),
  schemaRevision: z.string().min(1).max(160),
  fields: z.array(z.string().min(1).max(160)).min(1).max(128),
  selector: informationSelectorRefSchema.optional(),
  page: z.object({
    cursor: z.string().min(16).max(160).optional(),
    limit: z.number().int().positive().max(10_000).optional(),
  }).strict().optional(),
}).strict()

export const informationQueryRequestSchema = z.discriminatedUnion('operation', [
  helpRequestSchema,
  readRequestSchema,
])
