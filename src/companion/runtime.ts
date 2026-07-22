import { randomUUID } from 'node:crypto'
import { composeContextPackage, type ContextTrigger } from '../context/index.js'
import { BehaviorSynthesizer, type BehaviorPlanV1, type BehaviorSynthesisResult } from '../behavior/index.js'
import type { JsonlEventJournal, JournalEvent } from '../events/index.js'
import { GroundedReferentStore, GroundingEngine, type EmbodiedGroundingResult } from '../grounding/index.js'
import {
  composePassiveObservations,
  CurrentStatusProvider,
  InformationRegistry,
  InformationRuntime,
  InMemoryInformationAccessPolicy,
  InventoryProvider,
  SoundInformationProvider,
  ViewportInformationProvider,
  type PassiveObservations,
  type TrustedInformationCaller,
} from '../information/index.js'
import type { FileMemoryStore, MemoryKind } from '../memory/index.js'
import type { BackendEventEnvelope, MinecraftBackendApi, ProtocolChatEvent, Vec3Value } from '../minecraft/contracts.js'
import { VisualAttentionController, type VisualAttentionResult } from '../motor/index.js'
import {
  companionDecisionV2OutputSchema,
  DecisionProtocolDispatcher,
  type ActivityEffect,
  type ContextPackageV2,
  type DecisionEffectV2,
  type MemoryCandidateEffect,
  type ModelProvider,
} from '../models/index.js'
import { interpretPlayerChat, SpeechScheduler } from '../speech/index.js'
import type { DebugContextSource } from '../telemetry/contracts.js'
import type { DebugStateStore } from '../telemetry/debug-state.js'
import {
  BackendInformationScopeSource,
  BackendInventoryPort,
  BackendPerceptionPort,
  BackendSelfVitalsPort,
  SoundHistory,
} from './information-adapters.js'
import type { CompanionProfile } from './profile.js'

const INFORMATION_GRANT_ID = 'grant-context-composer'
const INFORMATION_PRINCIPAL_ID = 'context-composer'

export interface CompanionActivity {
  id: string
  revision: number
  status: 'proposed' | 'active' | 'paused' | 'completed' | 'abandoned'
  summary: string
  companionContribution?: string
  agreedFacts: string[]
  openQuestions: string[]
  startedAt: string
  /** Runtime-private evidence for future Grounding; never copied into model context. */
  anchor?: Vec3Value
}

interface CompanionIntent {
  id: string
  revision: number
  status: 'active'
  summary: string
  reason: string
  activityId?: string
  completionSignals: string[]
  invalidationSignals: string[]
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

export class CompanionRuntime {
  readonly #backend: MinecraftBackendApi
  readonly #model: ModelProvider
  readonly #memory: FileMemoryStore
  readonly #journal: JsonlEventJournal
  readonly #profile: CompanionProfile
  readonly #debug: DebugStateStore
  readonly #primaryPlayer: string
  readonly #speech: SpeechScheduler
  readonly #soundHistory: SoundHistory
  readonly #perception: BackendPerceptionPort
  readonly #informationRuntime: InformationRuntime
  readonly #groundedReferents = new GroundedReferentStore()
  readonly #grounding: GroundingEngine
  readonly #behavior: BehaviorSynthesizer
  readonly #dispatcher = new DecisionProtocolDispatcher()
  readonly #abort = new AbortController()
  readonly #recentEvents: Array<{ id: string; type: string; summary: string }> = []
  readonly #backgroundTasks = new Set<Promise<void>>()
  #activity?: CompanionActivity
  #attention?: { kind: string; target?: string }
  #intent?: CompanionIntent
  #unsubscribe?: () => void
  #modelAbort?: AbortController
  #activeBehavior?: { plan: BehaviorPlanV1; abort: AbortController; startedAt: string }
  #behaviorTask?: Promise<void>
  #decisionTail = Promise.resolve()
  #started = false
  #lastDangerAt = 0
  #companionRevision = 0
  #eventSequence = 0
  #sessionId = 'session-not-started'

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
      onEvent: event => { void this.#append(`speech.${event.type}`, withoutPrivateSpeech(event)) },
    })
    this.#soundHistory = new SoundHistory(this.#backend)
    this.#perception = new BackendPerceptionPort(this.#backend)
    this.#informationRuntime = buildInformationRuntime(this.#backend, this.#soundHistory, this.#perception)
    this.#grounding = new GroundingEngine({
      references: this.#informationRuntime,
      store: this.#groundedReferents,
      scope: () => this.#embodimentScope(),
    })
    this.#behavior = new BehaviorSynthesizer(this.#groundedReferents)
  }

  activity(): Readonly<CompanionActivity> | undefined {
    return this.#activity ? structuredClone(this.#activity) : undefined
  }

  async start(): Promise<void> {
    if (this.#started) return
    this.#started = true
    await this.#memory.load()
    this.#unsubscribe = this.#backend.subscribe(event => { void this.#handleBackendEvent(event) })
    const ready = await this.#backend.start(this.#abort.signal)
    this.#sessionId = ready.processSessionId
    await this.#waitForSelfChunk()
    this.#refreshDebug()
    const event = await this.#rememberRecent('companion.started', '同伴加入世界')
    this.#enqueueDecision({ type: 'startup', eventId: event.id })
  }

  async #waitForSelfChunk(attempts = 20, intervalMs = 100): Promise<void> {
    for (let attempt = 0; attempt < attempts; attempt++) {
      try {
        const position = this.#backend.snapshot().self.position
        const result = this.#backend.observationSource().readBlock({
          x: Math.floor(position.x), y: Math.floor(position.y) - 1, z: Math.floor(position.z),
        })
        if (result.status !== 'unloaded') return
      } catch { /* backend not yet ready for observation queries */ }
      await new Promise(resolve => setTimeout(resolve, intervalMs))
    }
  }

  async stop(reason = 'runtime_stopped'): Promise<void> {
    if (!this.#started) return
    this.#started = false
    this.#modelAbort?.abort(reason)
    this.#activeBehavior?.abort.abort(reason)
    try { this.#backend.motor().releaseAll() } catch { /* backend may already be disconnected */ }
    if (this.#behaviorTask) await this.#behaviorTask
    await Promise.allSettled([...this.#backgroundTasks])
    await this.#decisionTail
    this.#speech.stop(reason)
    this.#unsubscribe?.()
    this.#soundHistory.dispose()
    await this.#backend.stop(reason)
    await this.#append('companion.stopped', { reason })
    await this.#journal.flush()
    this.#debug.update({ connection: this.#backend.state(), currentBehavior: undefined, resourceLeases: {} })
  }

  async idle(): Promise<void> {
    await this.#decisionTail
    if (this.#behaviorTask) await this.#behaviorTask
    await Promise.allSettled([...this.#backgroundTasks])
    await this.#decisionTail
  }

  async #handleBackendEvent(event: BackendEventEnvelope): Promise<void> {
    this.#refreshDebug()
    if (event.kind === 'chat') await this.#handleChat(event as BackendEventEnvelope<ProtocolChatEvent>)
    if (event.kind === 'self' || event.kind === 'snapshot_changed') void this.#considerDanger()
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
    const journalEvent = await this.#append('player.chat.received', {
      sourceEventId: message.sourceEventId,
      sender: message.sender.username,
      text: message.text,
      controlIntent: message.controlIntent,
    })
    this.#pushRecent(journalEvent.id, journalEvent.type, `${message.sender.username}: ${message.text}`)
    if (message.controlIntent === 'safety_stop') {
      this.#modelAbort?.abort('player_safety_stop')
      this.#activeBehavior?.abort.abort('player_safety_stop')
      try { this.#backend.motor().releaseAll() } catch { /* lifecycle race */ }
      if (this.#activity?.status === 'active') {
        this.#activity = { ...this.#activity, status: 'paused', revision: this.#activity.revision + 1 }
      }
      this.#intent = undefined
      this.#bumpCompanionRevision()
      this.#refreshDebug()
      this.#speech.schedule({ id: randomUUID(), text: '好，我停下。', timing: 'now', purpose: 'acknowledge', urgency: 'urgent' })
      await this.#append('companion.safety_stop.applied', { sourceEventId: journalEvent.id })
      return
    }
    this.#enqueueDecision({ type: 'player_chat', text: message.text, eventId: journalEvent.id })
  }

  #enqueueDecision(trigger: ContextTrigger): void {
    this.#modelAbort?.abort('superseded_by_new_trigger')
    const controller = new AbortController()
    this.#modelAbort = controller
    const run = async () => {
      if (controller.signal.aborted || !this.#started) return
      await this.#runDecision(trigger, controller)
    }
    this.#decisionTail = this.#decisionTail.then(run, run).catch(error => this.#recordFailure('model', 'decision_failed', error))
  }

  async #runDecision(trigger: ContextTrigger, controller: AbortController): Promise<void> {
    const runId = `run_${randomUUID()}`
    const snapshot = this.#backend.snapshot()
    const query = [trigger.text, this.#activity?.summary, '上次 共同 经历 地点'].filter(Boolean).join(' ')
    const memories = (await this.#memory.search(snapshot.world.worldId, query, 5)).map(result => result.record)
    const observations = await this.#composePassiveObservations(runId, controller.signal)
    const context = composeContextPackage({
      runId,
      companionId: this.#profile.profileId,
      sessionId: this.#sessionId,
      worldId: snapshot.world.worldId,
      companionRevision: this.#companionRevision,
      throughEventSequence: this.#eventSequence,
      profile: this.#profile,
      trigger,
      route: 'new',
      primaryPlayer: this.#primaryPlayer,
      currentState: this.#modelCurrentState(),
      recentEvents: structuredClone(this.#recentEvents),
      memories,
      observations,
    })
    const sources = debugSources(context)
    this.#debug.update({
      observations,
      decision: {
        status: 'running', runId, startedAt: new Date().toISOString(), contextSources: sources,
        retrievedMemoryIds: memories.map(memory => memory.id),
      },
    })
    await this.#append('model.decision.started', { runId, context: context.ref })
    const started = Date.now()
    try {
      const result = await this.#model.runDecision({
        context,
        outputSchema: companionDecisionV2OutputSchema,
        signal: controller.signal,
      })
      if (controller.signal.aborted || this.#modelAbort !== controller) return
      if (!this.#contextStillCurrent(context)) {
        await this.#append('model.decision.discarded_as_stale', { runId, expected: context.ref, actualRevision: this.#companionRevision })
        return
      }
      const decision = this.#dispatcher.parse(result.rawOutput, context)
      const proposal = this.#dispatcher.normalize(decision, context)
      await this.#append('model.decision.finished', {
        runId,
        model: result.model,
        durationMs: Date.now() - started,
        usage: result.usage,
        effectKinds: proposal.effects.map(effect => effect.kind),
      })
      this.#debug.update({
        decision: { status: 'idle', model: result.model, contextSources: sources, retrievedMemoryIds: memories.map(memory => memory.id) },
      })
      await this.#applyProposal(proposal.effects, context, controller.signal)
    } catch (error) {
      if (controller.signal.aborted) return
      this.#debug.update({ decision: { status: 'failed', runId, contextSources: sources, retrievedMemoryIds: memories.map(memory => memory.id) } })
      this.#recordFailure('model', 'decision_failed', error)
    }
  }

  async #applyProposal(
    effects: readonly DecisionEffectV2[],
    context: ContextPackageV2,
    signal: AbortSignal,
  ): Promise<void> {
    if (signal.aborted) return
    const effectResults: Array<{ effectId: string; status: string; code?: string }> = []
    const embodied = effects.find(effect => effect.kind === 'embodied_intent')
    let acceptedPlan: BehaviorPlanV1 | undefined

    for (const effect of effects) {
      if (effect.kind === 'activity') {
        const accepted = this.#applyActivity(effect)
        effectResults.push({ effectId: effect.id, status: accepted ? 'accepted' : 'rejected', ...(!accepted ? { code: 'activity_precondition_failed' } : {}) })
      } else if (effect.kind === 'intent') {
        const accepted = this.#applyIntent(effect)
        effectResults.push({ effectId: effect.id, status: accepted ? 'accepted' : 'rejected', ...(!accepted ? { code: 'intent_precondition_failed' } : {}) })
      } else if (effect.kind === 'next_attention') {
        this.#attention = { kind: effect.waitFor.join('|'), target: effect.focus }
        this.#bumpCompanionRevision()
        effectResults.push({ effectId: effect.id, status: 'accepted' })
      }
    }

    if (embodied) {
      const prepared = await this.#prepareEmbodiedIntent(embodied, context, signal)
      if (signal.aborted) return
      if (prepared.status === 'accepted') {
        acceptedPlan = prepared.plan
        effectResults.push({ effectId: embodied.id, status: 'accepted' })
      } else effectResults.push({ effectId: embodied.id, status: 'rejected', code: prepared.code })
    }

    for (const effect of effects) {
      if (effect.kind === 'speech') {
        if (effect.timing === 'now') {
          this.#speech.schedule({ id: effect.id, text: effect.text, timing: 'now', purpose: effect.purpose })
          effectResults.push({ effectId: effect.id, status: 'accepted' })
        } else if (acceptedPlan && embodied) {
          this.#speech.schedule({
            id: effect.id,
            text: effect.text,
            timing: effect.timing === 'after_intent_accepted' ? 'after_actions_accepted' : 'after_action_terminal',
            purpose: effect.purpose,
            dependsOn: effect.dependsOn,
            ...(effect.terminalCondition ? { terminalCondition: effect.terminalCondition } : {}),
          })
          effectResults.push({ effectId: effect.id, status: 'accepted' })
        } else {
          effectResults.push({ effectId: effect.id, status: 'rejected', code: embodied ? 'embodied_dependency_rejected' : 'missing_embodied_dependency' })
        }
      } else if (effect.kind === 'memory_candidate') {
        const accepted = await this.#considerMemoryCandidate(effect)
        effectResults.push({ effectId: effect.id, status: accepted ? 'accepted' : 'rejected', ...(!accepted ? { code: 'memory_candidate_rejected' } : {}) })
      }
    }
    this.#refreshDebug()
    await this.#append('model.decision.applied', {
      runId: context.ref.runId,
      status: effectResults.some(item => item.status === 'rejected') ? 'partially_applied' : 'applied',
      effects: effectResults,
    })
    if (acceptedPlan && embodied && !signal.aborted) {
      this.#speech.actionAccepted(embodied.id)
      this.#launchBehavior(acceptedPlan)
    } else if (acceptedPlan && signal.aborted) {
      for (const effect of effects) if (effect.kind === 'speech' && effect.timing !== 'now') {
        this.#speech.cancel(effect.id, 'decision_cancelled_before_behavior_start')
      }
    }
  }

  async #prepareEmbodiedIntent(
    effect: Extract<DecisionEffectV2, { kind: 'embodied_intent' }>,
    context: ContextPackageV2,
    signal: AbortSignal,
  ): Promise<{ status: 'accepted'; plan: BehaviorPlanV1 } | { status: 'rejected'; code: string }> {
    if (signal.aborted) return { status: 'rejected', code: 'decision_cancelled' }
    const caller = {
      principalId: INFORMATION_PRINCIPAL_ID,
      grantId: INFORMATION_GRANT_ID,
      purpose: 'companion_context' as const,
      correlationId: context.ref.runId,
      decisionRunId: context.ref.runId,
    } satisfies TrustedInformationCaller
    const grounding = this.#grounding.ground({ effect, context, caller })
    await this.#recordGrounding(context.ref.runId, grounding)
    if (signal.aborted) return { status: 'rejected', code: 'decision_cancelled' }
    if (grounding.status !== 'grounded') {
      const code = `grounding_${grounding.status}_${grounding.reasonCode}`
      await this.#append('embodiment.plan.rejected', { runId: context.ref.runId, effectId: effect.id, reasonCode: code })
      return { status: 'rejected', code }
    }
    const synthesis = this.#behavior.synthesize({ intent: grounding.intent, scope: this.#embodimentScope() })
    await this.#recordSynthesis(context.ref.runId, synthesis)
    if (signal.aborted) return { status: 'rejected', code: 'decision_cancelled' }
    if (synthesis.status !== 'ready') {
      const code = `behavior_${synthesis.status}_${synthesis.reasonCode}`
      await this.#append('embodiment.plan.rejected', { runId: context.ref.runId, effectId: effect.id, reasonCode: code })
      return { status: 'rejected', code }
    }

    if (this.#activeBehavior) {
      if (this.#activeBehavior.plan.interruptibility !== 'immediate') {
        return { status: 'rejected', code: 'behavior_resource_busy' }
      }
      this.#activeBehavior.abort.abort('superseded_by_new_behavior')
      if (this.#behaviorTask) await this.#behaviorTask
      if (signal.aborted) return { status: 'rejected', code: 'decision_cancelled' }
    }
    if (Date.parse(synthesis.plan.validUntil) <= Date.now()) {
      return { status: 'rejected', code: 'behavior_plan_expired_before_acceptance' }
    }
    return { status: 'accepted', plan: synthesis.plan }
  }

  async #recordGrounding(runId: string, result: EmbodiedGroundingResult): Promise<void> {
    await this.#append('embodiment.grounding.finished', result.status === 'grounded'
      ? {
          runId,
          effectId: result.intent.effectId,
          status: result.status,
          groundingStatus: result.intent.groundingStatus,
          referentCount: result.intent.referents.length,
          missingProperties: result.intent.missingInformation.map(item => item.property),
          evidenceIds: result.intent.referents.flatMap(item => item.evidenceIds),
        }
      : { runId, effectId: result.effectId, status: result.status, reasonCode: result.reasonCode })
  }

  async #recordSynthesis(runId: string, result: BehaviorSynthesisResult): Promise<void> {
    await this.#append('embodiment.behavior.synthesized', result.status === 'ready'
      ? {
          runId,
          effectId: result.plan.effectId,
          status: result.status,
          planId: result.plan.id,
          planProtocol: result.plan.protocol,
          stepKinds: result.plan.steps.map(step => step.kind),
          modes: result.plan.steps.map(step => step.mode),
          stateIds: result.plan.steps.map(step => step.stateId),
          resourceClaims: result.plan.resourceClaims,
          validUntil: result.plan.validUntil,
        }
      : { runId, effectId: result.effectId, status: result.status, reasonCode: result.reasonCode })
  }

  #launchBehavior(plan: BehaviorPlanV1): void {
    const active = { plan, abort: new AbortController(), startedAt: new Date().toISOString() }
    this.#activeBehavior = active
    this.#bumpCompanionRevision()
    this.#refreshDebug()
    const task = this.#runBehavior(active).catch(error => {
      this.#recordFailure('controller', 'behavior_execution_failed', error)
      if (this.#activeBehavior?.plan.id === plan.id) {
        this.#activeBehavior = undefined
        this.#bumpCompanionRevision()
        this.#refreshDebug()
      }
      this.#speech.actionTerminal(plan.effectId, 'failed')
    })
    this.#behaviorTask = task
    this.#backgroundTasks.add(task)
    void task.finally(() => this.#backgroundTasks.delete(task))
  }

  async #runBehavior(active: { plan: BehaviorPlanV1; abort: AbortController; startedAt: string }): Promise<void> {
    const { plan } = active
    await this.#append('embodiment.controller.started', {
      runId: plan.decisionRunId,
      effectId: plan.effectId,
      planId: plan.id,
      controller: 'visual_attention',
      stepKind: plan.steps[0].kind,
      mode: plan.steps[0].mode,
      stateId: plan.steps[0].stateId,
      resourceClaims: plan.resourceClaims,
    })
    let result: VisualAttentionResult
    try {
      const controller = new VisualAttentionController({
        targets: this.#groundedReferents,
        perception: this.#perception,
        motor: this.#backend.motor(),
        scope: () => {
          const value = this.#embodimentScope()
          return { worldId: value.worldId, epoch: value.epoch }
        },
      })
      result = await controller.execute({ plan, signal: active.abort.signal })
    } catch (error) {
      this.#recordFailure('controller', 'controller_unavailable', error)
      result = {
        planId: plan.id,
        decisionRunId: plan.decisionRunId,
        effectId: plan.effectId,
        status: active.abort.signal.aborted ? 'cancelled' : 'failed',
        reasonCode: active.abort.signal.aborted ? 'controller_cancelled' : 'controller_unavailable',
        evidence: [],
        metrics: { lookSamples: 0, scanStops: 0 },
      }
    }
    for (const item of result.evidence) {
      await this.#append('embodiment.controller.evidence', {
        runId: plan.decisionRunId,
        effectId: plan.effectId,
        planId: plan.id,
        stage: item.stage,
        evidenceIds: item.evidenceIds,
        observedAt: item.at,
      })
    }
    const terminal = await this.#append('embodiment.controller.terminal', {
      runId: plan.decisionRunId,
      effectId: plan.effectId,
      planId: plan.id,
      status: result.status,
      reasonCode: result.reasonCode,
      metrics: result.metrics,
      evidenceIds: result.evidence.flatMap(item => item.evidenceIds),
      ...(result.observedTarget ? { observedTarget: result.observedTarget } : {}),
    })
    this.#speech.actionTerminal(plan.effectId, result.status)
    if (this.#activeBehavior?.plan.id === plan.id) {
      this.#activeBehavior = undefined
      this.#bumpCompanionRevision()
      this.#refreshDebug()
    }
    const summary = controllerSummary(result)
    this.#pushRecent(terminal.id, terminal.type, summary)
    const reason = active.abort.signal.reason
    const suppressDecision = reason === 'player_safety_stop' || reason === 'danger_reflex' ||
      reason === 'superseded_by_new_behavior' || reason === 'runtime_stopped'
    if (this.#started && !suppressDecision) this.#enqueueDecision({ type: 'action_result', eventId: terminal.id })
  }

  #applyActivity(effect: ActivityEffect): boolean {
    if (effect.operation === 'propose') {
      if (!effect.summary) return false
      this.#activity = {
        id: `activity_${randomUUID()}`,
        revision: 0,
        status: 'proposed',
        summary: effect.summary,
        ...(effect.companionContribution ? { companionContribution: effect.companionContribution } : {}),
        agreedFacts: [...(effect.agreedFacts ?? [])],
        openQuestions: [...(effect.openQuestions ?? [])],
        startedAt: new Date().toISOString(),
        anchor: this.#backend.snapshot().self.position,
      }
      this.#bumpCompanionRevision()
      return true
    }
    if (!this.#activity || effect.activityId !== this.#activity.id || effect.expectedRevision !== this.#activity.revision) return false
    if (effect.operation === 'activate' && this.#activity.status !== 'proposed' && this.#activity.status !== 'paused') return false
    if (effect.operation === 'update' && !effect.summary) return false
    const status = effect.operation === 'activate' ? 'active'
      : effect.operation === 'pause' ? 'paused'
        : effect.operation === 'complete' ? 'completed'
          : effect.operation === 'abandon' ? 'abandoned'
            : this.#activity.status
    this.#activity = {
      ...this.#activity,
      revision: this.#activity.revision + 1,
      status,
      ...(effect.summary ? { summary: effect.summary } : {}),
      ...(effect.companionContribution ? { companionContribution: effect.companionContribution } : {}),
      ...(effect.agreedFacts ? { agreedFacts: [...effect.agreedFacts] } : {}),
      ...(effect.openQuestions ? { openQuestions: [...effect.openQuestions] } : {}),
    }
    this.#bumpCompanionRevision()
    return true
  }

  #applyIntent(effect: Extract<DecisionEffectV2, { kind: 'intent' }>): boolean {
    if (effect.operation === 'set') {
      if (!effect.summary) return false
      this.#intent = {
        id: `intent_${randomUUID()}`,
        revision: 0,
        status: 'active',
        summary: effect.summary,
        reason: effect.reason,
        ...(effect.activityId ? { activityId: effect.activityId } : {}),
        completionSignals: [...(effect.completionSignals ?? [])],
        invalidationSignals: [...(effect.invalidationSignals ?? [])],
      }
      this.#bumpCompanionRevision()
      return true
    }
    if (!this.#intent || effect.intentId !== this.#intent.id || effect.expectedRevision !== this.#intent.revision) return false
    if (effect.operation === 'clear') this.#intent = undefined
    else {
      this.#intent = {
        ...this.#intent,
        revision: this.#intent.revision + 1,
        summary: effect.summary!,
        reason: effect.reason,
        ...(effect.activityId ? { activityId: effect.activityId } : {}),
        completionSignals: [...(effect.completionSignals ?? [])],
        invalidationSignals: [...(effect.invalidationSignals ?? [])],
      }
    }
    this.#bumpCompanionRevision()
    return true
  }

  async #considerMemoryCandidate(effect: MemoryCandidateEffect): Promise<boolean> {
    if (effect.confidence < 0.5) return false
    const kind = memoryKind(effect.memoryKind)
    if (!kind) return false
    await this.#writeMemory(kind, effect.content, effect.evidenceEventIds.map(id => ({ kind: 'event' as const, id })))
    return true
  }

  async #writeMemory(kind: MemoryKind, summary: string, evidence: Array<{ kind: 'event' | 'action_result'; id: string }>): Promise<void> {
    const worldId = this.#backend.snapshot().world.worldId
    const memory = await this.#memory.remember({ worldId, kind, summary, evidence })
    await this.#append('memory.record.written', { memoryId: memory.id, kind: memory.kind, evidence: memory.evidence })
  }

  async #considerDanger(): Promise<void> {
    if (!this.#started || Date.now() - this.#lastDangerAt < 10_000) return
    let health
    try { health = this.#backend.snapshot().self.health } catch { return }
    if (health > 8) return
    this.#lastDangerAt = Date.now()
    this.#modelAbort?.abort('danger_reflex')
    this.#activeBehavior?.abort.abort('danger_reflex')
    try { this.#backend.motor().releaseAll() } catch { /* lifecycle race */ }
    this.#speech.setPressure('danger')
    this.#speech.schedule({ id: randomUUID(), text: '我受伤了，先停一下！', timing: 'now', purpose: 'report', urgency: 'urgent' })
    const event = await this.#rememberRecent('companion.danger.detected', '自身生命值进入危险范围，身体输入已释放')
    this.#enqueueDecision({ type: 'danger', eventId: event.id })
    this.#speech.setPressure('normal')
  }

  #modelCurrentState(): Record<string, unknown> {
    return {
      companionRevision: this.#companionRevision,
      activity: this.#activity ? {
        id: this.#activity.id,
        revision: this.#activity.revision,
        status: this.#activity.status,
        summary: this.#activity.summary,
        companionContribution: this.#activity.companionContribution,
        agreedFacts: this.#activity.agreedFacts,
        openQuestions: this.#activity.openQuestions,
      } : null,
      intent: this.#intent ? structuredClone(this.#intent) : null,
      attention: this.#attention ? structuredClone(this.#attention) : null,
      control: this.#activeBehavior
        ? { status: 'running', effectId: this.#activeBehavior.plan.effectId, startedAt: this.#activeBehavior.startedAt }
        : { status: 'idle' },
    }
  }

  #contextStillCurrent(context: ContextPackageV2): boolean {
    let snapshot
    try { snapshot = this.#backend.snapshot() } catch { return false }
    return this.#started &&
      context.ref.companionRevision === this.#companionRevision &&
      context.ref.profileVersion === this.#profile.versionId &&
      context.ref.sessionId === this.#sessionId &&
      context.ref.worldId === snapshot.world.worldId
  }

  #refreshDebug(): void {
    let body
    try {
      const snapshot = this.#backend.snapshot()
      const inventory = new Map<string, number>()
      for (const slot of snapshot.inventory.slots) inventory.set(slot.itemName, (inventory.get(slot.itemName) ?? 0) + slot.count)
      body = {
        position: snapshot.self.position,
        health: snapshot.self.health,
        food: snapshot.self.food,
        inventory: [...inventory].map(([itemName, count]) => ({ itemName, count })),
      }
    } catch { /* connection is not ready */ }
    this.#debug.update({
      connection: this.#backend.state(),
      body,
      attention: this.#attention,
      activity: this.#activity,
      intent: this.#intent ? { kind: 'active', summary: this.#intent.summary } : undefined,
      currentBehavior: this.#activeBehavior ? {
        id: this.#activeBehavior.plan.id,
        intentEffectId: this.#activeBehavior.plan.effectId,
        phase: 'running',
        purpose: 'visual_attention',
        startedAt: this.#activeBehavior.startedAt,
      } : undefined,
      resourceLeases: this.#activeBehavior ? { gaze: this.#activeBehavior.plan.id } : {},
    })
  }

  #embodimentScope(): { worldId: string; epoch: number; now: Date } {
    const snapshot = this.#backend.snapshot()
    return { worldId: snapshot.world.worldId, epoch: snapshot.connectionEpoch, now: new Date() }
  }

  async #composePassiveObservations(runId: string, signal: AbortSignal): Promise<PassiveObservations> {
    const caller: TrustedInformationCaller = {
      principalId: INFORMATION_PRINCIPAL_ID,
      grantId: INFORMATION_GRANT_ID,
      purpose: 'companion_context',
      correlationId: runId,
      decisionRunId: runId,
    }
    try {
      return await composePassiveObservations(this.#informationRuntime, caller, signal)
    } catch (error) {
      this.#recordFailure('runtime', 'passive_observations_failed', error)
      return { reads: [], omissions: [
        { interfaceId: 'current_status', reason: 'composition_failed' },
        { interfaceId: 'inventory_information', reason: 'composition_failed' },
        { interfaceId: 'sound_information', reason: 'composition_failed' },
        { interfaceId: 'viewport_information', reason: 'composition_failed' },
      ] }
    }
  }

  async #rememberRecent(type: string, summary: string): Promise<JournalEvent> {
    const event = await this.#append(type, { summary })
    this.#pushRecent(event.id, type, summary)
    return event
  }

  async #append<T>(type: string, payload: T): Promise<JournalEvent<T>> {
    const event = await this.#journal.append(type, payload)
    this.#eventSequence += 1
    return event
  }

  #pushRecent(id: string, type: string, summary: string): void {
    this.#recentEvents.push({ id, type, summary })
    if (this.#recentEvents.length > 20) this.#recentEvents.shift()
  }

  #bumpCompanionRevision(): void { this.#companionRevision += 1 }

  #recordFailure(
    source: 'backend' | 'model' | 'grounding' | 'behavior' | 'controller' | 'memory' | 'runtime',
    code: string,
    error: unknown,
  ): void {
    const summary = error instanceof Error ? error.message : String(error)
    this.#debug.failure({ at: new Date().toISOString(), source, code, summary })
    void this.#append(`${source}.failed`, { code, summary })
  }
}

function debugSources(context: ContextPackageV2): DebugContextSource[] {
  return context.fragments.map(fragment => ({
    id: fragment.id,
    kind: fragment.source.kind,
    size: Buffer.byteLength(JSON.stringify(fragment.content), 'utf8'),
  }))
}

function memoryKind(kind: MemoryCandidateEffect['memoryKind']): MemoryKind | undefined {
  if (kind === 'episode' || kind === 'relationship') return 'episode'
  if (kind === 'world_fact') return 'place'
  if (kind === 'commitment' || kind === 'player_preference') return kind
  return undefined
}

function withoutPrivateSpeech(event: unknown): unknown {
  if (!event || typeof event !== 'object') return event
  const copy = { ...(event as Record<string, unknown>) }
  if ('text' in copy) copy.text = '[REDACTED]'
  return copy
}

function buildInformationRuntime(
  backend: MinecraftBackendApi,
  soundHistory: SoundHistory,
  perception: BackendPerceptionPort,
): InformationRuntime {
  const registry = new InformationRegistry()
  registry.register(new CurrentStatusProvider(new BackendSelfVitalsPort(backend)))
  registry.register(new InventoryProvider(new BackendInventoryPort(backend)))
  registry.register(new SoundInformationProvider(soundHistory))
  registry.register(new ViewportInformationProvider(perception))
  registry.seal('1.21.1')

  const accessPolicy = new InMemoryInformationAccessPolicy()
  accessPolicy.put({
    id: INFORMATION_GRANT_ID,
    principalId: INFORMATION_PRINCIPAL_ID,
    audience: 'companion',
    allowedInterfaces: ['current_status', 'inventory_information', 'sound_information', 'viewport_information'],
    purpose: 'companion_context',
  })

  return new InformationRuntime({
    registry,
    accessPolicy,
    scopeSource: new BackendInformationScopeSource(backend, randomUUID()),
  })
}

function controllerSummary(result: VisualAttentionResult): string {
  if (result.status === 'completed') return '视觉注意已由新的第一人称观察验证'
  if (result.status === 'cancelled') return '视觉注意行为已取消，未报告完成'
  return `视觉注意行为失败：${result.reasonCode}`
}
