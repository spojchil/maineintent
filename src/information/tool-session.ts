import type {
  InformationCatalogRequest,
  InformationCatalogResult,
  InformationQueryRequest,
  InformationRequestError,
  InformationToolResult,
  InformationToolSessionContext,
  TrustedInformationCaller,
} from './contracts/index.js'

export interface InformationRuntimePort {
  catalog(
    caller: TrustedInformationCaller,
    request: unknown,
  ): InformationCatalogResult | InformationRequestError
  query(
    caller: TrustedInformationCaller,
    request: unknown,
    signal: AbortSignal,
  ): Promise<InformationToolResult>
}

export class InformationToolSession {
  #calls = 0
  #readCalls = 0
  #returnedBytes = 0

  constructor(readonly context: Readonly<InformationToolSessionContext>) {
    const { budget } = context
    if (!Number.isInteger(budget.maxCalls) || !Number.isInteger(budget.maxReadCalls) ||
        !Number.isInteger(budget.maxReturnedBytes) ||
        budget.maxCalls < 1 || budget.maxReadCalls < 0 || budget.maxReturnedBytes < 1 ||
        Number.isNaN(Date.parse(budget.deadlineAt))) {
      throw new Error('Invalid information tool session budget')
    }
  }

  reserve(kind: 'catalog' | 'help' | 'read'): InformationRequestError | undefined {
    if (Date.now() >= Date.parse(this.context.budget.deadlineAt)) {
      return sessionError('deadline_exceeded', 'The information tool session deadline elapsed.')
    }
    if (this.#calls >= this.context.budget.maxCalls) {
      return sessionError('budget_exceeded', 'The information tool call budget is exhausted.')
    }
    if (kind === 'read' && this.#readCalls >= this.context.budget.maxReadCalls) {
      return sessionError('budget_exceeded', 'The information read budget is exhausted.')
    }
    this.#calls += 1
    if (kind === 'read') this.#readCalls += 1
    return undefined
  }

  record(result: unknown): InformationRequestError | undefined {
    this.#returnedBytes += Buffer.byteLength(JSON.stringify(result), 'utf8')
    if (this.#returnedBytes > this.context.budget.maxReturnedBytes) {
      return sessionError('budget_exceeded', 'The information result byte budget is exhausted.')
    }
    return undefined
  }

  usage(): Readonly<{ calls: number; readCalls: number; returnedBytes: number }> {
    return Object.freeze({
      calls: this.#calls,
      readCalls: this.#readCalls,
      returnedBytes: this.#returnedBytes,
    })
  }

  caller(): TrustedInformationCaller {
    return {
      principalId: this.context.principalId,
      grantId: this.context.grantId,
      purpose: 'model_tool',
      correlationId: this.context.correlationId,
      decisionRunId: this.context.decisionRunId,
    }
  }

  async runOperation<Result>(
    upstream: AbortSignal,
    operation: (signal: AbortSignal) => Promise<Result>,
  ): Promise<Result> {
    const remainingMs = Date.parse(this.context.budget.deadlineAt) - Date.now()
    const controller = new AbortController()
    const abortFromUpstream = () => controller.abort(upstream.reason)
    if (upstream.aborted) abortFromUpstream()
    else upstream.addEventListener('abort', abortFromUpstream, { once: true })

    let deadlineTimer: ReturnType<typeof setTimeout> | undefined
    if (remainingMs <= 0) {
      controller.abort(new Error('Information tool session deadline elapsed'))
    } else {
      const boundedMs = Math.max(1, Math.min(Math.ceil(remainingMs), 2_147_483_647))
      deadlineTimer = setTimeout(() => {
        controller.abort(new Error('Information tool session deadline elapsed'))
      }, boundedMs)
    }

    try {
      return await operation(controller.signal)
    } finally {
      if (deadlineTimer !== undefined) clearTimeout(deadlineTimer)
      upstream.removeEventListener('abort', abortFromUpstream)
    }
  }
}

export class InformationCatalogTool {
  readonly name = 'information_catalog' as const

  constructor(private readonly runtime: InformationRuntimePort) {}

  invoke(
    input: unknown,
    session: InformationToolSession,
  ): InformationCatalogResult | InformationRequestError {
    const reservation = session.reserve('catalog')
    if (reservation) return reservation
    const result = this.runtime.catalog(session.caller(), input)
    return session.record(result) ?? result
  }
}

export class InformationTool {
  readonly name = 'information' as const

  constructor(private readonly runtime: InformationRuntimePort) {}

  async invoke(
    input: unknown,
    session: InformationToolSession,
    signal: AbortSignal,
  ): Promise<InformationToolResult> {
    const reservation = session.reserve(
      typeof input === 'object' && input !== null && 'operation' in input && input.operation === 'read'
        ? 'read'
        : 'help',
    )
    if (reservation) return reservation
    const result = await session.runOperation(
      signal,
      (operationSignal) => this.runtime.query(session.caller(), input, operationSignal),
    )
    return session.record(result) ?? result
  }
}

function sessionError(
  code: 'budget_exceeded' | 'deadline_exceeded',
  message: string,
): InformationRequestError {
  return { protocol: 'mineintent.information-error.v1', code, message }
}
