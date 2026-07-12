import type {
  ActionGroupRejection, ActionGroupRequest, ActionRequest, ActionResult, ActionRuntimeEvent,
  ActionSideEffect, BodyResource, SkillContext, SkillDefinition, SubmitResult,
} from './contracts.js'
import { BodyResourceLocks } from './resource-locks.js'

interface Prepared { request: ActionRequest; skill: SkillDefinition<unknown, unknown>; args: unknown }
interface Active { prepared: Prepared; controller: AbortController; sideEffects: ActionSideEffect[]; cancel?: { status: 'cancelled' | 'interrupted'; reason: string } }

export class ActionRuntime {
  readonly #skills = new Map<string, SkillDefinition<unknown, unknown>>()
  readonly #locks = new BodyResourceLocks()
  readonly #listeners = new Set<(event: ActionRuntimeEvent) => void>()
  readonly #active = new Map<string, Active>()

  register<Args, Result>(skill: SkillDefinition<Args, Result>): void {
    if (!skill.name || this.#skills.has(skill.name)) throw new Error(`Duplicate or empty skill: ${skill.name}`)
    if (!Number.isFinite(skill.defaultTimeoutMs) || skill.defaultTimeoutMs <= 0) throw new Error(`Invalid timeout for ${skill.name}`)
    if (new Set(skill.requiredResources).size !== skill.requiredResources.length) throw new Error(`Duplicate resource in ${skill.name}`)
    this.#skills.set(skill.name, skill as SkillDefinition<unknown, unknown>)
  }

  subscribe(listener: (event: ActionRuntimeEvent) => void): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }

  resources(): ReturnType<BodyResourceLocks['snapshot']> { return this.#locks.snapshot() }

  async submit(group: ActionGroupRequest): Promise<SubmitResult> {
    const preflight = await this.#preflight(group)
    if ('code' in preflight) {
      this.#emit({ type: 'group_rejected', rejection: preflight })
      return { accepted: false, rejection: preflight }
    }
    this.#emit({ type: 'group_accepted', groupId: group.id })
    return { accepted: true, groupId: group.id, completion: this.#executeGroup(group.id, preflight) }
  }

  cancel(actionId: string, reason: string, interrupted = false): boolean {
    const active = this.#active.get(actionId)
    if (!active) return false
    active.cancel = { status: interrupted ? 'interrupted' : 'cancelled', reason }
    if (active.prepared.skill.interruptibility === 'immediate') active.controller.abort(reason)
    return true
  }

  cancelAll(reason: string, interrupted = false): number {
    let count = 0
    for (const actionId of this.#active.keys()) if (this.cancel(actionId, reason, interrupted)) count++
    return count
  }

  async #preflight(group: ActionGroupRequest): Promise<Prepared[] | ActionGroupRejection> {
    const reject = (code: ActionGroupRejection['code'], detail: string, actionId?: string): ActionGroupRejection => ({ groupId: group.id, code, detail, ...(actionId ? { actionId } : {}) })
    if (group.mode !== 'atomic_preflight' || !group.id || group.actions.length === 0) return reject('invalid_args', 'Group must be non-empty atomic_preflight')
    const ids = new Set<string>()
    for (const action of group.actions) {
      if (!action.id || ids.has(action.id)) return reject('duplicate_action_id', `Duplicate action id ${action.id}`, action.id)
      ids.add(action.id)
    }
    for (const action of group.actions) for (const dependency of action.after) if (!ids.has(dependency)) return reject('missing_dependency', `Unknown dependency ${dependency}`, action.id)
    if (hasCycle(group.actions)) return reject('dependency_cycle', 'Action dependency graph contains a cycle')

    const prepared: Prepared[] = []
    for (const action of group.actions) {
      const skill = this.#skills.get(action.skill)
      if (!skill) return reject('unknown_skill', `Unknown skill ${action.skill}`, action.id)
      const parsed = skill.inputSchema.safeParse(action.args)
      if (!parsed.success) return reject('invalid_args', `Arguments rejected by ${skill.name}`, action.id)
      const condition = await skill.checkPreconditions?.(parsed.data)
      if (condition && !condition.ok) return reject('precondition_failed', condition.detail, action.id)
      const held = this.#locks.conflict(action.id, skill.requiredResources)
      if (held) return reject('resource_conflict', `${held.resource} is held by running action ${held.owner}`, action.id)
      prepared.push({ request: action, skill, args: parsed.data })
    }

    for (let left = 0; left < prepared.length; left++) for (let right = left + 1; right < prepared.length; right++) {
      const a = prepared[left]!, b = prepared[right]!
      if (dependsOn(a.request.id, b.request.id, group.actions) || dependsOn(b.request.id, a.request.id, group.actions)) continue
      const shared = a.skill.requiredResources.find(resource => b.skill.requiredResources.includes(resource))
      if (shared) return reject('resource_conflict', `${a.request.id} and ${b.request.id} both require ${shared}`)
    }
    return prepared
  }

  async #executeGroup(groupId: string, prepared: Prepared[]): Promise<readonly ActionResult[]> {
    const results = new Map<string, ActionResult>()
    const promises = new Map<string, Promise<ActionResult>>()
    const run = (item: Prepared): Promise<ActionResult> => {
      const promise = Promise.all(item.request.after.map(id => promises.get(id)!)).then(async dependencies => {
        const failed = dependencies.find(result => result.status !== 'completed')
        if (failed) return this.#notStarted(groupId, item, 'cancelled', 'dependency_failed', `Dependency ${failed.actionId} ended as ${failed.status}`)
        return this.#executeOne(groupId, item)
      })
      promises.set(item.request.id, promise)
      return promise
    }
    for (const item of topological(prepared)) run(item)
    for (const [id, promise] of promises) results.set(id, await promise)
    return prepared.map(item => results.get(item.request.id)!)
  }

  async #executeOne(groupId: string, prepared: Prepared): Promise<ActionResult> {
    const started = Date.now(), startedAt = new Date(started).toISOString()
    const controller = new AbortController(), sideEffects: ActionSideEffect[] = []
    const active: Active = { prepared, controller, sideEffects }
    this.#active.set(prepared.request.id, active)
    this.#locks.acquire(prepared.request.id, prepared.skill.requiredResources)
    this.#emit({ type: 'action_started', groupId, actionId: prepared.request.id, resources: prepared.skill.requiredResources })
    const context: SkillContext = {
      actionId: prepared.request.id, signal: controller.signal,
      recordSideEffect: effect => sideEffects.push({ ...effect, at: new Date().toISOString() }),
      checkpoint: () => { if (active.cancel) throw abortError(active.cancel.reason) },
    }
    let timeout = false
    const timer = setTimeout(() => { timeout = true; controller.abort('timeout') }, prepared.skill.defaultTimeoutMs)
    let result: ActionResult
    try {
      const raw = await prepared.skill.execute(context, prepared.args, controller.signal)
      if (active.cancel) result = this.#result(groupId, prepared, active.cancel.status, started, startedAt, sideEffects, undefined, { code: active.cancel.reason, detail: active.cancel.reason })
      else {
        const verification = await prepared.skill.verify(context, prepared.args, raw)
        result = verification.verified
          ? this.#result(groupId, prepared, 'completed', started, startedAt, sideEffects, verification)
          : this.#result(groupId, prepared, 'failed', started, startedAt, sideEffects, verification, { code: 'verification_failed', detail: verification.detail })
      }
    } catch (error) {
      const status = timeout ? 'timed_out' : active.cancel?.status ?? 'failed'
      const detail = error instanceof Error ? error.message : String(error)
      result = this.#result(groupId, prepared, status, started, startedAt, sideEffects, undefined, { code: timeout ? 'timeout' : active.cancel?.reason ?? 'execution_failed', detail })
    } finally {
      clearTimeout(timer)
      if (controller.signal.aborted || active.cancel) {
        try { await prepared.skill.cleanup?.(context, prepared.args, String(controller.signal.reason ?? active.cancel?.reason ?? 'cancelled')) } catch (error) {
          sideEffects.push({ type: 'cleanup_failed', detail: error instanceof Error ? error.message : String(error), at: new Date().toISOString() })
        }
      }
      this.#locks.release(prepared.request.id)
      this.#active.delete(prepared.request.id)
    }
    result.sideEffects = [...sideEffects]
    this.#emit({ type: 'action_terminal', result })
    return result
  }

  #notStarted(groupId: string, item: Prepared, status: 'cancelled', code: string, detail: string): ActionResult {
    const result: ActionResult = { groupId, actionId: item.request.id, skill: item.skill.name, status, endedAt: new Date().toISOString(), durationMs: 0, failure: { code, detail }, sideEffects: [] }
    this.#emit({ type: 'action_terminal', result }); return result
  }
  #result(groupId: string, item: Prepared, status: ActionResult['status'], started: number, startedAt: string, sideEffects: ActionSideEffect[], verification?: ActionResult['verification'], failure?: ActionResult['failure']): ActionResult {
    return { groupId, actionId: item.request.id, skill: item.skill.name, status, startedAt, endedAt: new Date().toISOString(), durationMs: Date.now() - started, ...(verification ? { verification } : {}), ...(failure ? { failure } : {}), sideEffects: [...sideEffects] }
  }
  #emit(event: ActionRuntimeEvent): void { for (const listener of [...this.#listeners]) { try { listener(event) } catch { /* subscriber isolation */ } } }
}

function abortError(reason: string): DOMException { return new DOMException(reason, 'AbortError') }
function hasCycle(actions: readonly ActionRequest[]): boolean {
  const visiting = new Set<string>(), done = new Set<string>(), map = new Map(actions.map(action => [action.id, action]))
  const visit = (id: string): boolean => { if (visiting.has(id)) return true; if (done.has(id)) return false; visiting.add(id); for (const next of map.get(id)?.after ?? []) if (visit(next)) return true; visiting.delete(id); done.add(id); return false }
  return actions.some(action => visit(action.id))
}
function dependsOn(action: string, target: string, actions: readonly ActionRequest[]): boolean {
  const map = new Map(actions.map(item => [item.id, item.after])); const seen = new Set<string>()
  const visit = (id: string): boolean => { if (seen.has(id)) return false; seen.add(id); return (map.get(id) ?? []).some(next => next === target || visit(next)) }
  return visit(action)
}
function topological(prepared: Prepared[]): Prepared[] {
  const result: Prepared[] = [], remaining = new Map(prepared.map(item => [item.request.id, item]))
  while (remaining.size) for (const [id, item] of remaining) if (item.request.after.every(dep => result.some(done => done.request.id === dep))) { result.push(item); remaining.delete(id) }
  return result
}
