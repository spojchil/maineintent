---
status: reference
authority: informative
implementation: not-applicable
last_verified: 2026-07-23
---

# MineIntent 文档入口

这里是 MineIntent 的文档真相入口。文档不再按“写得早或写得长”决定权威，而按用途和状态分层。

第一次阅读建议依次打开：

1. [当前项目状态](./current-status.md)：代码现在到底能做什么，哪些只是实验。
2. [产品设计](./vision/product-design.md)：项目为何存在，以及长期不应丢失的体验目标。
3. [当前系统实况](./architecture/current-system.md)：最新实验分支的真实运行链路。
4. [架构决策记录](./decisions/README.md)：已经接受、仍在提议或实现已漂移的长期决定。
5. [开放提案](./proposals/README.md)：尚未形成决定的矛盾、反思和候选接口。
6. [项目演进史](./history/project-evolution.md)：理解项目为何从 v0.1 走到现在。

## 文档分区

| 分区 | 回答的问题 | 能否覆盖已接受决定 |
|---|---|---|
| [`vision/`](./vision/README.md) | 我们想做什么产品？ | 仅限明确标为 `accepted` 的产品原则 |
| [`architecture/`](./architecture/README.md) | 当前系统如何运行？目标架构是什么？ | 只有 `accepted + normative` 文档可以 |
| [`decisions/`](./decisions/README.md) | 哪项长期决定被正式接受？ | 可以；ADR 状态优先于普通设计稿 |
| [`proposals/`](./proposals/README.md) | 现在还在争论什么？ | 不可以 |
| [`experiments/`](./experiments/README.md) | 哪些代码已经试做但尚未被接受？ | 不可以 |
| [`roadmap/`](./roadmap/README.md) | 旧里程碑如何描述、哪里已经失真？ | 不可以替代 ADR 或代码事实 |
| [`guides/`](./guides/README.md) | 怎样运行和验证当前代码？ | 不可以 |
| [`reference/`](./reference/README.md) | 当前接口或组件的精确形状是什么？ | 代码 schema 仍是最终权威 |
| [`research/`](./research/README.md) | 结论依据来自哪里？ | 不可以 |
| [`history/`](./history/README.md) | 项目为何演进到现在？ | 不可以；只解释来路 |
| [`archive/`](./archive/README.md) | 过去认真考虑过什么？ | 不可以 |

`docs/` 下除登记表自身外的逐文件分类见[文档登记表](./document-register.md)，状态字段和更新流程见[文档治理规则](./documentation-policy.md)。

## 真相优先级

发生冲突时，先判断问题属于哪一类：

1. **“程序现在实际做什么？”** 以目标分支的代码、schema、测试和真实运行证据为准；[当前项目状态](./current-status.md)负责把事实翻译成人话。
2. **“项目已经决定以后应怎样？”** 以 `accepted + normative` 的产品文档和 ADR 为准。
3. **“正在尝试什么？”** 看 `experimental` 文档和对应分支；实现存在不等于设计已接受。
4. **“可能改成什么？”** 看 `proposed`；提案不能静默覆盖已接受决定。
5. **“以前为何这么做？”** 看 `historical` 和项目演进史。

因此，“最新 commit”“已经合并”“文档写得很完整”和“正式接受”是四件不同的事。

## 当前最重要的阅读警告

- 默认分支 `main` 与最新实验分支并不相同。
- v0.1 曾经完成采木、跟随和 Action Runtime 闭环，但最新实验分支已经删除这些实现。
- ADR 0003 仍然是 accepted，最新实验实现却没有独立 Action Runtime；这是显式漂移，不是已经解决的替代设计。
- ADR 0005 仍是 proposed，尽管部分协议驱动和 Motor 边界已经被实现。
- `Information → Grounding → Behavior → Motor` 已跑通可信注视实验；把它替换成模型工具循环目前只是候选方案。
- GitHub v0.2/v0.3 Issue 状态没有吸收 2026-07-21 至 2026-07-23 的直接提交和分支实验。

这些事实会在[当前项目状态](./current-status.md)和[具身决策登记册](./proposals/embodiment/decision-register.md)中继续维护。
