import { z } from 'zod'
import type { ContextPackageV2, ModelProvider, RawModelRunResult } from './contracts.js'
import { readJsonResponse, stringifyJson } from './json-transport.js'

interface FetchLike { (input: string | URL, init?: RequestInit): Promise<Response> }

export interface AgentServiceOptions {
  baseUrl: string
  timeoutMs?: number
  fetch?: FetchLike
}

const usageSchema = z.strictObject({
  inputTokens: z.number().int().nonnegative().optional(),
  outputTokens: z.number().int().nonnegative().optional(),
})

const successResponseSchema = z.strictObject({
  rawOutput: z.unknown(),
  model: z.string().min(1).max(256),
  usage: usageSchema.optional(),
})

const errorResponseSchema = z.strictObject({ error: z.string().min(1).max(2_000) })

export class AgentServiceModelProvider implements ModelProvider {
  readonly #endpoint: URL
  readonly #timeoutMs: number
  readonly #fetch: FetchLike

  constructor(options: AgentServiceOptions) {
    this.#endpoint = new URL('/v1/decide', options.baseUrl)
    this.#timeoutMs = options.timeoutMs ?? 45_000
    this.#fetch = options.fetch ?? fetch
  }

  async runDecision(input: {
    context: ContextPackageV2
    outputSchema: object
    signal: AbortSignal
  }): Promise<RawModelRunResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = AbortSignal.any([input.signal, timeout])
    const body = stringifyJson({ context: input.context, outputSchema: input.outputSchema })
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', signal: combined,
      headers: { 'content-type': 'application/json' },
      body,
    })
    const payload = await readJsonResponse(response)
    if (!response.ok) {
      const error = errorResponseSchema.safeParse(payload)
      throw new Error(`Agent service request failed (${response.status}): ${error.success ? error.data.error : 'invalid error response'}`)
    }
    const result = successResponseSchema.parse(payload)
    return { rawOutput: result.rawOutput, model: result.model, ...(result.usage ? { usage: result.usage } : {}) }
  }
}
