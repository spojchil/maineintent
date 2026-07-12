import type { BodyResource } from './contracts.js'

export class BodyResourceLocks {
  readonly #owners = new Map<BodyResource, string>()

  conflict(actionId: string, resources: readonly BodyResource[]): { resource: BodyResource; owner: string } | undefined {
    for (const resource of new Set(resources)) {
      const owner = this.#owners.get(resource)
      if (owner && owner !== actionId) return { resource, owner }
    }
    return undefined
  }

  acquire(actionId: string, resources: readonly BodyResource[]): void {
    const conflict = this.conflict(actionId, resources)
    if (conflict) throw new Error(`Resource ${conflict.resource} is held by ${conflict.owner}`)
    for (const resource of new Set(resources)) this.#owners.set(resource, actionId)
  }

  release(actionId: string): void {
    for (const [resource, owner] of this.#owners) if (owner === actionId) this.#owners.delete(resource)
  }

  snapshot(): Readonly<Record<BodyResource, string | undefined>> {
    return Object.freeze({
      locomotion: this.#owners.get('locomotion'), gaze: this.#owners.get('gaze'), hands: this.#owners.get('hands'),
      inventory: this.#owners.get('inventory'), interaction: this.#owners.get('interaction'),
    })
  }
}
