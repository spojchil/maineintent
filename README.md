# MineIntent

MineIntent 是一个面向 Minecraft Java Edition 的 AI 同伴项目。

它不是只接受命令并交付结果的任务机器人，而是希望成为能够进入同一个世界，与玩家自然交流、共同生活、合作、探索、建造和冒险的游戏伙伴。

长期高层目标之一，是让它在经服务器管理方许可的外部原版生存服务器中，仅凭普通玩家能够获得的信息和合法游戏行为长期参与；其他玩家仅从游戏内观察，难以可靠区分它与一名较安静、反应较慢的普通玩家。这个目标强调行为可信和无作弊，不以虚假身份声明、规避反作弊或绕过服务器规则为手段。

## 当前状态

项目已经实现首个纵向原型，但仍是开发者预览，尚不是可供长期日常游玩的成品。

目前已经完成：

- 产品定位与体验设计。
- 相邻 Agent、AI 伴侣和 Minecraft Bot 项目调研。
- 事件驱动的持续同伴系统设计。
- Mineflayer Backend、认知观察边界、受约束动作运行时与聊天调度。
- “一起收集木材”共同活动的聊天、采集、暂停、危险反射、返回和跨重启记忆闭环。
- OpenAI-compatible 模型适配器、可编辑自然语言同伴档案与本地持久数据。
- 只绑定本机、只读且脱敏的同伴调试状态接口。
- 基于持久基准世界副本的 Paper 1.21.1 self-hosted 集成测试。

当前原型用来验证最小同伴闭环：玩家与 AI 通过游戏聊天形成“共同收集木材”的活动，AI 能参与、接受中途调整、处理简单意外、验证真实结果，并在重启后记住共同经历。它还没有完整生存能力树、成熟战斗或长期自主规划。

真实 Paper 1.21.1 测试的本地与 self-hosted CI 用法见 [Paper 集成测试](./docs/testing/paper-integration.md)。

## 核心原则

1. AI 是可协商的队友，不是绝对服从的工具，也不与玩家争夺游戏主导权。
2. 自主性来自同伴档案、关系、共同经历和当前情境，而不是一组机械性格参数。
3. 语言、意图、行动、真实结果和记忆必须保持一致。
4. 游戏动作只能通过可取消、带超时、可验证的能力执行。
5. 记忆保留来源和证据，并允许纠正。
6. 协议客户端获得的信息不自动等于同伴角色应该知道的信息。
7. 同伴的知识、身体过程和游戏内表现应处于普通原版玩家的可能范围内。

## 文档

- [产品设计](./PRODUCT_DESIGN.md)
- [系统设计](./SYSTEM_DESIGN.md)
- [相关系统调研](./research/SYSTEM_DESIGN_RESEARCH.md)
- [架构决策记录](./docs/adr/README.md)
- [详细设计](./docs/design/README.md)
- [早期项目交接与技术研判](./MINEINTENT_HANDOFF.md)
- [贡献与开发规范](./CONTRIBUTING.md)

`MINEINTENT_HANDOFF.md` 是项目早期技术研判材料；当前产品需求和系统边界以产品设计、系统设计及后续 ADR 为准。

## 技术基线

- Node.js 22 或更高版本。
- TypeScript、ESM、pnpm。
- Mineflayer 作为第一版 Minecraft Backend。
- Minecraft Java Edition 1.21.1 测试服务器。

技术基线会通过原型验证继续评估，不代表所有未来实现已经锁定。

## 本地验证

安装依赖：

```powershell
pnpm install
```

运行类型检查：

```powershell
pnpm check
```

运行自动单元和契约测试：

```powershell
pnpm test
```

## 运行首个同伴原型

复制配置样例并填写主要玩家名、模型服务地址、模型名和密钥：

```powershell
Copy-Item .env.example .env
```

确保目标 Minecraft Java Edition 1.21.1 服务器已经运行，再启动：

```powershell
pnpm start
```

同伴通过游戏聊天与主要玩家交流。默认调试状态位于 `http://127.0.0.1:3211/v1/state`；该接口只有 GET 能力，不提供游戏控制，并会遮盖密钥、令牌和原始私人正文。

当前模型适配器使用 OpenAI-compatible Chat Completions JSON 输出。密钥只从本地 `.env` 读取；`.env` 和运行数据目录 `.mineintent/` 已被 Git 忽略。运行细节见 [首个同伴原型](./docs/testing/companion-prototype.md)。

在 `localhost:25565` 已运行受管理的 Paper 1.21.1 离线验证服务器时，可执行 Backend 生命周期集成验收：

```powershell
pnpm test:paper
```

该测试会杀死并传送测试 Bot，还会安全停止并重启本地 Paper。默认检测到其他玩家在线时拒绝执行。明确作为观察者上线时，可通过环境变量放行用户名：

```powershell
$env:MC_HOST = "localhost"
$env:MC_PORT = "25565"
$env:MC_USERNAME = "MineIntentBot"
$env:MC_OBSERVER_USERNAMES = "spojchil"
pnpm test:paper
```

## 开发流程

项目采用 GitHub Flow：非琐碎工作通过 Issue 说明目标，在短期分支中实现，由 Pull Request 关联 Issue 并经过自动检查后合并。

架构或产品方向变更应先建立 proposal Issue；接受后的长期决定写入产品/系统设计或 ADR。详细规则见 [CONTRIBUTING.md](./CONTRIBUTING.md)。

## 许可证

项目当前未授予开源许可证。在正式确定分发方式前，代码保留所有权利。
