# Session 关闭与删除屏障复核

新加坡 2026-10-12 02:26，基线 `a66f4ef291f304ee4df9da8095a90671d9a8f140`。本轮新增正式发现 0。

## 正常契约与证据

Desktop `packages/desktop/src/main/index.ts:6758–6767` 先等待 `AgentBridge.closeSession`，再停止外部运行时并删除目录；`agent-bridge.ts:2061` 等待 worker close ACK，设有 30 秒上限。Core `protocol/server.ts:2982–3007` 撤销启动及审批，等待 ChatSessionManager close 和后台 shell 清理后才回 ACK。这些步骤不支持“正常关闭后迟到的运行任意复活目录”的泛化结论。

`protocol/chat-session-manager.ts:512–579` 对关闭发布 intent、去重 Promise、递增 session generation、取消运行，并等待活动 run 的 settled 后再释放 Engine。内部发送者 `allowReopen:false` 在迁移等待结束后重新检查关闭与取消状态；显式用户重开仍可按顺序创建新 Engine。关闭中的有限 finalization lease 只允许当前 run 的终态字段，拒绝旧 generation、后继 run 和额外业务字段。

用仓库 guarded runner、隔离 HOME 与测试前 deny guard 重新运行三个现有正常套件：

| 套件 | 测试 | 结果 | 日志 |
| --- | ---: | --- | --- |
| `packages/core/src/session/session-manager.generation.test.ts` | 12 | 0 失败、0 跳过 | [control-1.log](validation/session-close-round10/control-1.log) |
| `packages/core/src/protocol/chat-session-manager.lifecycle.test.ts` | 9 | 0 失败、0 跳过 | [control-2.log](validation/session-close-round10/control-2.log) |
| `packages/core/src/protocol/chat-session-manager.access.test.ts` | 7 | 0 失败、0 跳过 | [control-3.log](validation/session-close-round10/control-3.log) |

共 3 文件、28 测试、150 断言（含每 shard 7 项 HOME/网络保护断言）。这批是现有正常套件复跑，不加入便携缺陷复现的 40 文件/111 测试计数。每个进程在产品导入前通过 `--preload` 安装 [deny guard](validation/session-close-round10/network-guard.ts)，五种负向网络探测均被同步拒绝，结束时没有额外 JS 网络调用。未请求模型，未运行真实用户进程或操作用户 HOME；该 guard 不是操作系统沙箱。

复跑命令，在相同快照从仓库根运行，替换下面 `TEST_FILE` 为表内文件路径：

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 --preload docs/review-2026-10-12/validation/session-close-round10/network-guard.ts TEST_FILE
```

## 与现有发现的区别

R31 是原生 Node Hub CLI 的 Host 关闭未等待 Panel 进程 SIGKILL，不能扩写成 Core 所有 session close 均不等待。R24 是移除项目先 tombstone 权威、导致冷会话 worktree release 失败，与本轮 generation fencing 也不是同一问题。归档 helper 有意在 release 失败后继续保留归档，现有测试明确此契约；仅凭这个选择不能增加一个重复发现。

限制：本轮核对生产调用链并执行真实 SessionManager/ChatSessionManager 正常测试；Engine 的运行及 dispose 在相应套件中是可控替身。没有将其宣称为实际 Electron UI 逐步删除会话、完整引擎非协作工具终止或 Windows 进程行为的端到端验证。
