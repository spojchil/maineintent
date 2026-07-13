# 0005：限制 Mineflayer 为协议驱动而非认知与行为权威

- 状态：proposed
- 日期：2026-07-13
- 讨论：[#32](https://github.com/spojchil/mineintent/issues/32)
- 补充：[0001：使用 Mineflayer 作为第一版 Minecraft Backend](./0001-use-mineflayer-as-initial-backend.md)

## 背景

v0.1 真人联调证明 Mineflayer 适合承担登录、协议、区块、实体、背包和基础物理，但其高层自动化抽象与“接近真人的具身同伴”存在系统性冲突：

- `bot.players` 表示协议实体被追踪，不表示同伴当前看见玩家；
- `bot.findBlock` 可检索当前视野之外的完整已加载区块；
- `mineflayer-pathfinder` 直接使用 `bot.world`，能利用未探索迷宫和遮挡后的精确地形；
- `bot.dig` 会乐观地把本地方块改为空气，Promise 完成不等于服务端接受破坏；
- 高层方法允许先指定世界坐标，再补做朝向和动画，而不是从当前身体视线取得交互目标。

这些行为对传统自动化 Bot 合理，却会让 MineIntent 的语言、记忆与身体表现失去共同事实基础。仅靠提示词或事后过滤不能纠正已经利用全知数据完成的动作。

## 决定

继续使用 Mineflayer，但把它限制为可替换的协议驱动。Mineflayer 不再是认知事实、意图目标、动作成功或普通路线可知性的权威。

系统采用以下边界：

```text
Mineflayer Protocol Driver
├── Protocol State          服务端实际发送的原始客户端状态
├── Safety Control View     碰撞、跌落、即时威胁与协议合法性
├── Perception Boundary     FOV、光学遮挡、声音、交互反馈
│        ↓
├── Epistemic Map           当前看见、亲自探索和仍然记得的空间
│        ↓
├── Intentional Planner     只能利用 Epistemic Map 选择普通路线
└── Motor Controller        注视、移动、准星交互和服务端结果确认
```

### 协议驱动允许承担

- 登录、认证、加密、版本协商和重连；
- 区块、方块、实体、声音、聊天、背包和自身状态的协议解码；
- 客户端物理、移动包和必要的协议时序；
- 产生带来源的原始事件，供感知、动作反馈与测试使用。

### 高层自动化限制

- `findBlock` 结果只能生成内部候选，不能直接成为认知发现或玩家指代的目标；
- `bot.players` 和实体表只能生成候选，不能证明当前可见；
- `bot.world` 可以用于防止穿墙、跌落等硬安全校验，不能为普通意图选择未感知路线；
- 挖掘目标必须来自当前准星射线命中的可交互方块面；
- Mineflayer 的本地乐观更新只表示预测，不能生成成功领域事件；
- 普通寻路只能使用当前感知或历史探索形成的 Epistemic Map；未知区域必须通过探索获得；
- 业务层不得直接导入 Mineflayer Bot、World、Entity、Block 或 Pathfinder 类型。

### 结果权威

动作结果分为四层：

1. `commanded`：Motor Controller 已发出协议动作；
2. `client_predicted`：客户端库产生本地预测；
3. `server_observed`：收到服务端来源的状态变化；
4. `outcome_verified`：动作特定后置条件成立，例如背包增量。

语言、共同活动和记忆只能把 `server_observed` 或 `outcome_verified` 表达为已发生事实。开发和 CI 可以使用 Paper 测试裁判提供更强证据，但正式产品不能依赖服务器管理权限。

## 理由

- 保留 Mineflayer 可避免重写完整 Minecraft Java 客户端。
- 收紧边界能继续复用已经验证的生命周期、DTO、聊天和背包基础。
- 感知、认知地图和 Motor Controller 是产品语义，应由 MineIntent 掌握。
- 底层安全与角色知识分离后，既能避免明显危险，也不会用原始区块直接破解迷宫。

## 后果

### 正面

- 语言、动作和记忆可以共享同一套带证据事实。
- 更换 Mineflayer、局部自定义插件或未来 Fabric Backend 不影响上层协议。
- 未探索环境会产生合理探索行为，曾探索环境才允许形成路线记忆。
- 客户端预测、服务端状态与最终业务结果不再混为一个事件。

### 代价

- 不能直接依赖 Mineflayer 高层方法快速增加技能。
- 需要实现虚拟第一人称感知、Epistemic Map、Motor Controller 和受限规划。
- 某些 Mineflayer 插件会污染本地状态，可能需要替换插件或维护小型适配补丁。
- 人类式未知性会降低传统任务 Bot 的最短路径成功率，这是有意的产品取舍。

## 备选方案

### 继续直接包装高层 Mineflayer API

拒绝。它能隐藏类型依赖，却不能阻止 pathfinder 和 dig 在包装内部使用全知或乐观状态。

### 基于 `minecraft-protocol` 全量重写客户端

暂不采用。控制最完整，但登录、区块、物理、背包和版本兼容成本过高。若 Mineflayer 内部状态持续无法隔离，再重新评估。

### Fabric 完整客户端 Mod

保留为未来 Backend。它更接近原版客户端交互，但无头部署、资源占用、版本和 Mod 兼容复杂度更高。

### Fork Mineflayer

只在无法通过自定义 Motor/Perception 插件隔离乐观状态时采用最小分支，不把业务策略合入分支。

## 验证与复审条件

- 玩家在身后时，同伴不能把 `tracked` 表达为“看见”；转头后必须有视线证据。
- 新迷宫不能利用未探索区块直接规划出口；走过一次后可以使用记忆路线。
- 遮挡后的方块不能仅因已加载或距离足够而成为挖掘目标。
- `dig` Promise 完成、服务端方块变化和背包拾取分别记录。
- 如果上述边界仍需大量侵入 Mineflayer 内部私有 API，重新比较最小 fork、`minecraft-protocol` 和 Fabric Backend。
