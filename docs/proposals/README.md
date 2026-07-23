---
status: reference
authority: informative
implementation: not-applicable
last_verified: 2026-07-23
---

# 开放提案

这里保存值得继续讨论、但尚未成为 MineIntent 接受基线的设计。提案可以挑战 accepted 文档，却不能在决策完成前静默覆盖它。

## 具身接口

- [具身提案入口](./embodiment/README.md)
- [架构反思与工具接口草案](./embodiment/architecture-reflection.md)
- [矛盾与未决策登记册](./embodiment/decision-register.md)
- [具身能力与接口清单](./embodiment/interface-inventory.md)：包含事实审计，也包含已经撤回的控制契约，按历史材料阅读。

## 感知与信息

- [信息提案入口与保留原则](./information/README.md)
- [2026-07-14 五份未接受设计档案](../archive/proposals/2026-07-14-information/README.md)

认知感知和记忆的长期方向已经被接受，但实现仍不完整，分别见[认知感知模型](../architecture/cognitive-perception.md)和[记忆模型、档案版本与冲突协调](../architecture/memory-model-and-profile-versioning.md)。这里保存的是对它们的修订建议，而不是重复一份“当前设计”。

## 从提案形成决定

1. 在 Discussion 或 proposal Issue 中拆清事实、价值冲突和选项。
2. 若只是验证假设，建立 `experiments/` 文档并记录分支和测量结果。
3. 形成决定后写 ADR，明确接受、修订或替代哪些旧决定。
4. 同一 PR 更新当前状态、架构文档、路线图和测试依据。
