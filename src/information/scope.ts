import type {
  InformationScopeDependency,
  InformationScopeSnapshot,
} from './contracts/index.js'

export interface InformationScopeSource {
  capture(): Readonly<InformationScopeSnapshot>
}

export class MutableInformationScopeSource implements InformationScopeSource {
  #snapshot: InformationScopeSnapshot

  constructor(initial: InformationScopeSnapshot) {
    this.#snapshot = structuredClone(initial)
  }

  capture(): Readonly<InformationScopeSnapshot> {
    return Object.freeze(structuredClone(this.#snapshot))
  }

  update(next: InformationScopeSnapshot): void {
    this.#snapshot = structuredClone(next)
  }
}

export function scopeChanged(
  before: InformationScopeSnapshot,
  after: InformationScopeSnapshot,
  dependencies: readonly InformationScopeDependency[],
): boolean {
  if (before.processSessionId !== after.processSessionId) return true
  for (const dependency of dependencies) {
    switch (dependency) {
      case 'connection':
        if (before.connectionEpoch !== after.connectionEpoch ||
            before.connectionState !== after.connectionState) return true
        break
      case 'world':
        if (before.worldId !== after.worldId) return true
        break
      case 'dimension':
        if (before.dimension !== after.dimension) return true
        break
      case 'ui':
        if (before.uiRevision !== after.uiRevision) return true
        break
      case 'screen':
        if (before.screenInstanceId !== after.screenInstanceId ||
            before.screenRevision !== after.screenRevision) return true
        break
    }
  }
  return false
}
