import { randomUUID } from 'node:crypto'
import { ActionRuntime, type ActionResult } from '../actions/index.js'
import type { JsonlEventJournal } from '../events/index.js'
import type { FileMemoryStore, MemoryKind } from '../memory/index.js'
import type { BackendEventEnvelope, MinecraftBackendApi, ProtocolChatEvent, Vec3Value } from '../minecraft/contracts.js'
import type { CompanionDecision, DecisionContext, ModelProvider } from '../models/index.js'
import { interpretPlayerChat, SpeechScheduler } from '../speech/index.js'
import { registerPrototypeSkills } from '../skills/index.js'
import type { DebugContextSource } from '../telemetry/contracts.js'
import type { DebugStateStore } from '../telemetry/debug-state.js'
import type { CompanionProfile } from './profile.js'

export interface CompanionActivity {
  id: string
  kind: 'wood_collection'
  status: 'active' | 'paused' | 'completing' | 'completed' | 'abandoned'
  summary: string
  anchor: Vec3Value
  startedAt: string
}

export interface CompanionRuntimeOptions {
  backend: MinecraftBackendApi
  model: ModelProvider
  memory: FileMemoryStore
  journal: JsonlEventJournal
  profile: CompanionProfile
  debug: DebugStateStore
  primaryPlayer: string
  speechIntervalMs?: number
}

interface DeferredMemory {
  kind: MemoryKind
  summary: string
  triggerEventId: string
}

export class CompanionRuntime {
  readonly #backend: MinecraftBackendApi
  readonly #model: ModelProvider
  readonly #memory: FileMemoryStore
  readonly #journal: JsonlEventJournal
  readonly #profile: CompanionProfile
  readonly #debug: DebugStateStore
  readonly #primaryPlayer: string
  readonly #actions = new ActionRuntime()
  readonly #speech: SpeechScheduler
  readonly #abort = new AbortController()
  readonly #recentEvents: Array<{ id: string; type: string; summary: string }> = []
  readonly #deferredMemories = new Map<string, DeferredMemory>()
  #activity?: CompanionActivity
  #attention?: { kind: string; target?: string }
  #intent?: { kind: string; summary: string }
  #unsubscribe?: () => void
  #modelAbort?: AbortController
  #decisionTail = Promise.resolve()
  #activeCompletions = new Set<Promise<readonly ActionResult[]>>()
  #started = false
  #lastDangerAt = 0

  constructor(options: CompanionRuntimeOptions) {
    this.#backend = options.backend
    this.#model = options.model
    this.#memory = options.memory
    this.#journal = options.journal
    this.#profile = options.profile
    this.#debug = options.debug
    this.#primaryPlayer = options.primaryPlayer
    this.#speech = new SpeechScheduler({ send: message => this.#backend.sendChat(message) }, {
      minimumIntervalMs: options.speechIntervalMs ?? 1_000,
      onEvent: event => { void this.#journal.append(`speech.${event.type}`, withoutPrivateSpeech(event)) },
    })
    registerPrototypeSkills(this.#actions, this.#backend, this.#primaryPlayer, () => this.#activity)
    this.#actions.subscribe(event => {
      if (event.type === 'action_started') {
        this.#debug.update({
          currentAction: { id: event.actionId, skill: 'starting', purpose: this.#intent?.summary ?? '执行当前意图', startedAt: new Date().toISOString() },
          resourceLocks: this.#actions.resources(),
        })
      } else if (event.type === 'action_terminal') {
        this.#debug.update({ currentAction: undefined, resourceLocks: this.#actions.resources() })
        if (event.result.status !== 'completed') this.#debug.failure({
          at: event.result.endedAt, source: 'action', code: event.result.failure?.code ?? event.result.status,
          summary: event.result.failure?.detail ?? `${event.result.skill} ${event.result.status}`,
        })
      }
    })
  }

  activity(): Readonly<CompanionActivity> | undefined { return this.#activity ? structuredClone(this.#activity) : undefined }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#memory.load()
    this.#unsubscribe = this.#backend.subscribe(event => { void this.#handleBackendEvent(event) })
    await this.#backend.start(this.#abort.signal)
    this.#refreshDebug()
    const event = await this.#rememberRecent('companion.started', '同伴加入世界')
    this.#enqueueDecision({ type: 'startup', eventId: event.id })
  }

  async stop(reason = 'runtime_stopped'): Promise<void> {
    if (!this.#started) return
    this.#started = false
    this.#modelAbort?.abort(reason)
    this.#actions.cancelAll(reason, true)
    try { this.#backend.controls().stop() } catch { /* backend may already be disconnected */ }
    await Promise.allSettled([...this.#activeCompletions])
    this.#speech.stop(reason)
    this.#unsubscribe?.()
    await this.#backend.stop(reason)
    await this.#journal.append('companion.stopped', { reason })
    await this.#journal.flush()
    this.#debug.update({ connection: this.#backend.state(), currentAction: undefined, resourceLocks: this.#actions.resources() })
  }

  async idle(): Promise<void> {
    await this.#decisionTail
    await Promise.allSettled([...this.#activeCompletions])
    await this.#decisionTail
  }

  async #handleBackendEvent(event: BackendEventEnvelope): Promise<void> {
    this.#refreshDebug()
    if (event.kind === 'chat') await this.#handleChat(event as BackendEventEnvelope<ProtocolChatEvent>)
    if (event.kind === 'self' || event.kind === 'snapshot_changed' || event.kind === 'entity') void this.#considerDanger()
  }

  async #handleChat(event: BackendEventEnvelope<ProtocolChatEvent>): Promise<void> {
    let snapshot
    try { snapshot = this.#backend.snapshot() } catch { return }
    const message = interpretPlayerChat(event, {
      companionUsername: snapshot.self.username,
      primaryPlayerUsernames: [this.#primaryPlayer],
      onlinePlayerUsernames: snapshot.trackedPlayers.filter(player => player.listed).map(player => player.username),
      conversationActiveWith: this.#primaryPlayer,
    })
    if (!message?.addressing.addressedToCompanion || !message.sender.isPrimaryPlayer) return
    const journalEvent = await this.#journal.append('player.chat.received', {
      sourceEventId: message.sourceEventId, sender: message.sender.username, text: message.text,
      controlIntent: message.controlIntent,
    })
    this.#pushRecent(journalEvent.id, journalEvent.type, `${message.sender.username}: ${message.text}`)
    if (message.controlIntent === 'safety_stop') {
      this.#modelAbort?.abort('player_safety_stop')
      this.#actions.cancelAll('player_safety_stop', true)
      try { this.#backend.controls().stop() } catch { /* lifecycle race */ }
      if (this.#activity) this.#activity = { ...this.#activity, status: 'paused' }
      this.#intent = { kind: 'wait', summary: '遵从玩家明确停止，等待下一步交流' }
      this.#refreshDebug()
      this.#speech.schedule({ id: randomUUID(), text: '好，我停下。', timing: 'now', purpose: 'acknowledge', urgency: 'urgent' })
      await this.#journal.append('companion.safety_stop.applied', { sourceEventId: journalEvent.id })
      return
    }
    this.#enqueueDecision({ type: 'player_chat', text: message.text, eventId: journalEvent.id })
  }

  #enqueueDecision(trigger: DecisionContext['trigger']): void {
    this.#modelAbort?.abort('superseded_by_new_trigger')
    const controller = new AbortController()
    this.#modelAbort = controller
    const run = async () => {
      if (controller.signal.aborted || !this.#started) return
      await this.#runDecision(trigger, controller)
    }
    this.#decisionTail = this.#decisionTail.then(run, run).catch(error => this.#recordFailure('model', 'decision_failed', error))
  }

  async #runDecision(trigger: DecisionContext['trigger'], controller: AbortController): Promise<void> {
    const runId = randomUUID()
    const snapshot = this.#backend.snapshot()
    const query = [trigger.text, this.#activity?.summary, '上次 共同 经历 地点'].filter(Boolean).join(' ')
    const memories = (await this.#memory.search(snapshot.world.worldId, query, 5)).map(result => result.record)
    const sources: DebugContextSource[] = [
      { id: this.#profile.versionId, kind: 'profile', size: this.#profile.content.length },
      { id: trigger.eventId, kind: trigger.type === 'player_chat' ? 'player' : 'event', size: trigger.text?.length ?? 0 },
      { id: `snapshot:${snapshot.snapshotRevision}`, kind: 'runtime', size: JSON.stringify(snapshot).length },
      ...memories.map(memory => ({ id: memory.id, kind: 'memory' as const, size: memory.summary.length })),
      { id: 'prototype-skills-v1', kind: 'skill_registry', size: 5 },
    ]
    this.#debug.update({ decision: { status: 'running', runId, startedAt: new Date().toISOString(), contextSources: sources, retrievedMemoryIds: memories.map(memory => memory.id) } })
    const context: DecisionContext = {
      runId, trigger, primaryPlayer: this.#primaryPlayer, profile: this.#profile, snapshot,
      activity: this.#activity ? structuredClone(this.#activity) : undefined,
      recentEvents: structuredClone(this.#recentEvents), memories,
      availableSkills: ['follow_player', 'collect_wood', 'return_to_anchor', 'wait'],
    }
    const started = Date.now()
    try {
      const result = await this.#model.run(context, controller.signal)
      if (controller.signal.aborted || this.#modelAbort !== controller) return
      await this.#journal.append('model.decision.completed', {
        runId, model: result.model, durationMs: Date.now() - started, usage: result.usage,
        effects: { speech: Boolean(result.decision.speech), action: result.decision.action?.skill, activity: result.decision.activity.operation, memory: Boolean(result.decision.memory) },
      })
      this.#debug.update({ decision: { status: 'idle', model: result.model, contextSources: sources, retrievedMemoryIds: memories.map(memory => memory.id) } })
      await this.#applyDecision(result.decision, trigger)
    } catch (error) {
      if (controller.signal.aborted) return
      this.#debug.update({ decision: { status: 'failed', runId, contextSources: sources, retrievedMemoryIds: memories.map(memory => memory.id) } })
      this.#recordFailure('model', 'decision_failed', error)
    }
  }

  async #applyDecision(decision: CompanionDecision, trigger: DecisionContext['trigger']): Promise<void> {
    this.#attention = { kind: decision.attention.kind, ...(decision.attention.target ? { target: decision.attention.target } : {}) }
    this.#intent = decision.intent
    this.#applyActivity(decision)
    this.#refreshDebug()

    if (!decision.action) {
      if (decision.speech) this.#speech.schedule({ id: randomUUID(), text: decision.speech, timing: 'now', purpose: 'reply' })
      if (decision.memory) await this.#writeMemory(decision.memory.kind, decision.memory.summary, [{ kind: 'event', id: trigger.eventId }])
      if (decision.activity.operation === 'complete') await this.#completeActivity([{ kind: 'event', id: trigger.eventId }])
      return
    }

    if (this.#activeCompletions.size) {
      this.#actions.cancelAll('superseded_by_new_decision', true)
      try { this.#backend.controls().stop() } catch { /* lifecycle race */ }
      await Promise.allSettled([...this.#activeCompletions])
    }
    const actionId = randomUUID(), groupId = randomUUID()
    const submitted = await this.#actions.submit({
      id: groupId, mode: 'atomic_preflight', actions: [{ id: actionId, skill: decision.action.skill, args: decision.action.args,
        purpose: decision.action.purpose, after: [], onDependencyFailure: 'cancel' }],
    })
    if (!submitted.accepted) {
      this.#recordFailure('action', submitted.rejection.code, submitted.rejection.detail)
      if (decision.speech) this.#speech.schedule({ id: randomUUID(), text: '我现在做不了这个，先停一下。', timing: 'now', purpose: 'report' })
      return
    }
    this.#debug.update({ currentAction: { id: actionId, skill: decision.action.skill, purpose: decision.action.purpose, startedAt: new Date().toISOString() }, resourceLocks: this.#actions.resources() })
    this.#speech.actionAccepted(actionId)
    if (decision.speech) this.#speech.schedule({ id: randomUUID(), text: decision.speech, timing: 'after_actions_accepted', purpose: 'coordinate', dependsOn: [actionId] })
    if (decision.memory) this.#deferredMemories.set(actionId, { kind: decision.memory.kind, summary: decision.memory.summary, triggerEventId: trigger.eventId })
    const completion = submitted.completion
    this.#activeCompletions.add(completion)
    void completion.then(results => this.#handleActionResults(results, trigger)).finally(() => this.#activeCompletions.delete(completion))
  }

  async #handleActionResults(results: readonly ActionResult[], trigger: DecisionContext['trigger']): Promise<void> {
    for (const result of results) {
      const event = await this.#journal.append('action.terminal', result)
      this.#pushRecent(event.id, event.type, `${result.skill}: ${result.status}${result.verification ? ` (${result.verification.detail})` : ''}`)
      const speechStatus = result.status === 'completed' ? 'completed' : result.status === 'cancelled' || result.status === 'interrupted' ? 'cancelled' : 'failed'
      this.#speech.actionTerminal(result.actionId, speechStatus)
      const candidate = this.#deferredMemories.get(result.actionId)
      this.#deferredMemories.delete(result.actionId)
      if (candidate && result.status === 'completed') await this.#writeMemory(candidate.kind, candidate.summary, [
        { kind: 'event', id: candidate.triggerEventId }, { kind: 'action_result', id: event.id },
      ])
      if (result.skill === 'return_to_anchor' && result.status === 'completed' && this.#activity?.status === 'completing') {
        await this.#completeActivity([{ kind: 'event', id: trigger.eventId }, { kind: 'action_result', id: event.id }])
      }
      if (['completed', 'failed', 'timed_out'].includes(result.status)) this.#enqueueDecision({ type: 'action_result', eventId: event.id })
    }
  }

  #applyActivity(decision: CompanionDecision): void {
    const operation = decision.activity.operation
    if (operation === 'start_wood_collection') {
      const current = this.#backend.snapshot().self.position
      this.#activity = { id: randomUUID(), kind: 'wood_collection', status: 'active', summary: decision.activity.summary, anchor: current, startedAt: new Date().toISOString() }
    } else if (this.#activity && operation === 'pause') this.#activity = { ...this.#activity, status: 'paused', summary: decision.activity.summary }
    else if (this.#activity && operation === 'resume') this.#activity = { ...this.#activity, status: 'active', summary: decision.activity.summary }
    else if (this.#activity && operation === 'complete') this.#activity = { ...this.#activity, status: 'completing', summary: decision.activity.summary }
    else if (this.#activity && operation === 'abandon') this.#activity = { ...this.#activity, status: 'abandoned', summary: decision.activity.summary }
    else if (this.#activity && operation === 'keep') this.#activity = { ...this.#activity, summary: decision.activity.summary }
  }

  async #completeActivity(evidence: Array<{ kind: 'event' | 'action_result'; id: string }>): Promise<void> {
    if (!this.#activity || this.#activity.status === 'completed') return
    this.#activity = { ...this.#activity, status: 'completed' }
    const summary = `与${this.#primaryPlayer}一起收集木材，并回到了活动开始地点。`
    await this.#writeMemory('episode', summary, evidence)
    this.#refreshDebug()
  }

  async #writeMemory(kind: MemoryKind, summary: string, evidence: Array<{ kind: 'event' | 'action_result'; id: string }>): Promise<void> {
    const worldId = this.#backend.snapshot().world.worldId
    const memory = await this.#memory.remember({ worldId, kind, summary, evidence })
    await this.#journal.append('memory.record.written', { memoryId: memory.id, kind: memory.kind, evidence: memory.evidence })
  }

  async #considerDanger(): Promise<void> {
    if (!this.#started || Date.now() - this.#lastDangerAt < 10_000) return
    let snapshot, threat
    try { snapshot = this.#backend.snapshot(); threat = this.#backend.controls().nearestThreat(4) } catch { return }
    if (snapshot.self.health > 8 && !threat) return
    this.#lastDangerAt = Date.now()
    this.#modelAbort?.abort('danger_reflex')
    this.#actions.cancelAll('danger_reflex', true)
    try { this.#backend.controls().stop() } catch { /* lifecycle race */ }
    await Promise.allSettled([...this.#activeCompletions])
    this.#speech.setPressure('danger')
    this.#speech.schedule({ id: randomUUID(), text: '有危险，我先退开！', timing: 'now', purpose: 'report', urgency: 'urgent' })
    const actionId = randomUUID()
    const submitted = await this.#actions.submit({ id: randomUUID(), mode: 'atomic_preflight', actions: [{
      id: actionId, skill: 'escape_threat', args: {}, purpose: '远离直接威胁', after: [], onDependencyFailure: 'cancel',
    }] })
    if (submitted.accepted) {
      this.#speech.actionAccepted(actionId)
      this.#activeCompletions.add(submitted.completion)
      void submitted.completion.then(results => this.#handleActionResults(results, { type: 'danger', eventId: randomUUID() }))
        .finally(() => { this.#activeCompletions.delete(submitted.completion); this.#speech.setPressure('normal') })
    } else this.#speech.setPressure('normal')
  }

  #refreshDebug(): void {
    let body
    try {
      const snapshot = this.#backend.snapshot()
      const inventory = new Map<string, number>()
      for (const slot of snapshot.inventory.slots) inventory.set(slot.itemName, (inventory.get(slot.itemName) ?? 0) + slot.count)
      body = { position: snapshot.self.position, health: snapshot.self.health, food: snapshot.self.food,
        inventory: [...inventory].map(([itemName, count]) => ({ itemName, count })) }
    } catch { /* connection is not ready */ }
    this.#debug.update({
      connection: this.#backend.state(), body,
      attention: this.#attention, activity: this.#activity,
      intent: this.#intent, resourceLocks: this.#actions.resources(),
    })
  }

  async #rememberRecent(type: string, summary: string): Promise<{ id: string }> {
    const event = await this.#journal.append(type, { summary })
    this.#pushRecent(event.id, type, summary)
    return event
  }

  #pushRecent(id: string, type: string, summary: string): void {
    this.#recentEvents.push({ id, type, summary })
    if (this.#recentEvents.length > 20) this.#recentEvents.shift()
  }

  #recordFailure(source: 'backend' | 'model' | 'action' | 'memory' | 'runtime', code: string, error: unknown): void {
    const summary = error instanceof Error ? error.message : String(error)
    this.#debug.failure({ at: new Date().toISOString(), source, code, summary })
    void this.#journal.append(`${source}.failed`, { code, summary })
  }
}

function withoutPrivateSpeech(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const copy = { ...(event as Record<string, unknown>) }
  if ('text' in copy) copy.text = '[REDACTED]'
  return copy
}
