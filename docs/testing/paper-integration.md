# Paper 1.21.1 集成测试

MineIntent 将普通 CI 单元测试和真实 Paper 测试分开。普通 PR CI 不启动 Minecraft；Paper Integration 只通过 GitHub 手动触发，并在仓库专用的 self-hosted runner 上运行。

## 覆盖范围

真实场景当前验证：

- Minecraft Backend 连接、死亡、重生和服务端重启后自动重连；
- 测试客户端的基础移动和清除控制状态后的取消，用于验证服务器与协议环境；
- 测试客户端装备镐、挖掘方块、确认方块消失和掉落进入背包；该场景不宣称是同伴当前生产能力；
- 主要玩家与同伴通过聊天建立共同收集木材活动；
- 同伴背对主要玩家时收到“看向我”，经 partial Grounding、有限扫描和渐进转向建立视觉注意，并以实际 yaw 和 `outcome_verified` 双重断言；
- 尚未支持的采集语义不回退到旧 skill，背包和世界保持不变；
- “等一下”的确定性安全停止与低生命危险警告；
- 玩家明确提出的共同经历带来源写入记忆，并在同伴进程重启后被检索和用于回答；
- 所有失败、超时和正常结束路径均安全停止 Bot 与 Paper；
- setup、companion、assertion、cleanup 分阶段记录，不把控制台布置命令算作同伴能力。

## shumei4 Runner

仓库 Runner 名为 `shumei4-paper-ci`，标签为：

```text
self-hosted, Linux, ARM64, mineintent, paper-ci
```

Paper 只监听 `127.0.0.1:25566`，不需要开放 Minecraft 公网端口。工作流 concurrency 固定为单并发，防止两个场景共享端口或竞争内存。

仓库 Actions Variables：

| 名称 | 用途 |
|---|---|
| `PAPER_CI_NODE_BIN` | Node 22 与 pnpm 所在目录 |
| `PAPER_CI_NPM_REGISTRY` | shumei4 可稳定访问的 npm 镜像 |
| `PAPER_CI_JAVA` | ARM64 Java 可执行文件 |
| `PAPER_CI_JAR` | 锁定的 Paper 1.21.1 build 133 JAR |
| `PAPER_CI_TEMPLATE` | 零玩家、零场景修改的基准世界目录 |

这些值是路径与镜像地址，不是密钥。Runner 注册令牌只在首次注册时使用，不保存在仓库变量中。

## 世界隔离

第一次运行会生成一次基准世界，在 Paper 报告 ready 后立即安全停止，并写入模板标记。以后每次运行：

1. 普通复制基准模板到本次 artifact 目录；
2. 删除复制来的旧日志和崩溃报告；
3. 覆盖 localhost、端口和 offline-mode 测试配置；
4. 在副本中执行场景；
5. 安全停止进程，将控制台日志移出世界目录；
6. 删除本轮世界副本，只上传 JSONL、摘要和服务端日志。

纵向同伴场景使用测试专用的确定性模型替身，因此 CI 不需要、也不保存任何模型 API 密钥。它验证模型之后的决策应用、Minecraft 动作、真实结果与持久记忆；真实模型协议由普通自动化测试验证，真人体验需要单独配置本地模型密钥。

不能用硬链接复制 region 文件，因为 Paper 的原地写入可能反向污染模板。

## 运行

合并到默认分支后：

```powershell
gh workflow run "Paper Integration"
gh run watch
```

本地 Windows 完整后端生命周期测试仍使用：

```powershell
$env:MC_OBSERVER_USERNAMES='spojchil'
npm run test:paper
```

本地测试会控制 Bot、死亡、维度和服务端重启，不应在有未授权玩家在线时运行。
