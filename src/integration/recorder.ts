import { appendFileSync, mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import type { IntegrationPhase, IntegrationRecord, IntegrationRecorder, ScenarioResult } from './contracts.js'

export class JsonlIntegrationRecorder implements IntegrationRecorder {
  readonly directory: string
  readonly #eventsPath: string
  #sequence = 0
  constructor(root: string, runId: string) {
    this.directory = path.join(root, runId)
    mkdirSync(this.directory, { recursive: true })
    this.#eventsPath = path.join(this.directory, 'events.jsonl')
  }
  record(scenario: string, phase: IntegrationPhase, type: string, detail: unknown): void {
    const event: IntegrationRecord = { sequence: ++this.#sequence, at: new Date().toISOString(), scenario, phase, type, detail }
    appendFileSync(this.#eventsPath, `${JSON.stringify(event)}\n`, 'utf8')
  }
  writeSummary(results: readonly ScenarioResult[]): void {
    writeFileSync(path.join(this.directory, 'summary.json'), `${JSON.stringify({ at: new Date().toISOString(), results }, null, 2)}\n`, 'utf8')
  }
}

export class MemoryIntegrationRecorder implements IntegrationRecorder {
  readonly records: IntegrationRecord[] = []
  record(scenario: string, phase: IntegrationPhase, type: string, detail: unknown): void {
    this.records.push({ sequence: this.records.length + 1, at: new Date().toISOString(), scenario, phase, type, detail })
  }
}
