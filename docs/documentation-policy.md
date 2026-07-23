---
status: proposed
authority: informative
implementation: not-applicable
last_verified: 2026-07-23
---

# 文档治理规则

> 本文是本次文档重组提出的候选治理规则，校验脚本已在本地分支执行，但它尚未通过提交、PR 合并或单独决策成为仓库规范。若本次重组被明确接受，应在同一合并中将本文改为 `accepted + normative`；在此之前它不能反向覆盖既有 accepted 决定。

本规则解决一个具体问题：MineIntent 同时有长期愿景、已接受决定、已实现代码、实验分支、设计反思和历史资料。它们都值得保存，但不能都自称“当前权威”。

## 必填元数据

`docs/` 下的项目文档在标题前使用 YAML front matter：

```yaml
---
status: proposed
authority: informative
implementation: partial
last_verified: 2026-07-23
---
```

若文档只适用于特定分支或提交，还必须添加：

```yaml
applies_to: codex/trustworthy-passive-context@57d438e
```

## `status`

| 值 | 含义 |
|---|---|
| `accepted` | 已经过明确决策流程，当前仍有效 |
| `proposed` | 候选方案或开放问题，尚不能约束实现 |
| `experimental` | 已在代码或测试中试做，但尚未成为接受基线 |
| `historical` | 保存过去的事实或方案，不描述当前要求 |
| `reference` | 操作手册、状态快照、调研或接口的人类可读视图 |

“PR 已合并”通常是接受证据，但不是自动规则；若 PR 自己声明仍待决策，仍应标为 `proposed`。直接提交到分支或 `main` 证明“实现存在”，不自动证明方向已接受。

## `authority`

| 值 | 含义 |
|---|---|
| `normative` | 在自身范围内规定产品或架构必须怎样 |
| `informative` | 报告事实、解释候选方案或保存证据 |

只有 `accepted + normative` 可以作为长期约束。`proposed`、`experimental` 和 `historical` 文档必须是 `informative`。

## `implementation`

| 值 | 含义 |
|---|---|
| `current` | 所述能力在 `applies_to` 指定基线上存在并已核对 |
| `partial` | 只有文档的一部分被实现 |
| `planned` | 已接受，但实现尚未开始或尚未达到契约 |
| `stalled` | 已接受计划因依赖、优先级或路线重开而停滞 |
| `diverged` | 已接受文档和当前实现发生实质漂移，尚未正式协调 |
| `retired` | 过去存在或曾被提出，现在不再是活动实现路线 |
| `not-applicable` | 愿景、治理或纯研究材料没有实现状态 |

## 变更规则

### 产品或架构方向变化

1. 先在 GitHub Discussion 或 proposal Issue 中陈述问题、证据和选项。
2. 将探索性文本放入 `proposals/`，标为 `proposed + informative`。
3. 形成结论后，在 PR 中新增或修改 ADR，并同步受影响的产品、架构、状态和路线图文档。
4. 接受后才把提案内容迁入 `accepted + normative` 文档；原提案保留结论和去向，不删除讨论历史。

### 实验代码

1. 在 `experiments/` 中写清基线提交、问题假设、能力边界和验证结果。
2. 不把 capability catalog、README 或里程碑写成实验已经成为产品能力。
3. 实验若被接受，必须有明确 ADR/PR；若被放弃，改为 `historical` 或移入 `archive/`。

### 当前状态

涉及代码能力、分支、测试和 Issue 的事实变更时，必须更新：

- [`current-status.md`](./current-status.md)
- [`architecture/current-system.md`](./architecture/current-system.md)
- 相关实验或操作指南
- 必要时更新 [`document-register.md`](./document-register.md)

## 冲突处理

- 代码与参考文档冲突：先修参考文档；若代码违背 accepted ADR，同时登记架构漂移。
- 两份 accepted 文档冲突：不能凭日期自行覆盖，必须通过 ADR 明确 supersede 或 amend。
- 提案与 accepted 文档冲突：保留冲突，直到决策完成。
- 历史文档使用“当前”“现行”等词时：在文首加醒目历史说明，不必篡改原始正文语气。
- Issue/Milestone 与代码冲突：状态文档同时记录两者，不能用其中一方假装另一方不存在。

## 文档完成定义

一次改变产品、协议、模块边界或里程碑的 PR，只有同时满足以下条件才算文档完整：

- 状态和 authority 明确；
- 当前实现与目标设计分开描述；
- 链接没有断裂；
- 已接受、实验、提案和历史材料没有混在同一叙述层；
- 关键结论能够追溯到代码、测试、Issue、PR、ADR 或研究来源；
- 被替代的高价值思考有归档位置和去向说明。
