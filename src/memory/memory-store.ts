import { randomUUID } from 'node:crypto'
import { readFile, mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { z } from 'zod'
import type { MemoryEvidence, MemoryKind, MemoryRecord, MemorySearchResult } from './contracts.js'

const recordSchema = z.strictObject({
  protocol: z.literal('mineintent.memory.v1'), id: z.string().uuid(), worldId: z.string().min(1),
  kind: z.enum(['episode', 'place', 'commitment', 'player_preference']), summary: z.string().min(1).max(1_000),
  keywords: z.array(z.string().min(1).max(64)).max(32),
  evidence: z.array(z.strictObject({ kind: z.enum(['event', 'action_result']), id: z.string().min(1) })).min(1).max(64),
  createdAt: z.string().datetime(), status: z.literal('active'),
})
const fileSchema = z.strictObject({ protocol: z.literal('mineintent.memory-file.v1'), records: z.array(recordSchema) })

export class FileMemoryStore {
  readonly #file: string
  #records: MemoryRecord[] = []
  #loaded = false
  #write = Promise.resolve()

  constructor(file: string) { this.#file = path.resolve(file) }

  async load(): Promise<void> {
    if (this.#loaded) return
    try {
      const parsed = fileSchema.parse(JSON.parse(await readFile(this.#file, 'utf8')))
      this.#records = parsed.records
    } catch (error) {
      if (!isMissing(error)) throw new Error(`Cannot load memory file ${this.#file}`, { cause: error })
      this.#records = []
    }
    this.#loaded = true
  }

  async remember(input: {
    worldId: string
    kind: MemoryKind
    summary: string
    keywords?: readonly string[]
    evidence: readonly MemoryEvidence[]
  }): Promise<MemoryRecord> {
    await this.load()
    const record = recordSchema.parse({
      protocol: 'mineintent.memory.v1', id: randomUUID(), worldId: input.worldId, kind: input.kind,
      summary: input.summary.trim(), keywords: [...new Set(input.keywords ?? tokenize(input.summary))].slice(0, 32),
      evidence: input.evidence, createdAt: new Date().toISOString(), status: 'active',
    })
    this.#records.push(record)
    await this.#persist()
    return structuredClone(record)
  }

  async search(worldId: string, query: string, limit = 5): Promise<MemorySearchResult[]> {
    await this.load()
    const terms = new Set(tokenize(query))
    return this.#records.filter(record => record.worldId === worldId).map(record => {
      const text = new Set([...record.keywords, ...tokenize(record.summary)])
      const overlap = [...terms].filter(term => text.has(term)).length
      const ageDays = Math.max(0, (Date.now() - Date.parse(record.createdAt)) / 86_400_000)
      return { record: structuredClone(record), score: overlap * 10 + 1 / (1 + ageDays) }
    }).filter(result => result.score > 0).sort((left, right) => right.score - left.score).slice(0, limit)
  }

  async list(worldId: string): Promise<MemoryRecord[]> {
    await this.load()
    return this.#records.filter(record => record.worldId === worldId).map(record => structuredClone(record))
  }

  async #persist(): Promise<void> {
    const contents = JSON.stringify({ protocol: 'mineintent.memory-file.v1', records: this.#records }, null, 2)
    this.#write = this.#write.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true })
      await writeFile(this.#file, contents, { encoding: 'utf8', mode: 0o600 })
    })
    await this.#write
  }
}

function tokenize(text: string): string[] {
  return [...new Set(text.toLocaleLowerCase().match(/[\p{L}\p{N}_-]{2,}/gu) ?? [])]
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ENOENT'
}
