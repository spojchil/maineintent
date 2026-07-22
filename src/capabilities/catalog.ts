import { createHash } from 'node:crypto'

export interface BodyAffordanceDescriptor {
  kind: string
  description: string
}

export interface BodyCapabilityCatalog {
  schema: 'mineintent.body-affordances.v1'
  affordances: readonly BodyAffordanceDescriptor[]
  limits: readonly string[]
}

/**
 * Model-facing capability metadata only. This module contains no executable
 * callback, controller id, protocol transaction, target resolver, or input
 * template. A descriptor therefore cannot grant execution authority.
 */
export const BODY_CAPABILITY_CATALOG: BodyCapabilityCatalog = Object.freeze({
  schema: 'mineintent.body-affordances.v1',
  affordances: Object.freeze([
    Object.freeze({ kind: 'gaze_change', description: 'Can change first-person gaze and scan to acquire new legal observations.' }),
    Object.freeze({ kind: 'locomotion', description: 'Can move through locally justified space under bounded, cancellable control.' }),
    Object.freeze({ kind: 'primary_interaction', description: 'Can perform the current ordinary primary interaction on a grounded, revalidated target.' }),
    Object.freeze({ kind: 'secondary_interaction', description: 'Can perform the current ordinary secondary interaction when its visible target and held-item context are valid.' }),
    Object.freeze({ kind: 'inventory_selection', description: 'Can select among currently observed inventory or hotbar choices.' }),
    Object.freeze({ kind: 'wait', description: 'Can deliberately release body input and wait for new information or interaction.' }),
  ]),
  limits: Object.freeze([
    'Unknown or stale referents remain unknown; tracked protocol coordinates are not cognitive evidence.',
    'Behavior planning may use only grounded referents and legal Information Reads.',
    'Every controller is bounded, cancellable, revalidates its target, and reports effects separately from success.',
  ]),
})

export const BODY_CAPABILITY_REVISION = `cap_${createHash('sha256')
  .update(JSON.stringify(BODY_CAPABILITY_CATALOG))
  .digest('hex')
  .slice(0, 16)}`
