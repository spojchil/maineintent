export type BodyResource = 'locomotion' | 'gaze' | 'hands' | 'inventory' | 'interaction'
export type Interruptibility = 'immediate' | 'checkpoint' | 'terminal_only'
export type ActionTerminalStatus = 'completed' | 'failed' | 'cancelled' | 'timed_out' | 'interrupted'

export interface SchemaLike<T> {
  safeParse(value: unknown): { success: true; data: T } | { success: false; error: unknown }
}

export interface ActionSideEffect { type: string; detail: string; at: string }
export interface Verification { verified: boolean; detail: string; observedEffects?: string[] }

export interface SkillContext {
  readonly actionId: string
  readonly signal: AbortSignal
  recordSideEffect(effect: Omit<ActionSideEffect, 'at'>): void
  checkpoint(): void
}

export interface SkillDefinition<Args, Result> {
  name: string
  description: string
  inputSchema: SchemaLike<Args>
  requiredResources: readonly BodyResource[]
  preconditions: readonly string[]
  expectedEffects: readonly string[]
  defaultTimeoutMs: number
  interruptibility: Interruptibility
  checkPreconditions?: (args: Args) => Promise<{ ok: true } | { ok: false; detail: string }>
  execute(ctx: SkillContext, args: Args, signal: AbortSignal): Promise<Result>
  verify(ctx: SkillContext, args: Args, result: Result): Promise<Verification>
  cleanup?: (ctx: SkillContext, args: Args, reason: string) => Promise<void> | void
}

export interface ActionRequest {
  id: string
  skill: string
  args: Record<string, unknown>
  purpose: string
  after: readonly string[]
  onDependencyFailure: 'cancel'
}

export interface ActionGroupRequest { id: string; mode: 'atomic_preflight'; actions: readonly ActionRequest[] }

export type ActionGroupRejectionCode =
  | 'unknown_skill' | 'invalid_args' | 'missing_dependency' | 'dependency_cycle'
  | 'resource_conflict' | 'precondition_failed' | 'duplicate_action_id' | 'invalid_skill_definition'

export interface ActionGroupRejection { groupId: string; code: ActionGroupRejectionCode; actionId?: string; detail: string }

export interface ActionResult {
  groupId: string
  actionId: string
  skill: string
  status: ActionTerminalStatus
  startedAt?: string
  endedAt: string
  durationMs: number
  verification?: Verification
  failure?: { code: string; detail: string }
  sideEffects: ActionSideEffect[]
}

export type ActionRuntimeEvent =
  | { type: 'group_accepted'; groupId: string }
  | { type: 'group_rejected'; rejection: ActionGroupRejection }
  | { type: 'action_started'; groupId: string; actionId: string; resources: readonly BodyResource[] }
  | { type: 'action_terminal'; result: ActionResult }

export type SubmitResult =
  | { accepted: false; rejection: ActionGroupRejection }
  | { accepted: true; groupId: string; completion: Promise<readonly ActionResult[]> }
