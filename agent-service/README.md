---
status: reference
authority: informative
implementation: current
last_verified: 2026-07-23
applies_to: codex/trustworthy-passive-context@57d438e
---

# agent-service

同伴模型传输层：把 `CompanionRuntime` 传来的上下文转成一次 OpenAI-compatible Chat
Completions 调用，并把严格 JSON 模型输出原样返回。与 `src/minecraft/`（Mineflayer 协议驱动）
彻底分离，只通过 `src/models/agent-service-client.ts` 这一层 HTTP JSON 接口交互，因此可以独立于
Node 进程运行、审查和测试。

业务决策 schema 的唯一运行时权威在 TypeScript 侧；Python 不复制或修复该 schema。两侧传输均拒绝
非标准 JSON、非有限数、不安全整数、非法 Unicode 和超过 1 MiB 的信封。

需要 Python 3.12 或更高版本，只依赖标准库，无需安装任何包。当前没有 Tool Calls、多轮 repair、DeepSeek 专用 thinking 配置或真实供应商集成测试。

## 运行

与 Node 进程一起运行时是两个独立进程：

```powershell
python agent-service/server.py
```

另开一个终端：

```powershell
pnpm start
```

配置先读取进程环境变量，再用仓库根目录 `.env` 中的值补齐尚未设置的字段（`MINEINTENT_MODEL_BASE_URL`、`MINEINTENT_MODEL_API_KEY`、
`MINEINTENT_MODEL`、`MINEINTENT_AGENT_SERVICE_PORT`，默认端口 8765）。Node 侧通过
`MINEINTENT_AGENT_SERVICE_URL` 找到这个服务，默认 `http://127.0.0.1:8765`。

## 接口

- `POST /v1/decide`：请求体是 `{context, outputSchema}`；`context` 必须是完整的
  `mineintent.context.v2`，`outputSchema` 由 TypeScript 侧的运行时 schema 生成。返回
  `{rawOutput, model, usage?}`。`rawOutput` 只保证是严格且有界的 JSON；Node 侧负责协议、
  schema、引用与语义校验。
- `GET /healthz`：存活探测，返回 `{"status": "ok"}`。

## 测试

```powershell
pnpm test:python
```
