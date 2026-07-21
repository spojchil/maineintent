import { companionDecisionSchema, type DecisionContext, type ModelProvider, type ModelRunResult } from './contracts.js'

interface FetchLike { (input: string | URL, init?: RequestInit): Promise<Response> }

export interface OpenAICompatibleOptions {
  baseUrl: string
  apiKey: string
  model: string
  timeoutMs?: number
  fetch?: FetchLike
}

export class OpenAICompatibleModelProvider implements ModelProvider {
  readonly #endpoint: URL
  readonly #apiKey: string
  readonly #model: string
  readonly #timeoutMs: number
  readonly #fetch: FetchLike

  constructor(options: OpenAICompatibleOptions) {
    if (!options.apiKey.trim()) throw new Error('Model API key is required')
    if (!options.model.trim()) throw new Error('Model name is required')
    this.#endpoint = new URL(`${options.baseUrl.replace(/\/$/u, '')}/chat/completions`)
    this.#apiKey = options.apiKey
    this.#model = options.model
    this.#timeoutMs = options.timeoutMs ?? 45_000
    this.#fetch = options.fetch ?? fetch
  }

  async run(context: DecisionContext, signal: AbortSignal): Promise<ModelRunResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', signal: combined,
      headers: { authorization: `Bearer ${this.#apiKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({
        model: this.#model,
        temperature: 0.4,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt(context.profile.content) },
          { role: 'user', content: JSON.stringify(modelContext(context)) },
        ],
      }),
    })
    const payload = await response.json() as {
      error?: { message?: string }
      choices?: Array<{ message?: { content?: string } }>
      usage?: { prompt_tokens?: number; completion_tokens?: number }
    }
    if (!response.ok) throw new Error(`Model request failed (${response.status}): ${payload.error?.message ?? 'unknown error'}`)
    const content = payload.choices?.[0]?.message?.content
    if (!content) throw new Error('Model response did not contain message content')
    let parsed: unknown
    try { parsed = JSON.parse(content) } catch (error) { throw new Error('Model response was not strict JSON', { cause: error }) }
    const decision = companionDecisionSchema.parse(parsed)
    return {
      decision, model: this.#model,
      ...(payload.usage ? { usage: { inputTokens: payload.usage.prompt_tokens, outputTokens: payload.usage.completion_tokens } } : {}),
    }
  }
}

function systemPrompt(profile: string): string {
  return `你是 Minecraft 世界里的 AI 同伴。以下是可编辑同伴档案：\n\n${profile}\n\n` +
    '你必须只输出符合 mineintent.companion-decision.v1 的 JSON 对象。你与玩家共同游玩，不是任务机器人。' +
    '语言要简短自然；语言承诺必须与 action 一致，不能虚报成功。没有必要行动时 action 为 null。' +
    'start_wood_collection 会记录出发地点；“够了/回刚才那里”应 complete 并选择 return_to_anchor。' +
    '只有真实聊天、动作结果或已有记忆支持时才提出 memory，否则为 null。明确暂停优先。' +
    '字段固定为 protocol,speech,attention,activity,intent,action,memory；不要 Markdown。' +
    '必须严格使用以下 JSON 结构；所有对象必须保持为对象，不能简写成字符串：\n' + decisionJsonTemplate
}

const decisionJsonTemplate = JSON.stringify({
  protocol: 'mineintent.companion-decision.v1',
  speech: null,
  attention: { kind: 'environment', target: null },
  activity: { operation: 'keep', summary: '等待玩家一起游玩' },
  intent: { kind: 'observe', summary: '留意玩家和周围环境' },
  action: null,
  memory: null,
}, null, 2) + '\n' +
  'activity.operation 只能取一个值：keep、start_wood_collection、pause、resume、complete、abandon。' +
  'speech、attention.target、action、memory 可以为 JSON null；不要输出带竖线的枚举说明字符串。\n' +
  'action 非 null 时只能是以下之一：' + JSON.stringify([
    { skill: 'follow_player', args: { range: 3 }, purpose: '行动目的' },
    { skill: 'collect_wood', args: { count: 4, maxDistance: 32 }, purpose: '行动目的' },
    { skill: 'return_to_anchor', args: {}, purpose: '行动目的' },
    { skill: 'wait', args: { durationSeconds: 10 }, purpose: '行动目的' },
  ]) + '\n' +
  'memory 非 null 时必须是 {"kind":"episode|place|commitment|player_preference","summary":"有证据支持的记忆"}。'

function modelContext(context: DecisionContext): unknown {
  return {
    protocol: 'mineintent.decision-context.v1', runId: context.runId, trigger: context.trigger,
    primaryPlayer: context.primaryPlayer,
    world: { worldId: context.snapshot.world.worldId, dimension: context.snapshot.world.dimension, timeOfDay: context.snapshot.world.timeOfDay },
    self: { position: context.snapshot.self.position, health: context.snapshot.self.health, food: context.snapshot.self.food, inventory: context.snapshot.inventory.slots },
    trackedPlayers: context.snapshot.trackedPlayers, activity: context.activity ?? null,
    recentEvents: context.recentEvents, retrievedMemories: context.memories, availableSkills: context.availableSkills,
  }
}
