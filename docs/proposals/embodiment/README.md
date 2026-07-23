---
status: proposed
authority: informative
implementation: not-applicable
last_verified: 2026-07-23
---

# 具身架构提案入口

当前模型—身体接口尚未决定。请按以下顺序阅读：

1. [当前系统实况](../../architecture/current-system.md)：先了解实际代码。
2. [架构反思](./architecture-reflection.md)：理解为何提出短动作/信息 Tool Loop。
3. [决策登记册](./decision-register.md)：查看反思中的事实修正、基线冲突和 D01–D40 未决项。
4. [接口清单](./interface-inventory.md)：查看早期协议/输入审计和已经撤回的逐 tick 控制结论。
5. [可信注视实验](../../experiments/trustworthy-gaze.md)：查看当前 Grounding/Behavior 路线实际证明了什么。

当前准确状态：

- no-tool Decision V2 已实现为实验，尚未被 Tool Loop 正式替代；
- Grounding 和 Behavior 已运行一个 gaze operator，尚未被接受为长期架构；
- Action Runtime 的 v0.1 实现已删除，但 ADR 0003 尚未被 supersede；
- Motor 和结果证据边界有保留价值；
- 移动、交互、物品选择、主动性和完整记忆均未解决。

任何新方案都应先回答登记册中的根决策，而不是再增加一份默认自称“实现基线”的长文档。
