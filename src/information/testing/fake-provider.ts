import type {
  InformationProvider,
  InformationProviderContext,
  InformationProviderDefinition,
  ProviderAvailability,
  ProviderReadRequest,
  ProviderReadResult,
} from '../contracts/index.js'

export interface FakeInformationProviderOptions<
  Values extends object,
  Selector,
  PageState,
> {
  definition: InformationProviderDefinition<Values>
  availability: (
    context: InformationProviderContext,
  ) => ProviderAvailability<Values>
  read: (
    context: InformationProviderContext,
    request: ProviderReadRequest<Values, Selector, PageState>,
    signal: AbortSignal,
  ) => Promise<ProviderReadResult<Values, PageState>>
}

export class FakeInformationProvider<
  Values extends object,
  Selector = never,
  PageState = never,
> implements InformationProvider<Values, Selector, PageState> {
  readonly definition: InformationProviderDefinition<Values>

  constructor(
    private readonly options: FakeInformationProviderOptions<Values, Selector, PageState>,
  ) {
    this.definition = options.definition
  }

  availability(context: InformationProviderContext): ProviderAvailability<Values> {
    return this.options.availability(context)
  }

  read(
    context: InformationProviderContext,
    request: ProviderReadRequest<Values, Selector, PageState>,
    signal: AbortSignal,
  ): Promise<ProviderReadResult<Values, PageState>> {
    return this.options.read(context, request, signal)
  }
}
