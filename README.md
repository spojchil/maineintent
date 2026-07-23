# MineIntent

MineIntent 是一个面向 Minecraft Java Edition 的 AI 同伴项目。

它不是只接受命令并交付结果的任务机器人，而是希望成为能够进入同一个世界，与玩家自然交流、共同生活、合作、探索、建造和冒险的游戏伙伴。

长期高层目标之一，是让它在经服务器管理方许可的外部原版生存服务器中，仅凭普通玩家能够获得的信息和合法游戏行为长期参与；其他玩家仅从游戏内观察，难以可靠区分它与一名较安静、反应较慢的普通玩家。这个目标强调行为可信和无作弊，不以虚假身份声明、规避反作弊或绕过服务器规则为手段。

## 当前状态

项目仍是开发者预览。默认分支 `main` 与最新实验分支并不相同；最新实验实现了一个很窄的可信注视闭环，但尚未形成新的接受架构。

最新实验实际具备：

- Mineflayer Backend、游戏聊天、发送调度和本地只读调试；
- 生命/背包/声音/视口四个固定被动 Information Read；
- `CompanionDecisionV2` 的 `embodied_intent` 分支可进入 `Grounding → Behavior → Motor → Outcome Evidence`；
- “看向我”的有限扫描、渐进转向、取消和结果阶段可见性复查（当前未强制感知 revision 前进）；
- JSON 文件形式的最小跨重启证据记忆；
- 通用 OpenAI-compatible 单轮 JSON 模型传输。

当前唯一生产具身 operator 是视觉注意。移动、挖掘、攻击、使用物品、物品栏选择、采集、建造、战斗、主动陪伴和完整长期记忆均未接入；v0.1 曾实现的跟随/采木/Action Runtime 已从最新实验删除。Capability Catalog 仍高估身体能力，最新分支也尚无 GitHub CI/Paper run。

逐项事实、分支提交、测试结果和 tracker 漂移见[当前项目状态](./docs/current-status.md)。

真实 Paper 1.21.1 测试的本地与 self-hosted CI 用法见 [Paper 集成测试](./docs/guides/paper-integration.md)。

## 核心原则

1. AI 是可协商的队友，不是绝对服从的工具，也不与玩家争夺游戏主导权。
2. 自主性来自同伴档案、关系、共同经历和当前情境，而不是一组机械性格参数。
3. 语言、意图、行动、真实结果和记忆必须保持一致。
4. 游戏动作只能通过可取消、带超时、可验证的能力执行。
5. 记忆保留来源和证据，并允许纠正。
6. 协议客户端获得的信息不自动等于同伴角色应该知道的信息。
7. 同伴的知识、身体过程和游戏内表现应处于普通原版玩家的可能范围内。

## 文档

- [文档总入口与真相优先级](./docs/README.md)
- [当前项目状态](./docs/current-status.md)
- [产品设计](./docs/product-design.md)
- [当前系统实况](./docs/architecture/current-system.md)
- [架构决策记录](./docs/decisions/README.md)
- [开放提案与具身决策登记册](./docs/proposals/README.md)
- [项目演进史与早期档案](./docs/history/project-evolution.md)
- [贡献与文档治理](./CONTRIBUTING.md)

## 技术基线

- Node.js 22 或更高版本。
- Python 3.12 或更高版本（本地模型传输服务，仅使用标准库）。
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
pnpm check:docs
```

运行自动单元和契约测试：

```powershell
pnpm test
pnpm test:python
```

## 运行首个同伴原型

复制配置样例并填写主要玩家名、模型服务地址、模型名和密钥：

```powershell
Copy-Item .env.example .env
```

确保目标 Minecraft Java Edition 1.21.1 服务器已经运行，再启动同伴决策服务和 Node 进程（两个独立进程）：

```powershell
python agent-service/server.py
```

```powershell
pnpm start
```

同伴通过游戏聊天与主要玩家交流。默认调试状态位于 `http://127.0.0.1:3211/v1/state`；该接口只有 GET 能力，不提供游戏控制，并按字段名与常见凭证形状遮盖密钥、令牌和原始私人正文。供应商错误摘要尚无通用 secret scrub，仍应把调试状态与 JSONL 日志当作敏感本地数据。

模型传输层（prompt 构造与 OpenAI-compatible 调用）在 `agent-service/`（Python，仅用标准库），通过本地 HTTP 与 Node 侧的 `CompanionRuntime` 交互；决策协议与业务校验的唯一权威在 TypeScript 侧。边界见该目录下的 [README](./agent-service/README.md)。Mineflayer 协议驱动、动作执行与编排仍在 Node 侧。配置优先使用进程环境变量，缺失值再由仓库根目录的本地 `.env` 补齐；`.env` 和运行数据目录 `.mineintent/` 已被 Git 忽略。运行细节见 [首个同伴原型](./docs/guides/companion-prototype.md)。

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
