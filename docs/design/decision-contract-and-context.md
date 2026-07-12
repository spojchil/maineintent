# 同伴决策协议与上下文包

> 状态：已设计，待实现  
> 对应 Issue：[#10](https://github.com/spojchil/mineintent/issues/10)  
> 上游设计：[系统设计](../../SYSTEM_DESIGN.md)、[同伴运行时](./companion-runtime.md)、[领域事件与事件日志](./domain-events-and-journal.md)

## 1. 目的

本文定义 v0.1 中主同伴模型与确定性运行时之间的实现级边界：运行时怎样组成一次有来源、有预算的上下文，模型怎样提出语言、活动、意图、动作和记忆效果，以及运行时怎样验证和提交这些效果。

协议的结构用于保证真实、可取消、可审计的执行，不编码同伴的性格、关系风格或固定任务树。人格仍来自自然语言同伴档案、共同经历和当前情境。

## 2. 范围与非目标

本文负责：

- `ContextPackageV1` 和上下文片段的来源、信任、预算与截断元数据。
- `CompanionDecisionV1` 的完整结构。
- 模型调用、结构校验、修复、过期拒绝和效果提交。
- 动作依赖图、动作组原子预检及语言承诺的依赖。
- collect、steer、interrupt 和 follow-up 的模型运行语义。
- 提示注入边界和可观察性要求。

本文不负责具体模型厂商、技能内部执行、完整记忆算法，也不保存或展示模型的私有思维链。

## 3. 核心不变量

1. 模型输出是提议，不是事实，也不直接修改状态。
2. 决策只适用于它声明的 run、上下文版本和世界前提。
3. 同一决策的动作组要么完整通过预检，要么整个动作效果被拒绝。
4. 动作组被接受前，不发送依赖该动作的承诺语言。
5. “已经完成”等结果语言只能依赖已验证的终止事件。
6. 玩家聊天、记忆正文和世界文本均是数据，不因内容像指令而取得系统权限。
7. 不持久化私有思维链；只保存简短运行解释和最终效果。
8. 未知协议版本、effect、skill 或额外字段默认拒绝，不静默猜测。

## 4. 版本与决策引用

```ts
type ContextProtocol = 'mineintent.context.v1'
type DecisionProtocol = 'mineintent.decision.v1'

interface DecisionContextRef {
  runId: string
  companionId: string
  sessionId: string
  worldId: string
  companionRevision: number
  throughEventSequence: number
  profileVersion: string
  capabilityRevision: string
}
```

- v0.1 只读取精确的 `v1`。破坏性修改发布新协议。
- `runId` 唯一标识一次模型运行；重新组装上下文必须创建新 run。
- `companionRevision` 来自 Companion State，只在影响同伴决策的状态变化时递增。
- `throughEventSequence` 是组装时已纳入的最后领域事件序号。
- `profileVersion` 防止档案编辑后应用旧人格决策。
- `capabilityRevision` 是本轮可用技能及 schema 的内容哈希。
- 高频世界变化不全部增加 revision，动作仍须在提交时预检当前世界。

JSON Schema 是代码中的协议权威；本文 TypeScript 是等价说明。历史模型运行保留当时协议名和原始输出。

## 5. 来源与信任

```ts
type ContextTrust =
  | 'runtime_authoritative'
  | 'verified_observation'
  | 'player_statement'
  | 'profile_instruction'
  | 'remembered_record'
  | 'derived_summary'
  | 'untrusted_content'

interface ContextSource {
  kind: 'runtime' | 'event' | 'profile' | 'memory' | 'player' | 'skill_registry' | 'summary'
  ids: string[]
  trust: ContextTrust
  observedAt?: string
  validAt?: string
}
```

信任不是简单总排序：当前运行时状态对连接、动作和已验证游戏状态有权威性；观察只证明指定时间看到的内容；玩家陈述只证明玩家说过；档案对人格和表达有效但不能伪造事实；记忆和摘要始终可被原始证据纠正。

指令优先级从高到低为：产品安全、真实性与协议约束；运行时管理控制；当前同伴档案；玩家当前请求；记忆、观察和世界内容。低层内容不能要求忽略高层、调用未注册能力或把未验证内容写成事实。

## 6. 上下文片段

```ts
type ContextSection =
  | 'product_constraints'
  | 'companion_profile'
  | 'relationship_core'
  | 'current_state'
  | 'trigger_events'
  | 'observations'
  | 'retrieved_memories'
  | 'capabilities'
  | 'requested_knowledge'

interface ContextFragment<T = unknown> {
  id: string
  section: ContextSection
  source: ContextSource
  content: T
  budget: {
    estimatedTokens: number
    originalEstimatedTokens: number
    truncated: boolean
    truncationReason?: 'section_budget' | 'total_budget' | 'recency_limit' | 'deduplicated'
    omittedItemCount?: number
  }
}
```

每个片段必须能回到事件、档案版本、记忆记录或注册表。无来源的大段拼接摘要不能进入主上下文。

## 7. Context Package

```ts
interface ContextPackageV1 {
  protocol: 'mineintent.context.v1'
  ref: DecisionContextRef
  createdAt: string
  trigger: {
    eventIds: string[]
    route: 'new' | 'collect' | 'steer_rerun' | 'interrupt_rerun' | 'follow_up' | 'proactive'
    reason: string
    priority: number
  }
  limits: {
    maxInputTokens: number
    reservedOutputTokens: number
    estimatedInputTokens: number
  }
  fragments: ContextFragment[]
  omissions: Array<{ section: ContextSection; reason: string; count?: number }>
}
```

### 7.1 固定组装顺序

1. 不可截断的产品约束。
2. 当前同伴档案；核心档案超预算视为配置错误，不自行改写人格。
3. 主要玩家和关系核心：稳定称呼、明确边界和重要约定。
4. 当前 Companion State：活动、注意、对话、意图、动作和控制状态。
5. 触发事件：保留原始结构和必要文本。
6. 当前认知观察：只含同伴合理可感知的信息。
7. 检索记忆：附记录 ID、来源、状态、置信度和证据摘要。
8. 当前能力目录：skill、参数、限制和可靠性摘要。
9. 运行时批准的按需知识。

### 7.2 预算与截断

- 先应用分节条目和 token 子预算，再应用总预算。
- 产品约束、档案核心、当前控制状态和触发事件不可静默丢弃。
- 对话保留最近未解决轮次；较旧轮次使用有来源摘要。
- 观察按显著性和新近度裁剪，不补入未见信息。
- 记忆逐条裁剪，不能丢失 ID、状态、来源和置信度。
- 只列本轮相关能力；模型不能凭旧记忆调用未列出的 skill。
- 所有截断和遗漏必须出现在元数据中。
- 必需片段仍超总预算时以 `context_budget_exceeded` 失败，不发送残缺请求。

相同投影、事件序列、档案、检索结果和预算应产生稳定顺序、内容等价的上下文。密钥、令牌、私有绝对路径、原始协议缓存和管理凭证永不进入上下文。

## 8. Decision Contract

```ts
interface CompanionDecisionV1 {
  protocol: 'mineintent.decision.v1'
  runId: string
  context: DecisionContextRef
  summary: string
  effects: DecisionEffect[]
}

interface EffectBase {
  id: string
  kind: string
}
```

`summary` 是最多 240 字符的运行解释，不是思维链、事实或执行指令。effect ID 在同一决策内唯一，只允许字母、数字、`-`、`_`，长度 1–64。

## 9. 语言效果

```ts
interface SpeechEffect extends EffectBase {
  kind: 'speech'
  text: string
  audience: { kind: 'primary_player' | 'nearby_players'; playerIds?: string[] }
  timing: 'now' | 'after_actions_accepted' | 'after_action_terminal'
  dependsOn?: string[]
  terminalCondition?: 'completed' | 'failed' | 'cancelled' | 'any'
  purpose: 'reply' | 'acknowledge' | 'coordinate' | 'report' | 'social' | 'ask'
}
```

- `now` 不能包含未获准动作的确定承诺或未验证结果。
- `after_actions_accepted` 只能依赖 action effect。
- `after_action_terminal` 必须引用一个 action 并声明终止条件。
- 发送前仍检查玩家在线、节流、长度和高压力时机。
- 具体结果通常由终止事件触发新决策，不能在动作开始前猜测。

## 10. 活动与意图效果

```ts
interface ActivityEffect extends EffectBase {
  kind: 'activity'
  operation: 'propose' | 'activate' | 'update' | 'pause' | 'complete' | 'abandon'
  activityId?: string
  expectedRevision?: number
  summary?: string
  companionContribution?: string
  agreedFacts?: string[]
  openQuestions?: string[]
  reason: string
  evidenceEventIds: string[]
}

interface IntentEffect extends EffectBase {
  kind: 'intent'
  operation: 'set' | 'replace' | 'clear'
  intentId?: string
  expectedRevision?: number
  summary?: string
  reason: string
  activityId?: string
  completionSignals?: string[]
  invalidationSignals?: string[]
}
```

新活动由运行时分配 ID；修改必须携带对象 ID 和 expected revision。`complete`、`abandon` 不能仅凭漂移推断，需确认或明确事件。意图只描述近期打算；完成和失效信号是可观察标签，不能嵌入代码。

## 11. 动作组

```ts
interface ActionGroupEffect extends EffectBase {
  kind: 'action_group'
  mode: 'atomic_preflight'
  actions: Array<{
    id: string
    skill: string
    args: Record<string, unknown>
    purpose: string
    after: string[]
    onDependencyFailure: 'cancel'
  }>
}
```

规则：

- action ID 唯一，`after` 只能引用同组 action，依赖图必须无环。
- 数组顺序没有执行含义。
- skill 必须出现在本轮能力片段，参数必须通过对应 schema。
- 无依赖且身体资源冲突的动作使整组预检失败。
- v0.1 每组最多一个主要身体动作，可附可并行表达动作。
- 不允许模型要求“尽量执行剩下的”。

`atomic_preflight` 表示所有动作在启动前一起通过结构、依赖、能力、前置条件和资源可调度性检查，不表示 Minecraft 世界事务可以回滚。启动后的失败、取消和副作用逐项记录，下游依赖统一取消。

```ts
interface ActionGroupRejection {
  groupEffectId: string
  code:
    | 'unknown_skill'
    | 'invalid_args'
    | 'missing_dependency'
    | 'dependency_cycle'
    | 'resource_conflict'
    | 'precondition_failed'
    | 'capability_revision_changed'
  actionId?: string
  detail: string
}
```

## 12. 记忆候选与后续关注

```ts
interface MemoryCandidateEffect extends EffectBase {
  kind: 'memory_candidate'
  memoryKind: 'episode' | 'world_fact' | 'player_preference' | 'relationship' | 'commitment' | 'procedural'
  content: string
  sourceClaim: 'player_stated' | 'observed' | 'derived'
  evidenceEventIds: string[]
  subjects: string[]
  placeIds?: string[]
  activityId?: string
  confidence: number
  validAt?: string
}

interface AttentionEffect extends EffectBase {
  kind: 'next_attention'
  waitFor: Array<'player_message' | 'action_progress' | 'action_terminal' | 'world_event' | 'natural_opportunity'>
  focus: string
  actionIds?: string[]
  earliestProactiveAt?: string
  expiresAt?: string
}
```

记忆候选不直接落入长期记忆；Memory System 校验证据、分类、重复和冲突。模型不能创建 profile 来源或 verified 状态。承诺候选必须能关联已发送语言或玩家明确话语。

每个决策最多一个 next attention。它只是给 Router 的建议，不建立无限模型循环，也不能压过玩家消息、危险和管理控制。

## 13. 组合限制

```ts
type DecisionEffect =
  | SpeechEffect
  | ActivityEffect
  | IntentEffect
  | ActionGroupEffect
  | MemoryCandidateEffect
  | AttentionEffect
```

- 最多一个 activity、intent、action group 和 next attention。
- 可有多个 speech 和 memory candidate，但受数量和文本长度限制。
- 只有 speech 可通过 `dependsOn` 引用 action；状态效果按固定阶段提交。
- effect ID 不作为跨决策长期 ID；持久对象由运行时分配。
- 空 `effects` 合法，表示有意识地观察；仍须给出 summary。

## 14. Model Provider 与输出修复

```ts
interface ModelProvider {
  runDecision(input: {
    context: ContextPackageV1
    outputSchema: object
    signal: AbortSignal
  }): Promise<{
    rawOutput: unknown
    provider: string
    model: string
    usage?: { inputTokens?: number; outputTokens?: number }
  }>
}
```

优先使用厂商 structured output；不支持时可回退为 JSON 文本，但经过同一严格校验。Provider 只处理传输、鉴权、取消和格式差异，不应用业务效果。

解析顺序为严格 JSON、schema、引用与语义校验。禁止用正则从 Markdown “尽量提取” JSON。结构失败允许至多一次修复调用；修复只接收验证错误、原始输出和同一 schema，不增加世界上下文，仍绑定原 run。再次失败产生 `model.decision.invalid`，不应用效果。

超时、取消、拒绝和限流分别记录。故障兜底不能假装模型理解了消息或动作已开始。

## 15. 过期判定

Coordinator 在模型返回和提交前检查：

1. `runId` 是否仍是当前可提交 run。
2. companion、session、world 是否一致。
3. companion revision 是否相同。
4. profile 和 capability revision 是否相同。
5. 是否有晚于 `throughEventSequence` 的阻断事件。
6. 每个动作实时前置条件是否仍成立。

阻断事件包括明确停止、死亡/重生、断线/维度切换、活动或意图 revision 改变、暂停、主要玩家身份变化和更高优先级危险。无关普通观察不应只因 sequence 增长误杀决策，但动作仍重新预检。

过期时所有状态、动作和记忆效果均不应用，语言也不从旧结果摘取发送；如仍需回答则新建 run。系统产生 `model.decision.discarded_as_stale` 并记录 guard 差异，由 Router 决定是否重跑。

## 16. Decision Coordinator

```text
1. 校验协议、schema、ID、引用和数量
2. 校验 run 与 freshness guards
3. 校验 activity / intent 状态转换
4. 对 action group 做原子预检并预留调度资格
5. 校验 speech 依赖和真实性时机
6. 形成不可变 Application Plan
7. 提交 activity / intent
8. 提交 action group，取得 accepted 或 rejection
9. 只发送依赖条件已满足的 speech
10. memory candidate 进入候选队列
11. 更新 next attention
12. 记录每项 accepted / rejected / deferred
```

不同种类效果可以部分接受，例如证据不足的记忆候选被拒绝，而不依赖动作的正常回复仍发送；动作组内部不可部分预检通过。计划形成后若出现停止、断线或危险抢占，未提交效果停止提交，已启动动作按正常取消语义处理。

```ts
interface DecisionApplicationResult {
  runId: string
  contextRevision: number
  status: 'applied' | 'partially_applied' | 'rejected' | 'stale'
  effects: Array<{
    effectId: string
    status: 'accepted' | 'rejected' | 'deferred' | 'cancelled_before_commit'
    code?: string
    producedIds?: string[]
  }>
}
```

## 17. 运行中事件

- `collect`：只在尚未发起调用的短聚合窗口加入事件。
- `steer`：取消请求或标记旧结果不可提交，加入新事件并创建新 run/context；语义上仍是同一话题的修改。
- `interrupt`：同样取消并重跑，但表示高优先级事件替换当前关注。
- `follow_up`：提交阶段无法安全取消时排队，完成后以最新状态新建 run。
- `observe`：只更新投影，不调用模型。

v0.1 不假设厂商支持真正的运行中上下文注入。因此 steer 明确实现为取消旧推理并重新运行。无法网络取消的迟到结果因 run ID 不匹配拒绝。重跑必须使用新 run、revision 和事件集合。

## 18. 提示注入与权限

- 系统提示明确标记片段来源和数据边界。
- 玩家可要求同伴改变做法，但不能通过聊天提升为管理控制或绕过动作 schema。
- 书、告示牌、物品名、服务器消息、记忆和外部文本永远不解释为系统指令。
- 档案可编辑人格，但不能关闭真实性、证据、停止、安全和权限约束。
- 能力目录是唯一可调用 skill 集合。
- 模型不能请求任意代码、shell、文件或网络访问。

## 19. 事件与审计

至少记录：

- `model.context.composed`：ref、触发、每节 token、来源、截断和遗漏。
- `model.decision.started`：run、provider、model、deadline。
- `model.decision.cancelled`：steer、interrupt、stop 或 timeout。
- `model.decision.invalid`：schema 错误和修复次数。
- `model.decision.finished`：usage、耗时和输出哈希。
- `model.decision.discarded_as_stale`：guard 的期望与实际值。
- `model.decision.application_planned`：效果和动作预检。
- `model.decision.applied`：逐效果结果和产生的领域对象 ID。

原始输出可按本地调试策略保存，但不是状态恢复的事实来源。恢复只重放已提交后产生的领域事件。

## 20. 实现接口

```ts
interface ContextComposer {
  compose(request: {
    runId: string
    triggerEventIds: string[]
    route: ContextPackageV1['trigger']['route']
    limits: ContextPackageV1['limits']
  }): Promise<ContextPackageV1>
}

interface DecisionValidator {
  parse(raw: unknown): CompanionDecisionV1
  validateSemantics(decision: CompanionDecisionV1, context: ContextPackageV1): void
}

interface DecisionCoordinator {
  preflight(decision: CompanionDecisionV1): Promise<ApplicationPlan>
  apply(plan: ApplicationPlan): Promise<DecisionApplicationResult>
}
```

建议位置为 `src/context/`、`src/models/contracts/v1.*` 和 `src/companion/decision-coordinator.ts`。TypeScript 类型应从运行时 schema 推导，防止类型与 JSON Schema 漂移。

## 21. 测试与验收

### Schema 与上下文

- 六类效果均可解析，未知字段、枚举、重复 ID 和错误引用拒绝。
- 相同输入产生稳定片段顺序和内容等价结果。
- 每个片段保留来源、信任、原始/实际 token 和截断信息。
- 必需内容超预算失败，不静默丢弃。
- 恶意记忆或世界文本不能改变指令优先级或调用未注册技能。

### 过期、动作和语言

- 推理期间改变活动、编辑档案、停止或断线，旧结果全部拒绝。
- 无关普通观察不会误杀仍适用决策。
- steer 创建新 run，迟到结果拒绝。
- 缺依赖、环、资源冲突、未知 skill、无效参数使整个动作组拒绝。
- 动作组拒绝时承诺语言不发送；不依赖动作的社交回复可正常发送。
- “完成”语言只由已验证结果触发。

### 记忆与审计

- 无证据事实候选被拒绝，不影响其他合法效果。
- 每个接受效果能追到 context、run、触发事件和领域事件。
- 重启不重放模型原始输出或重复应用未提交计划。

## 22. v0.1 完成定义

1. 两个协议有严格运行时 schema。
2. “一起收集木头”能表达回复、活动、意图、动作组、记忆候选和等待条件。
3. 过期、steer 重跑和动作组拒绝有自动测试。
4. 动作预检失败不会发送虚假承诺。
5. 调试轨迹可显示上下文来源、预算、截断和逐效果结果。

