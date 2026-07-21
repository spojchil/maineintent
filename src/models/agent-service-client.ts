import { companionDecisionSchema, type DecisionContext, type ModelProvider, type ModelRunResult } from './contracts.js'

interface FetchLike { (input: string | URL, init?: RequestInit): Promise<Response> }

export interface AgentServiceOptions {
  baseUrl: string
  timeoutMs?: number
  fetch?: FetchLike
}

export class AgentServiceModelProvider implements ModelProvider {
  readonly #endpoint: URL
  readonly #timeoutMs: number
  readonly #fetch: FetchLike

  constructor(options: AgentServiceOptions) {
    this.#endpoint = new URL('/v1/decide', options.baseUrl)
    this.#timeoutMs = options.timeoutMs ?? 45_000
    this.#fetch = options.fetch ?? fetch
  }

  async run(context: DecisionContext, signal: AbortSignal): Promise<ModelRunResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = AbortSignal.any([signal, timeout])
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', signal: combined,
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(context),
    })
    const payload = await response.json() as { error?: string; decision?: unknown; model?: string; usage?: { inputTokens?: number; outputTokens?: number } }
    if (!response.ok) throw new Error(`Agent service request failed (${response.status}): ${payload.error ?? 'unknown error'}`)
    const decision = companionDecisionSchema.parse(payload.decision)
    return { decision, model: payload.model ?? 'unknown', ...(payload.usage ? { usage: payload.usage } : {}) }
  }
}
