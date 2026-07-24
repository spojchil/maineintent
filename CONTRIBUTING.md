# MineIntent 贡献与开发规范

## 1. 基本原则

- 以默认分支的代码、测试和已合并 PR 为当前依据。
- 优先完成可验证的纵向场景，不先建立没有真实使用者的抽象层。
- Minecraft 真实状态和程序验证结果高于模型声明。
- 不提交密钥、玩家私人数据、世界存档、大型服务端文件或第三方研究仓库。
- 发现现有方向不成立时，在 Issue 或 PR 中说明问题和取舍，不用代码静默改变产品方向。

### 1.1 协作语言

- 人工创建的 Issue 标题、正文和评论使用简体中文。
- 人工创建的 Pull Request 标题、正文和审查交流使用简体中文。
- 代码标识、API 名称、技术术语、分支名和 Conventional Commit 类型可以保留英文。
- Commit 的类型前缀保留英文，说明部分优先使用中文，例如 `docs: 明确活动漂移语义`。
- Dependabot、GitHub Actions 等第三方自动化生成的标题和内容允许保留英文。
- 引用英文错误信息或上游资料时保留原文，并在需要时补充中文说明。

## 2. 工作跟踪

非琐碎工作应有 GitHub Issue，包括：

- 功能、Bug、测试与可靠性工作。
- 产品或系统设计问题。
- 有明确结论要求的技术调研。
- 会改变公共接口、持久化或运行语义的重构。

拼写修复、同一 PR 范围内的微小整理不强制建立独立 Issue。

较大的工作使用父 Issue 和 sub-issues 拆分。Milestone 表示可验收的产品增量，不用作无期限的想法收集箱。

## 3. 提案与架构决策

会改变产品原则、系统边界、数据所有权或关键运行语义的修改，其结论必须以**一个合并的 PR** 落地：想清楚它的地方不限，但它必须以可点开的形式存在。PR 正文需包含：

1. 问题和现实场景。
2. 备选方案与取舍。
3. 结论，以及被否决的方案。

squash 合并后 `main` 上留下的 `(#NN)` 就是这个决定的引用地址。讨论可以发生在 Issue 或 Draft PR 中；接受后的结论不再另抄一份 ADR 或提案文档。**说不清到能写进 PR 正文的程度，就还不算一个决定。**

## 4. 分支策略

项目使用 GitHub Flow，不建立长期 `develop`、`release` 或 feature 分支。

从最新 `main` 创建短期分支：

```text
feat/<issue>-<name>
fix/<issue>-<name>
docs/<issue>-<name>
refactor/<issue>-<name>
research/<issue>-<name>
```

示例：

```text
feat/18-event-journal
docs/12-decision-contract
fix/31-release-movement-lock
```

一个分支和 PR 应尽量只解决一个清晰问题。合并后删除分支。

## 5. Commit

使用简化的 Conventional Commits：

```text
feat: add companion event journal
fix: release movement lock on cancellation
docs: define activity alignment semantics
test: cover profile-memory reconciliation
refactor: isolate Mineflayer adapter
chore: configure CI
```

提交应保持可理解，不提交明显损坏的中间状态。PR 内可以有多个开发提交，合并时使用 Squash Merge。

## 6. Pull Request

非琐碎改动通过 PR 进入 `main`。PR 应：

- 关联对应 Issue，并在适用时使用 `Closes #<number>`。
- 说明目标、方案、验证和影响。
- 保持范围足够小，便于理解和回滚。
- 同步更新受到影响的安装、配置、运行、接口或排错说明。
- 通过所有自动检查。

只有注释、拼写等不改变行为的极小改动可以由维护者直接提交到 `main`。

## 7. 验证要求

提交 PR 前至少运行：

```powershell
pnpm install --frozen-lockfile
pnpm check
pnpm test
```

涉及 Minecraft 行为时，还应提供相应验证证据：

- 单元测试或状态机测试。
- 可重复的服务器集成测试。
- 使用的 Minecraft/Paper/Mineflayer 版本。
- 动作结果和真实世界验证。
- 失败、取消和清理路径。

不能用模型输出“成功”代替游戏状态验证。

## 8. AI 辅助开发

允许使用 AI 编写和审查代码，但提交者仍对结果负责：

- AI 生成的实现必须经过阅读和实际验证。
- 不把生产密钥、私人聊天、玩家数据或未公开世界文件发送给外部模型。
- 不因 AI 建议而跳过 Issue、设计决定、测试或代码审查。
- 大范围生成改动应拆分成可审查的 PR。
- PR 描述应说明实际验证结果，不写无法证实的结论。

## 9. 文档维护

默认分支只维护用户和贡献者实际会用到的说明：安装、配置、运行、验证、排错、接口和贡献流程。文档应描述当前代码，代码或命令改变时在同一 PR 更新。

设计推理、实验过程和被否决方案留在对应 Issue、PR 与提交历史中，不在仓库内维护平行的架构、ADR、提案或项目史文档库。`main` 仍只通过合并 PR 变更。

## 10. 安全报告

不要在公开 Issue 中提交密钥、访问令牌、服务器地址、私人日志或可利用漏洞的敏感细节。安全问题使用仓库的私密漏洞报告渠道。
