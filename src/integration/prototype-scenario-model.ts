import type { CompanionDecision, DecisionContext, ModelProvider, ModelRunResult } from '../models/index.js'

export class PrototypeScenarioModel implements ModelProvider {
  readonly contexts: DecisionContext[] = []

  async run(context: DecisionContext): Promise<ModelRunResult> {
    this.contexts.push(structuredClone(context))
    const text = context.trigger.text ?? ''
    if (context.trigger.type === 'startup') return result(decision({
      speech: context.memories.length ? '我回来了，还记得上次一起收集木材。' : '我来了，今天一起做点什么？',
    }))
    if (text.includes('一起收集')) return result(decision({
      speech: '好，我们一起找附近的树。',
      activity: { operation: 'start_wood_collection', summary: '和主要玩家一起收集木材' },
      intent: { kind: 'collect', summary: '寻找并采集附近的原木' },
      action: { skill: 'collect_wood', args: { count: 4, maxDistance: 24 }, purpose: '参与共同收集木材' },
    }))
    if (text.includes('继续')) return result(decision({
      speech: '好，继续收一点。', activity: { operation: 'resume', summary: '继续共同收集木材' },
      intent: { kind: 'collect', summary: '继续采集两块原木' },
      action: { skill: 'collect_wood', args: { count: 2, maxDistance: 24 }, purpose: '恢复共同收集' },
    }))
    if (text.includes('回刚才') || text.includes('回去')) return result(decision({
      speech: '够了，我们回刚才那里。', activity: { operation: 'complete', summary: '收集完成并返回活动起点' },
      intent: { kind: 'return', summary: '返回共同活动的起点' },
      action: { skill: 'return_to_anchor', args: {}, purpose: '和玩家一起返回' },
    }))
    if (text.includes('上次')) return result(decision({
      speech: context.memories.some(memory => memory.summary.includes('收集木材'))
        ? '上次我们一起收集了木材，后来回到了开始的地方。' : '我没有找到那段共同经历。',
    }))
    return result(decision({ speech: null }))
  }
}

function decision(overrides: Partial<CompanionDecision>): CompanionDecision {
  return {
    protocol: 'mineintent.companion-decision.v1', speech: null,
    attention: { kind: 'player', target: 'IntentPlayerCI' }, activity: { operation: 'keep', summary: '保持当前共同活动' },
    intent: { kind: 'observe', summary: '留意玩家和环境' }, action: null, memory: null, ...overrides,
  }
}

function result(value: CompanionDecision): ModelRunResult { return { decision: value, model: 'prototype-scenario-model' } }
