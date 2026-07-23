---
status: reference
authority: informative
implementation: current
last_verified: 2026-07-23
applies_to: codex/trustworthy-passive-context@57d438e
---

# 首个同伴原型

当前纵向原型验证语言、合法观察、Grounding、视觉共同注意、取消、终态依赖话术调度和记忆组成的最小同伴切片，而不是完整 Minecraft 通关 Agent。运行时尚无 Claim Policy，不能把即时自然语言本身视为已经过事实验证。

## 运行前提

- Node.js 22 或更高版本、pnpm 11.3.0。
- Minecraft Java Edition 1.21.1 服务器。
- 离线服使用 `MINEINTENT_MC_AUTH=offline`；正版认证可改为 `microsoft` 并设置 profiles folder。
- 一个支持 OpenAI-compatible Chat Completions 和 `response_format: json_object` 的模型接口。

从 `.env.example` 复制 `.env`，至少填写：

```dotenv
MINEINTENT_PRIMARY_PLAYER=你的游戏名
MINEINTENT_MODEL_BASE_URL=https://服务商地址/v1
MINEINTENT_MODEL_API_KEY=本地密钥
MINEINTENT_MODEL=模型名
```

不要把 `.env`、密钥或认证目录提交到 Git。程序不会主动记录模型密钥，调试状态也按字段名和常见凭证形状做脱敏；但供应商错误正文会进入失败摘要和 JSONL，目前没有通用 secret scrub，因此不要把错误日志当作已经完成端到端脱敏审计。

## 启动与停止

```powershell
python agent-service/server.py
```

另开一个终端：

```powershell
pnpm start
```

启动后，同伴读取 `companion-profile.md`、连接服务器，并立即排入一次 `startup` 决策；它不等待主要玩家上线。后续普通聊天只接受配置的主要玩家消息。`Ctrl+C` 会取消模型和游戏动作、释放身体资源、停止聊天调度、断开 Minecraft 并刷新事件日志。

玩家可以自然地尝试：

```text
看向我
一起收集些木头吧
等一下
记住我们今天开始一起玩
上次我们做了什么？
```

“停下”“等一下”等独立、明确的控制表达不等待模型，直接取消当前身体动作。普通计划变化仍交给同伴结合情境理解。

“看向我”是当前唯一接入新具身闭环的生产行为：说话者身份已知但方向未知时，同伴通过有限转头扫描，再以结果阶段的当前可见性复查目标，而不是读取 tracked entity 坐标直接转向。当前复查没有强制 perception revision 前进，目标若开始时已在准星附近，甚至可能不发出新的 `look`。模型可以提出共同采集等活动和语义目标，但尚未支持的具身目标会明确拒绝；不会调用旧采木 skill。

## 数据与调试

默认运行数据写入 `.mineintent/`：

- `events.jsonl`：带会话、世界和因果 ID 的本地事件轨迹；
- `memories.json`：绑定 world ID 和事件证据 ID 的原型记忆；候选中的完整 `sourceClaim`、subjects、place/activity 关联不会落入当前持久结构，不能称为完整 provenance。

默认只读调试接口为：

```text
GET http://127.0.0.1:3211/health
GET http://127.0.0.1:3211/v1/state
```

状态包含连接、身体摘要、关注、共同活动、意图、当前动作、身体资源锁、最近失败、决策上下文来源和检索记忆 ID。接口只监听 loopback；非 GET 请求返回 `405 read_only`，完整聊天、提示词、档案正文、令牌和密钥不会出现在响应中。

## 当前边界

当前生产身体执行只开放经过 Grounding 的视觉注意控制：渐进转向、有限身份扫描、安全停止、超时和结果阶段可见性复查；“fresh observation”仍缺少 revision guard。低生命危险反射会立即释放身体输入并发出警告。移动规划、挖掘/拾取、跟随、返回、完整工具制作、食物管理、建造、战斗、跨维度计划和通用长期任务分解仍未接入生产 Behavior 链路。
