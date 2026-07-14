# 详细设计

本目录保存已经进入实现层面的模块契约。系统级边界以根目录的 `SYSTEM_DESIGN.md` 为准；单项长期决策记录在 `docs/adr/`。

## 文档

- [领域事件与事件日志协议](./domain-events-and-journal.md)
- [同伴运行时状态机与活动对齐](./companion-runtime.md)
- [同伴决策协议与上下文包](./decision-contract-and-context.md)
- [合法信息接口、Help 发现与 UI 会话](./information-access-and-ui.md)
- [Information Runtime 模块设计与统一 Provider 契约](./information-runtime.md)
- [具身能力与接口清单](./embodied-interface-inventory.md)
- [记忆模型、档案版本与冲突协调](./memory-model-and-profile-versioning.md)
- [实体、方块、声音与玩家行为的认知感知模型](./cognitive-perception.md)
- [Mineflayer Backend 生命周期与状态快照](./minecraft-backend.md)

详细设计应关联 GitHub Issue，并说明状态、依赖、非目标和验收方式。设计变更如果影响长期架构决定，还需要新增或更新 ADR。

按里程碑组织的实施顺序见 [阶段计划](../plans/README.md)。
