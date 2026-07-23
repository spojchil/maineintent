---
status: reference
authority: informative
implementation: current
last_verified: 2026-07-23
applies_to: main@53ebc57 + codex/trustworthy-passive-context@57d438e
---

# 当前项目状态

本文只报告事实，不替项目做尚未完成的架构决定。它刻意把“默认分支”“最新代码实验”和“已接受设计”分开。

## 基线

| 基线 | 提交 | 含义 |
|---|---|---|
| 默认分支 `main` | [`53ebc57`](https://github.com/spojchil/maineintent/commit/53ebc5797f970c791a03c97b0d83c6c80a5c36ae) | GitHub 默认展示和现有成功 CI 所在位置 |
| 最新代码实验 `codex/trustworthy-passive-context` | [`57d438e`](https://github.com/spojchil/maineintent/commit/57d438e167e7b66408f239369979dad2fd90f975) | 比 `main` 多 22 个提交；包含 V2 决策、Grounding、Behavior 和可信注视实验 |
| 本次文档重组 | 基于 `57d438e` 的本地分支 | 不改产品 runtime；整理文档并新增文档校验脚本/CI hook；尚未推送或创建 PR |

截至核对日期，最新代码实验没有关联 PR、GitHub Actions run 或 commit status。因此它是“最新实现”，不是“最新接受架构”。

## 当前能力矩阵

下表中的“当前”默认指最新代码实验；`main` 不包含最后 22 个实验提交。

| 能力 | 状态 | 事实边界 |
|---|---|---|
| Mineflayer 连接、生命周期和快照 | 当前 | 可连接 Paper/Minecraft 1.21.1，并提供协议与身体状态底座 |
| 被动 `current_status` | 当前 | 生命、饥饿、氧气、经验和状态效果 |
| 被动背包读取 | 当前 | 当前选择槽和有界物品槽信息 |
| 被动声音读取 | 当前 | 最近声音的简化投影；不等于归档设计中的完整声音/生命周期模块 |
| 被动第一人称视口 | 当前但有限 | 站立方块、准星方块、视锥/遮挡后的实体与方块；一次完整方块读取会遍历 `65 × 65 × 41 = 173,225` 个候选格，再做邻面/遮挡工作，有明确性能风险 |
| Information Runtime | 当前但部分 | 契约声明 17 个 interface ID，生产只注册并固定读取其中 4 个；Registry、Access Policy、Help/Read、Ref/Cursor 与预算主体存在，生产 trace 使用默认 no-op sink |
| model-facing Information tool loop | 不存在 | ToolSession 和适配契约有代码/测试，但未注册给生产模型 |
| Python Agent Service | 当前 | 一次 OpenAI-compatible Chat Completions 调用，使用 `json_object`，只负责传输和 prompt |
| `ContextPackageV2` / `CompanionDecisionV2` | 实验实现 | TypeScript schema 是业务权威；严格绑定本轮 context |
| Grounding | 实验实现但有限 | 可绑定本轮 viewport block/entity ref；`message_referent` 只验证表达式出现在消息中，随后一律绑定消息发送者，所以“这棵树/那里”也会错误指向说话者 |
| Behavior Synthesizer | 实验实现但仅一个 operator | 只支持 `self.attention_includes`，即建立视觉共同注意 |
| Controller / 生产 Motor 路径 | 实验实现但仅注视 | 可渐进转向、有限扫描、取消、超时和结果阶段可见性复查；没有强制感知 revision 前进，底层 Motor 虽有 `dig` 但无生产调用方 |
| 移动 | 未接入 | Capability Catalog 声称有 locomotion，但生产 Behavior 没有对应 controller |
| 挖掘/攻击/使用物品 | 未接入 | 底层 driver 仍有少量原语，例如 `dig`，但没有生产消费者 |
| 选择物品栏 | 未接入 Behavior | 不能把 catalog 描述当作已上线能力 |
| 跟随、采木、Pathfinder | 已从最新实验删除 | v0.1 曾实现；现在只保留于历史和 Git 记录 |
| 游戏聊天和发送调度 | 当前但有真实性缺口 | 支持即时、接受后、终止后话术及取消；缺少 Claim Policy，模型仍可把无依据完成断言放进即时文本；终态条件不匹配的队首条目还可能阻塞后续话术 |
| 共同活动和意图状态 | 部分 | 有状态与效果处理，不构成长周期活动规划器 |
| 长期记忆 | 最小原型 | JSON 文件、证据 ID、关键词重合和时间衰减检索；没有冲突、纠正、整合、遗忘或语义关系模型 |
| 主动陪伴 | 未实现 | 契约含 `earliestProactiveAt`，运行时没有 idle/proactive 调度消费者 |
| 危险反射 | 最小停止 | 低生命时取消当前模型/行为、释放输入并警告；不会逃跑或防御 |
| 本地调试接口 | 当前但需视为敏感 | 仅绑定本机且只读；按字段/常见凭证形状脱敏，但供应商错误摘要没有通用 secret scrub |
| Paper 场景 | 有场景代码，缺最新运行证据 | 可信注视场景使用确定性 `PrototypeScenarioModel` 和 `message_referent`，既不是实际 DeepSeek 端到端证明，也没有覆盖 `context_ref` 路径；最新分支没有 Actions/Paper run |

## 当前生产链路

```text
Minecraft / Mineflayer
  → 可信 source ports
  → 四个固定被动 Information Reads
  → ContextPackageV2
  → Python Agent Service 的一次模型调用
  → TypeScript DecisionProtocolDispatcher
      ├→ speech / activity / intent / memory effects（大多在行为启动前应用）
      └→ embodied_intent
          → Grounding
          → BehaviorSynthesizer
          → VisualAttentionController
          → Motor.look
          → 结果阶段可见性复查与 outcome evidence（未强制新 revision）
          → 依赖终态的 speech
```

代码与确定性测试演示了“信息、语义指代、身体动作和结果证据可以共享同一事实基础”。这不是最新提交的真实 Paper/DeepSeek 运行证据，也没有证明当前中间层就是长期正确抽象或同伴已经具备通用身体能力。

更详细的模块说明见[当前系统实况](./architecture/current-system.md)。

## 已接受决定与实现漂移

| 决定 | 决策状态 | 实现状态 |
|---|---|---|
| ADR 0001：第一版使用 Mineflayer | accepted | 基本一致 |
| ADR 0002：事件驱动持续同伴 | accepted | 部分实现；主动机会和完整多通道运行时尚缺 |
| ADR 0003：分离心智与 Action Runtime | accepted | **diverged**；最新实验已删除独立 Action Runtime |
| ADR 0004：不执行模型任意代码 | accepted | 一致；当前接口比 ADR 描述的 skill 面更窄 |
| ADR 0005：Mineflayer 只作协议驱动 | proposed | 部分实验实现，尚未正式接受 |
| PR #71：原版玩家可信性为长期目标 | accepted | 只完成一个很窄的可信注视切片 |

## 路线图和 GitHub Tracker 的滞后

- v0.1 milestone 是历史上 11/11 完成，不代表最新分支仍保有全部 v0.1 能力。
- v0.2 仍有 10 个 open Issue；五个“实现就绪”设计 PR #64、#65、#66、#68、#69 已于 2026-07-21 关闭并归档。
- v0.3 的 17 个 Issue 仍全部 open，但最新实验已经越过原定门槛实现了一部分 Grounding 和 gaze。
- Issue #41 要求 ADR 0005 接受后再固化 P1 以后边界；实际实验先发生了。
- Issue #43 的统一语言事实门控仍未实现。
- Issue #63 的 Cursor scope 问题仍 open；若最终取消模型分页，它的范围可能改变，但现在不能假装已经解决。

旧阶段文件保留在 [`roadmap/`](./roadmap/README.md)，但不应直接用作当前排期。

## 验证状态

在 2026-07-23 对 `57d438e` 的本地核验：

- Node 24：TypeScript 检查通过，123/123 测试通过。
- 本次新增文档检查在 Node 24 和 Node 22.23.1 均通过：54 份 `docs/` 文档的元数据、相对链接和登记表一致。
- Python 3.12：11/11 测试通过。
- Node 22.23.1（满足项目声明的 `>=22`）：TypeScript 检查通过；测试为 122 pass、1 cancelled，进程退出 1。
- 取消项是 `visual-attention-controller.test.ts` 的 deadline 场景；本次审计诊断为 `AbortSignal.timeout()` 的 unref timer 在 Node 22 测试进程没有其他活跃 handle 时不会保持事件循环。

因此，最新实验分支当前不能声称通过仓库声明基线的完整 CI。默认分支最近一次 GitHub CI 成功记录见 [Actions run #29851997169](https://github.com/spojchil/maineintent/actions/runs/29851997169)。

## 尚未做出的根本决定

当前最核心的问题不是“哪份文档更新得最晚”，而是模型—身体接口仍未定：

- 保留当前语义目标 → Grounding → Behavior 分层，还是改成短时身体 Tool Loop？
- Information 采用固定被动读取、主动工具读取，还是混合模式？
- 独立 Action Runtime 是恢复、改名为内部控制面，还是由 controller/dispatcher 完全取代？
- 结果协议如何同时表达终止原因、实际效果和观察事实？
- 哪些 ref 需要保留为内部执行句柄，哪些不应暴露给模型？

这些问题的事实修正和选项编号记录在[具身决策登记册](./proposals/embodiment/decision-register.md)。在明确决策以前，[架构反思](./proposals/embodiment/architecture-reflection.md)不能覆盖现有接受基线。
