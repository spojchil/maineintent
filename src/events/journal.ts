import { randomUUID } from 'node:crypto'
import { appendFile, mkdir } from 'node:fs/promises'
import path from 'node:path'

export interface JournalEvent<T = unknown> {
  protocol: 'mineintent.event.v1'
  id: string
  type: string
  occurredAt: string
  worldId: string
  sessionId: string
  payload: T
}

export class JsonlEventJournal {
  readonly #file: string
  readonly #worldId: string
  readonly #sessionId: string
  #write = Promise.resolve()

  constructor(file: string, worldId: string, sessionId: string) {
    this.#file = path.resolve(file)
    this.#worldId = worldId
    this.#sessionId = sessionId
  }

  async append<T>(type: string, payload: T): Promise<JournalEvent<T>> {
    const event: JournalEvent<T> = {
      protocol: 'mineintent.event.v1', id: randomUUID(), type, occurredAt: new Date().toISOString(),
      worldId: this.#worldId, sessionId: this.#sessionId, payload,
    }
    this.#write = this.#write.then(async () => {
      await mkdir(path.dirname(this.#file), { recursive: true })
      await appendFile(this.#file, `${JSON.stringify(event)}\n`, { encoding: 'utf8', mode: 0o600 })
    })
    await this.#write
    return event
  }

  async flush(): Promise<void> { await this.#write }
}
