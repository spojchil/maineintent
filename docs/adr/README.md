# 架构决策记录

ADR（Architecture Decision Record）记录影响长期实现的单项决定。讨论过程保留在 GitHub Issue，ADR 保存接受后的结论和取舍。

## 状态

- `proposed`：仍在讨论。
- `accepted`：当前有效。
- `superseded`：已被后续 ADR 取代。
- `rejected`：经过讨论但未采用。

## 列表

- [0001：使用 Mineflayer 作为第一版 Minecraft Backend](./0001-use-mineflayer-as-initial-backend.md)
- [0002：采用事件驱动的持续同伴运行时](./0002-event-driven-companion-runtime.md)
- [0003：分离同伴心智与行动运行时](./0003-separate-mind-and-action-runtime.md)
- [0004：不执行模型生成的任意代码](./0004-no-arbitrary-model-code.md)
- [0005：限制 Mineflayer 为协议驱动而非认知与行为权威](./0005-limit-mineflayer-to-protocol-driver.md)

新 ADR 从 [模板](./template.md) 创建，编号递增。若新决定替代旧决定，应在两份 ADR 中互相链接。
