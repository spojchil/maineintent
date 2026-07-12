import assert from 'node:assert/strict'
import test from 'node:test'
import { z } from 'zod'
import { ActionRuntime } from './action-runtime.js'
import type { ActionGroupRequest, BodyResource, Interruptibility, SkillDefinition } from './contracts.js'

function skill(options: {
  name: string; resources?: BodyResource[]; timeout?: number; interruptibility?: Interruptibility
  execute?: SkillDefinition<{ value?: string }, string>['execute']; verified?: boolean; cleanup?: () => void
}): SkillDefinition<{ value?: string }, string> {
  return {
    name: options.name, description: options.name, inputSchema: z.object({ value: z.string().optional() }).strict(),
    requiredResources: options.resources ?? [], preconditions: [], expectedEffects: ['tested'], defaultTimeoutMs: options.timeout ?? 100,
    interruptibility: options.interruptibility ?? 'immediate',
    execute: options.execute ?? (async () => 'ok'),
    verify: async () => ({ verified: options.verified ?? true, detail: options.verified === false ? 'not observed' : 'observed' }),
    cleanup: options.cleanup,
  }
}

function group(actions: ActionGroupRequest['actions']): ActionGroupRequest { return { id: 'group-1', mode: 'atomic_preflight', actions } }
function action(id: string, name: string, after: string[] = []) { return { id, skill: name, args: {}, purpose: 'test', after, onDependencyFailure: 'cancel' as const } }

test('atomic preflight rejects unknown skills, invalid args, cycles and concurrent resource conflicts', async () => {
  const runtime = new ActionRuntime()
  runtime.register(skill({ name: 'walk', resources: ['locomotion'] }))
  assert.equal((await runtime.submit(group([action('a', 'missing')]))).accepted, false)
  assert.equal((await runtime.submit(group([{ ...action('a', 'walk'), args: { extra: true } }]))).accepted, false)
  const cycle = await runtime.submit(group([action('a', 'walk', ['b']), action('b', 'walk', ['a'])]))
  assert.equal(cycle.accepted, false)
  if (!cycle.accepted) assert.equal(cycle.rejection.code, 'dependency_cycle')
  const conflict = await runtime.submit(group([action('a', 'walk'), action('b', 'walk')]))
  assert.equal(conflict.accepted, false)
  if (!conflict.accepted) assert.equal(conflict.rejection.code, 'resource_conflict')
})

test('explicit dependencies sequence actions and release all body resources', async () => {
  const order: string[] = []
  const runtime = new ActionRuntime()
  runtime.register(skill({ name: 'walk', resources: ['locomotion'], execute: async ctx => { order.push(ctx.actionId); return 'ok' } }))
  const submitted = await runtime.submit(group([action('second', 'walk', ['first']), action('first', 'walk')]))
  assert.equal(submitted.accepted, true)
  if (!submitted.accepted) return
  const results = await submitted.completion
  assert.deepEqual(order, ['first', 'second'])
  assert.deepEqual(results.map(result => result.status), ['completed', 'completed'])
  assert.equal(Object.values(runtime.resources()).every(owner => owner === undefined), true)
})

test('cancellation aborts execution, runs cleanup, retains side effects and cancels dependants', async () => {
  let cleaned = 0
  const runtime = new ActionRuntime()
  runtime.register(skill({
    name: 'dig', resources: ['hands'], cleanup: () => { cleaned++ },
    execute: async (ctx, _args, signal) => {
      ctx.recordSideEffect({ type: 'block_damaged', detail: 'stone cracked' })
      await new Promise<void>((resolve, reject) => { signal.addEventListener('abort', () => reject(new DOMException('cancelled', 'AbortError')), { once: true }) })
      return 'never'
    },
  }))
  const submitted = await runtime.submit(group([action('dig-1', 'dig'), action('after', 'dig', ['dig-1'])]))
  assert.equal(submitted.accepted, true)
  await wait(5)
  assert.equal(runtime.cancel('dig-1', 'player_changed_plan'), true)
  if (!submitted.accepted) return
  const results = await submitted.completion
  assert.equal(results[0]?.status, 'cancelled')
  assert.equal(results[0]?.sideEffects[0]?.type, 'block_damaged')
  assert.equal(results[1]?.failure?.code, 'dependency_failed')
  assert.equal(cleaned, 1)
  assert.equal(runtime.resources().hands, undefined)
})

test('a new group is rejected while another group holds the same body resource', async () => {
  const runtime = new ActionRuntime()
  runtime.register(skill({
    name: 'hold-gaze', resources: ['gaze'],
    execute: async (_ctx, _args, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('cancelled')), { once: true })),
  }))
  const first = await runtime.submit({ ...group([action('first', 'hold-gaze')]), id: 'first-group' })
  await wait(2)
  const second = await runtime.submit({ ...group([action('second', 'hold-gaze')]), id: 'second-group' })
  assert.equal(second.accepted, false)
  if (!second.accepted) assert.equal(second.rejection.code, 'resource_conflict')
  runtime.cancel('first', 'test_complete')
  if (first.accepted) await first.completion
})

test('timeout, failed verification and terminal-only interruption are distinct results', async () => {
  const runtime = new ActionRuntime()
  runtime.register(skill({ name: 'hang', timeout: 10, execute: async (_ctx, _args, signal) => new Promise((_, reject) => signal.addEventListener('abort', () => reject(new Error('stopped')), { once: true })) }))
  runtime.register(skill({ name: 'unverified', verified: false }))
  runtime.register(skill({ name: 'terminal', interruptibility: 'terminal_only', execute: async () => { await wait(15); return 'ok' } }))

  const timed = await runtime.submit(group([action('hang', 'hang')]))
  assert.equal(timed.accepted, true)
  if (timed.accepted) assert.equal((await timed.completion)[0]?.status, 'timed_out')
  const failed = await runtime.submit(group([action('verify', 'unverified')]))
  if (failed.accepted) assert.equal((await failed.completion)[0]?.failure?.code, 'verification_failed')
  const interrupted = await runtime.submit(group([action('terminal', 'terminal')]))
  await wait(2); runtime.cancel('terminal', 'safety_reflex', true)
  if (interrupted.accepted) assert.equal((await interrupted.completion)[0]?.status, 'interrupted')
})

function wait(ms: number): Promise<void> { return new Promise(resolve => setTimeout(resolve, ms)) }
