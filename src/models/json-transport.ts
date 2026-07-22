const DEFAULT_MAX_JSON_BYTES = 1_048_576

export class JsonTransportError extends Error {}

export function stringifyJson(value: unknown, maxBytes = DEFAULT_MAX_JSON_BYTES): string {
  let text: string
  try {
    text = JSON.stringify(value, (key, item: unknown) => {
      assertWellFormedUnicode(key)
      if (typeof item === 'string') assertWellFormedUnicode(item)
      if (typeof item === 'number' && !Number.isFinite(item)) {
        throw new JsonTransportError('JSON contains a non-finite number')
      }
      if (typeof item === 'number' && Number.isInteger(item) && !Number.isSafeInteger(item)) {
        throw new JsonTransportError('JSON contains an integer outside the interoperable safe range')
      }
      return item
    })
  } catch (error) {
    if (error instanceof JsonTransportError) throw error
    throw new JsonTransportError(`JSON serialization failed: ${error instanceof Error ? error.message : String(error)}`)
  }
  if (Buffer.byteLength(text, 'utf8') > maxBytes) throw new JsonTransportError(`JSON exceeds ${maxBytes} bytes`)
  return text
}

export async function readJsonResponse(response: Response, maxBytes = DEFAULT_MAX_JSON_BYTES): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null) {
    const parsedLength = Number(declaredLength)
    if (!Number.isSafeInteger(parsedLength) || parsedLength < 0) throw new JsonTransportError('Response has an invalid content-length')
    if (parsedLength > maxBytes) throw new JsonTransportError(`Response exceeds ${maxBytes} bytes`)
  }

  const bytes = await readLimitedBody(response, maxBytes)
  let text: string
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    throw new JsonTransportError('Response body was not valid UTF-8')
  }

  let value: unknown
  try {
    value = JSON.parse(text) as unknown
  } catch {
    throw new JsonTransportError('Response body was not valid JSON')
  }
  assertJsonValue(value)
  return value
}

async function readLimitedBody(response: Response, maxBytes: number): Promise<Uint8Array> {
  if (!response.body) return new Uint8Array()
  const reader = response.body.getReader()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      total += value.byteLength
      if (total > maxBytes) {
        await reader.cancel('response body exceeded limit')
        throw new JsonTransportError(`Response exceeds ${maxBytes} bytes`)
      }
      chunks.push(value)
    }
  } finally {
    reader.releaseLock()
  }
  const result = new Uint8Array(total)
  let offset = 0
  for (const chunk of chunks) {
    result.set(chunk, offset)
    offset += chunk.byteLength
  }
  return result
}

function assertJsonValue(root: unknown): void {
  const pending: unknown[] = [root]
  while (pending.length > 0) {
    const value = pending.pop()
    if (typeof value === 'string') {
      assertWellFormedUnicode(value)
    } else if (typeof value === 'number') {
      if (!Number.isFinite(value)) throw new JsonTransportError('JSON contains a non-finite number')
      if (Number.isInteger(value) && !Number.isSafeInteger(value)) {
        throw new JsonTransportError('JSON contains an integer outside the interoperable safe range')
      }
    } else if (Array.isArray(value)) {
      pending.push(...value)
    } else if (value && typeof value === 'object') {
      for (const [key, item] of Object.entries(value)) {
        assertWellFormedUnicode(key)
        pending.push(item)
      }
    }
  }
}

function assertWellFormedUnicode(value: string): void {
  for (let index = 0; index < value.length; index += 1) {
    const unit = value.charCodeAt(index)
    if (unit >= 0xd800 && unit <= 0xdbff) {
      const next = value.charCodeAt(index + 1)
      if (!Number.isInteger(next) || next < 0xdc00 || next > 0xdfff) {
        throw new JsonTransportError('JSON contains an unpaired Unicode surrogate')
      }
      index += 1
    } else if (unit >= 0xdc00 && unit <= 0xdfff) {
      throw new JsonTransportError('JSON contains an unpaired Unicode surrogate')
    }
  }
}
