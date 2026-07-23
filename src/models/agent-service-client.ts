import { z } from 'zod'
import type { ContextPackageV2, ModelProvider, RawModelRunResult } from './contracts.js'
import { readJsonResponse, stringifyJson } from './json-transport.js'

interface FetchLike { (input: string | URL, init?: RequestInit): Promise<Response> }

export interface AgentServiceOptions {
  baseUrl: string
  timeoutMs?: number
  fetch?: FetchLike
  /** Complete loopback URL for the one-off D40 body-tool callback. */
  toolCallbackUrl?: string
  /** Per-process bearer credential paired with toolCallbackUrl. */
  toolCallbackToken?: string
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
  readonly #toolCallback?: { url: string; token: string }

  constructor(options: AgentServiceOptions) {
    this.#endpoint = new URL('/v1/decide', options.baseUrl)
    this.#timeoutMs = options.timeoutMs ?? 45_000
    this.#fetch = options.fetch ?? fetch
    const hasUrl = options.toolCallbackUrl !== undefined
    const hasToken = options.toolCallbackToken !== undefined
    if (hasUrl !== hasToken) throw new TypeError('D40 tool callback URL and token must be configured together')
    if (options.toolCallbackUrl !== undefined && options.toolCallbackToken !== undefined) {
      this.#toolCallback = {
        url: validateLoopbackCallbackUrl(options.toolCallbackUrl),
        token: validateCallbackToken(options.toolCallbackToken),
      }
    }
  }

  async runDecision(input: {
    context: ContextPackageV2
    outputSchema: object
    signal: AbortSignal
  }): Promise<RawModelRunResult> {
    const timeout = AbortSignal.timeout(this.#timeoutMs)
    const combined = AbortSignal.any([input.signal, timeout])
    const body = stringifyJson({ context: input.context, outputSchema: input.outputSchema })
    const headers: Record<string, string> = { 'content-type': 'application/json' }
    if (this.#toolCallback && isPlayerChatContext(input.context)) {
      headers['x-mineintent-tool-executor-url'] = this.#toolCallback.url
      headers['x-mineintent-tool-executor-token'] = this.#toolCallback.token
    }
    const response = await this.#fetch(this.#endpoint, {
      method: 'POST', signal: combined,
      headers,
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

function validateLoopbackCallbackUrl(value: string): string {
  if (value.length > 2_048 || /[\r\n]/u.test(value)) throw new TypeError('D40 tool callback URL is invalid')
  const url = new URL(value)
  const loopback = url.hostname === '127.0.0.1' || url.hostname === '[::1]' || url.hostname === 'localhost'
  if (url.protocol !== 'http:' || !loopback || url.username || url.password || url.hash) {
    throw new TypeError('D40 tool callback must be an uncredentialed loopback HTTP URL')
  }
  return url.href
}

function validateCallbackToken(value: string): string {
  if (value.length < 16 || value.length > 512 || /[\r\n]/u.test(value)) {
    throw new TypeError('D40 tool callback token must contain 16-512 safe header characters')
  }
  return value
}

function isPlayerChatContext(context: ContextPackageV2): boolean {
  const trigger = context.fragments.find(fragment =>
    fragment.id === 'fragment_trigger' && fragment.section === 'trigger_events')
  if (!trigger || !trigger.content || typeof trigger.content !== 'object' || Array.isArray(trigger.content)) return false
  return (trigger.content as Record<string, unknown>).type === 'player_chat'
}
