import type { IntegrationRecorder, PaperScenario, PaperScenarioContext, ScenarioResult } from './contracts.js'

export class PaperScenarioRunner {
  constructor(readonly recorder: IntegrationRecorder) {}

  async run(scenario: PaperScenario, outerSignal?: AbortSignal): Promise<ScenarioResult> {
    const started = Date.now()
    const controller = new AbortController()
    let timedOut = false
    const abort = () => controller.abort(outerSignal?.reason ?? 'outer_abort')
    outerSignal?.addEventListener('abort', abort, { once: true })
    const timer = setTimeout(() => { timedOut = true; controller.abort('scenario_timeout') }, scenario.timeoutMs)
    const ctx: PaperScenarioContext = {
      signal: controller.signal,
      record: (phase, type, detail) => this.recorder.record(scenario.name, phase, type, detail),
    }
    let error: unknown
    try {
      ctx.record('harness', 'scenario_started', { timeoutMs: scenario.timeoutMs })
      await scenario.setup(ctx)
      if (controller.signal.aborted) throw abortError(controller.signal.reason)
      await scenario.run(ctx)
    } catch (caught) { error = caught }
    finally {
      try { await scenario.cleanup(ctx) } catch (cleanupError) {
        ctx.record('cleanup', 'cleanup_failed', serializeError(cleanupError))
        error ??= cleanupError
      }
      clearTimeout(timer)
      outerSignal?.removeEventListener('abort', abort)
    }
    const status = timedOut ? 'timed_out' : error ? 'failed' : 'passed'
    const result: ScenarioResult = { name: scenario.name, status, durationMs: Date.now() - started, ...(error ? { error: serializeError(error).message } : {}) }
    ctx.record('harness', 'scenario_terminal', result)
    return result
  }
}

function abortError(reason: unknown): DOMException { return new DOMException(String(reason), 'AbortError') }
function serializeError(error: unknown): { name: string; message: string } { return error instanceof Error ? { name: error.name, message: error.message } : { name: 'Error', message: String(error) } }
