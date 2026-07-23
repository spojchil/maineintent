---
status: reference
authority: informative
implementation: diverged
last_verified: 2026-07-23
---

# 阶段路线图

阶段计划把产品与系统设计转换为按依赖排序、可验收的里程碑工作。长期决定记录在 [`decisions/`](../decisions/README.md)，模块契约记录在 [`architecture/`](../architecture/README.md)。

| 计划 | GitHub 状态 | 代码现实 |
|---|---|---|
| [v0.2：合法信息与界面接口](./v0.2-legal-information-interfaces.md) | milestone 仍 open | Information Runtime 和四个简化 provider 已存在；五个详细设计 PR 已归档，计划已经停滞/漂移 |
| [v0.3：可信具身闭环](./v0.3-trustworthy-embodiment.md) | 17 个 Issue 仍 open | 最新实验已经实现部分 Grounding/gaze，却越过了原计划的 ADR 接受门 |

这两份计划都曾通过 PR 成为接受路线图，但 GitHub tracker 没有吸收 2026-07-21 以后的实现。它们现在是待协调的基线，不是可靠排期。实际能力见[当前项目状态](../current-status.md)，根本决策见[具身登记册](../proposals/embodiment/decision-register.md)。
