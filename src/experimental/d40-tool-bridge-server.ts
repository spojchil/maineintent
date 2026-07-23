import { randomBytes, timingSafeEqual } from 'node:crypto'
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http'
import { d40ToolInvocationSchema, type D40ToolBridgeAddress, type D40ToolHandler } from './d40-tool-bridge-contracts.js'

const HOST = '127.0.0.1' as const
const ROUTE = '/v1/experiment/d40/tool'
const MAX_REQUEST_BYTES = 32_768
const MAX_RESPONSE_BYTES = 262_144
const MAX_ERROR_LENGTH = 500

export class D40ToolBridgeServer {
  readonly #handler: D40ToolHandler
  readonly #token: string
  #server?: Server

  constructor(handler: D40ToolHandler, token = randomBytes(32).toString('base64url')) {
    if (typeof token !== 'string' || token.length < 16 || token.length > 512 || /[\r\n]/u.test(token)) {
      throw new TypeError('D40 tool bridge token must contain 16-512 safe header characters')
    }
    this.#handler = handler
    this.#token = token
  }

  async start(): Promise<D40ToolBridgeAddress> {
    if (this.#server) return this.address()
    const server = createServer((request, response) => { void this.#handle(request, response) })
    this.#server = server
    try {
      await new Promise<void>((resolve, reject) => {
        server.once('error', reject)
        server.listen(0, HOST, () => { server.off('error', reject); resolve() })
      })
    } catch (error) {
      this.#server = undefined
      throw error
    }
    return this.address()
  }

  address(): D40ToolBridgeAddress {
    const address = this.#server?.address()
    if (!address || typeof address === 'string') throw new Error('D40 tool bridge is not listening')
    return { host: HOST, port: address.port, url: `http://${HOST}:${address.port}${ROUTE}`, token: this.#token }
  }

  async stop(): Promise<void> {
    const server = this.#server
    this.#server = undefined
    if (!server) return
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }

  async #handle(request: IncomingMessage, response: ServerResponse): Promise<void> {
    try {
      if (request.method !== 'POST') throw new HttpFailure(405, 'method_not_allowed', { allow: 'POST' })
      if (request.url !== ROUTE) throw new HttpFailure(404, 'not_found')
      if (!authorized(request.headers.authorization, this.#token)) throw new HttpFailure(401, 'unauthorized')
      const contentType = request.headers['content-type']?.split(';', 1)[0]?.trim().toLowerCase()
      if (contentType !== 'application/json') throw new HttpFailure(415, 'content_type_must_be_application_json')

      const raw = await readBoundedBody(request)
      let value: unknown
      try { value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(raw)) }
      catch { throw new HttpFailure(400, 'invalid_json') }
      const parsed = d40ToolInvocationSchema.safeParse(value)
      if (!parsed.success) throw new HttpFailure(400, 'invalid_tool_invocation')

      const result = await this.#handler(parsed.data)
      sendJson(response, 200, result)
    } catch (error) {
      if (response.headersSent || response.destroyed) return
      const failure = error instanceof HttpFailure
        ? error
        : new HttpFailure(500, boundedError(error))
      sendJson(response, failure.status, { error: failure.message }, failure.headers)
    }
  }
}

class HttpFailure extends Error {
  constructor(readonly status: number, message: string, readonly headers: Record<string, string> = {}) {
    super(message)
  }
}

async function readBoundedBody(request: IncomingMessage): Promise<Uint8Array> {
  const length = request.headers['content-length']
  if (length !== undefined) {
    const parsed = Number(length)
    if (!Number.isSafeInteger(parsed) || parsed < 0) throw new HttpFailure(400, 'invalid_content_length')
    if (parsed > MAX_REQUEST_BYTES) {
      request.resume()
      throw new HttpFailure(413, 'request_too_large')
    }
  }
  const chunks: Buffer[] = []
  let size = 0
  let tooLarge = false
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array)
    size += buffer.length
    if (size > MAX_REQUEST_BYTES) tooLarge = true
    else if (!tooLarge) chunks.push(buffer)
  }
  if (tooLarge) throw new HttpFailure(413, 'request_too_large')
  return Buffer.concat(chunks, size)
}

function authorized(header: string | undefined, token: string): boolean {
  if (!header) return false
  const expected = Buffer.from(`Bearer ${token}`, 'utf8')
  const actual = Buffer.from(header, 'utf8')
  return actual.length === expected.length && timingSafeEqual(actual, expected)
}

function sendJson(
  response: ServerResponse,
  status: number,
  value: unknown,
  headers: Record<string, string> = {},
): void {
  let payload: Buffer
  try {
    const serialized = JSON.stringify(value)
    if (serialized === undefined) throw new TypeError('response_is_not_json')
    payload = Buffer.from(serialized, 'utf8')
    if (payload.length > MAX_RESPONSE_BYTES) throw new RangeError('response_too_large')
  } catch (error) {
    if (status !== 200) {
      payload = Buffer.from('{"error":"response_serialization_failed"}', 'utf8')
    } else {
      sendJson(response, 500, { error: boundedError(error) })
      return
    }
  }
  response.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(payload.length),
    'cache-control': 'no-store',
    ...headers,
  }).end(payload)
}

function boundedError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  return message.slice(0, MAX_ERROR_LENGTH) || 'tool_handler_failed'
}
