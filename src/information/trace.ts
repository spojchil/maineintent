import type { InformationTraceRecord } from './contracts/index.js'

export interface InformationTraceSink {
  append(record: InformationTraceRecord): void
}

export class InMemoryInformationTrace implements InformationTraceSink {
  readonly #records: InformationTraceRecord[] = []

  constructor(private readonly maxRecords = 1_024) {
    if (!Number.isInteger(maxRecords) || maxRecords < 1) {
      throw new Error('Information trace capacity must be positive')
    }
  }

  append(record: InformationTraceRecord): void {
    this.#records.push(Object.freeze({
      ...record,
      fields: Object.freeze([...record.fields]),
      evidenceIds: Object.freeze([...record.evidenceIds]),
    }))
    if (this.#records.length > this.maxRecords) this.#records.shift()
  }

  records(): readonly Readonly<InformationTraceRecord>[] {
    return Object.freeze(this.#records.map((record) => Object.freeze(structuredClone(record))))
  }
}

export const noopInformationTrace: InformationTraceSink = {
  append: () => undefined,
}
