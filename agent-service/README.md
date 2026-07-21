# agent-service

同伴决策层：把 `CompanionRuntime` 传来的 `DecisionContext` 转成一次 OpenAI-compatible Chat
Completions 调用，验证并返回 `CompanionDecision`。与 `src/minecraft/`（Mineflayer 协议驱动）
彻底分离，只通过 `src/models/agent-service-client.ts` 这一层 HTTP JSON 接口交互，因此可以独立于
Node 进程运行、审查和测试。

只依赖 Python 标准库，无需安装任何包。

## 运行

与 Node 进程一起运行时是两个独立进程：

```powershell
python agent-service/server.py
```

另开一个终端：

```powershell
pnpm start
```

配置从仓库根目录的 `.env` 读取（`MINEINTENT_MODEL_BASE_URL`、`MINEINTENT_MODEL_API_KEY`、
`MINEINTENT_MODEL`、`MINEINTENT_AGENT_SERVICE_PORT`，默认端口 8765）。Node 侧通过
`MINEINTENT_AGENT_SERVICE_URL` 找到这个服务，默认 `http://127.0.0.1:8765`。

## 接口

- `POST /v1/decide`：请求体是完整的 `DecisionContext`（见 `src/models/contracts.ts`），
  返回 `{decision, model, usage}`。`decision` 保证通过 `schema.py` 的
  `mineintent.companion-decision.v1` 校验，字段约束与 Node 侧 zod schema 逐项对应。
- `GET /healthz`：存活探测，返回 `{"status": "ok"}`。

## 测试

```powershell
python -m unittest agent-service/test_server.py -v
```
