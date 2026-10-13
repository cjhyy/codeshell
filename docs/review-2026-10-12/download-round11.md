# 第十一轮：本地下载生命周期收束

产品快照：`a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 `CODESHELL.md`。产品、主报告、构建和目标均未修改；收到停止实验指令后没有新增进程实验或查看其他任务进程。

## 实际运行与清理清单

本轮仅运行 **1 次隔离原生 Node smoke**，退出码 **0**。没有运行 Bun shard，没有 JUnit 通过/跳过统计，没有运行真实 Electron、完整 Desktop Main、真实 Hub、模型或账户。命令和已捕获 stdout 保存在 [native-run.log](validation/download-round11/native-run.log)，不是另一次运行生成的日志。

```text
node scripts/run-isolated-node-smoke.mjs /tmp/codeshell-review-20261012-download-round11/orphan-download.mjs
PASS native owned orphan download, close/delete barrier, killAll, scoped kill recovery and normal control
```

保留的证据：

- [orphan-download.mjs](validation/download-round11/orphan-download.mjs)：原生 HTTP、真实 Core manager/AgentServer RPC、归属检查和清理。
- [crash-worker.mjs](validation/download-round11/crash-worker.mjs)：隔离 Node helper 中调用真实 `BackgroundShellManager.spawnBackground`，随后由 fixture 终止该 helper。
- [quiet-download.mjs](validation/download-round11/quiet-download.mjs)：只向 fixture 自有文件写入的本地慢 HTTP 下载。
- [native-observations.json](validation/download-round11/native-observations.json)：原始状态、进程身份、RPC 回包和字节数。

两个下载进程均在本次运行结束前被实际终止：恢复任务经真实 `agent/backgroundShells {action:"kill"}` 终止；普通任务经真实 `agent/closeSession` 终止。两者均断言进程组消失、随后文件大小稳定。被模拟崩溃的 Node helper 亦已确认 close。脚本 `finally` 只对本次创建、且 OS start time 与完整命令仍匹配的进程组作兜底清理，关闭自建 HTTP server/连接并删除自有临时根目录。运行结束后只读检查该根目录不存在，退出 0。隔离 runner 的 `finally` 清理其私有 HOME，runner 正常退出。上述证据目录有意保留；不包含仍运行的 fixture 服务或下载进程。没有读取或操作其他任务进程。

网络边界：Core 导入前安装 exact-origin `fetch`/`http(s)` guard，所有自建 Node 后代继承同一 guard preload 和隔离 HOME。2 个不匹配 origin 的负例在发起请求前同步拒绝。仅自建 `127.0.0.1:<port>/slow` 被请求。该 helper 不是 OS 网络沙箱，也不封禁所有 raw `net`/`tls` 接口；本轮脚本实际下载使用受守卫的 `http.get`。JSON 的 `unexpectedRequests:0` 是脚本常量，**不是独立的请求计数器统计**，不能当成完整网络审计断言。`engineFactory` 为抛错哨兵，本轮没有创建 Engine 或运行 provider。

## R57 / C1 [P2]：已恢复的后台下载被会话终止过滤掉（Core 原生已确认）

可达条件是已获准的交互式 `Bash(run_in_background=true)` 慢下载在其 worker 崩溃后仍存活，随后新 worker 恢复 pidfile，用户再显式删除该会话或关闭应用。不是所有普通下载都会触发，也不涉及浏览器原生 DownloadItem。生产 Bash 参数明确把 download 列为后台任务用途，且声称 session/app 退出会杀任务：`packages/core/src/tool-system/builtin/bash.ts:55–66`。真实 Bash 到 manager 的接线位于 `:192–207`；automation/headless 被 `allowBackgroundShells === false` 拦截。本次 fixture 直接调用真实 manager，**没有实际执行 Bash ToolRegistry/权限审批或模型调用**。

生产启动恢复入口是 `packages/core/src/cli/agent-server-stdio.ts:462–474`。`reapOrphansFromPidfiles` 确认 process group 存在后注册 `status:"orphaned"`，见 `packages/core/src/runtime/background-shell.ts:535–593`。同文件 `killSession:512–518` 和 `killAll:522–526` 仅枚举 `running|starting`，跳过此状态。实际 `AgentServer.handleCloseSession` 在 `packages/core/src/protocol/server.ts:2993–3002` await `killSession` 后返回 `{ok:true}`，注释明确此 ACK 是 Desktop 删除屏障。

本地原生运行使用自己创建的 quiet Node 下载；终止其管理 helper 后，下载继续向唯一自有路径写入。恢复前后 `ps` 的 **OS start time + 完整命令 + 唯一目标路径** 一致，真实 PGID 仍存活，故此处证明的是原任务，而不是刚好复用 PID 的另一个进程。恢复出的 session/shell/PGID 都与初始记录一致。实际 AgentServer RPC 和结果：

| 动作 | 已取得的结果 |
| --- | --- |
| `agent/backgroundWork` | 一项 `orphaned`，`canCancel:false` |
| `agent/backgroundWorkCancel`，正确 session/id/startedAt | `{cancelled:false}` |
| `agent/closeSession` | `{ok:true}`；下载从 49,152 增长到 73,728 bytes |
| `backgroundShellManager.killAll()` | 同一进程继续下载，增长到 98,304 bytes |
| `agent/backgroundShells` 专用 scoped kill | `{ok:true}`；进程组消失、文件稳定为 98,304 bytes |
| 普通 `running` 对照 | `canCancel:true`；相同 closeSession RPC 终止进程、状态 `killed`、文件稳定 |

因此，**Core 删除屏障和 killAll 对恢复的仍活跃下载失效**已确认，不应表述成不可恢复。专用 scoped kill 已实际恢复，支持该状态并非全局禁止终止的设计。`background-shell.ts:530–533,584–586` 也明确说恢复后应由 KillShell 清理。

Desktop 用户链只读核对：`packages/desktop/src/main/index.ts:6748–6770` 的 `deleteDesktopSession` 先 await `bridge.closeSession(id)`，再删会话历史；`packages/desktop/src/main/agent-bridge.ts:2056–2093` 在 close RPC 返回结果后正常完成。`ChatSessionManager.finishShutdown` 在 `packages/core/src/protocol/chat-session-manager.ts:612–624` 调同一个 killAll。这些是生产接线证据，**没有声称本轮实际点击了 Desktop 删除、启动真实 agent-server-stdio 或关闭 Electron 窗口**。

恢复 UI 只读核对：`packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:575–592` 只在 `running` 显示 Stop，其他状态落入 exit/signal 标签；`:220–221` 只将 running shell 计入轮询。通用取消 `packages/core/src/tool-system/builtin/background-work.ts:277–286` 又排除 orphaned。故现有面板无此状态的 Stop；**组件没有 mount/点击实测**，不将这一点记作另一个独立发现。专用 KillShell/RPC 能恢复，未验证删除磁盘历史之后所有宿主授权路径是否仍允许这个恢复操作。

所有权限定：pidfile 的 `startedAt` 是应用 `Date.now()`，生产恢复只查 `groupAlive`，并不校验 OS birth/command。不能把本次 fixture 的强归属证明推广为任意长期 pidfile 的安全终止保证，也不能建议对所有孤儿直接杀 PGID。修复应保留并适当复核足够的进程身份，给确认归属的恢复任务提供终止路径与真实删除屏障；归属不能证明时应明确反馈，而不是把成功 ACK 当成已清理。这里未测试、未另报 PID 重用漏洞。

独立性：不同于 R31（Panel 原生进程关闭没有等待 TERM→KILL），这里即便完整 await，状态筛选也完全不进入 kill；不同于 R36 的 Host stdin EPIPE，本轮下载无 stdout 写入，Core RPC 正常返回。与既有 R09/R17/R20/R34 的上传/配额/草稿生命周期及 auth-round7 的授权撤销下载管道无重复。建议 P2，影响是用户已要求关闭/删除之后仍发生网络、CPU 和磁盘副作用；不是原文件丢失、越权读取或所有任务无法终止。

关键产品文件 `background-shell.ts`、`background-work.ts`、`BackgroundShellPanel.tsx`、`protocol/server.ts`、`agent-server-stdio.ts` 在 `84740d56 → a66f4ef2` 的 diff 为空，属于旧基线已存在、本轮新发现。原生运行仅在 a66f 快照，**未运行旧基线**。

## 未确认及正常路径

Cloudflared 默认 HTTPS 下载在上游流 error 后是否遗留文件流/FD：仅有静态疑点，尚无运行证据、资源计数和正常重试对照，**未确认，不建议纳入缺陷**。安装并发、updater 迟到事件和 shell ID 跨 worker 冲突也未做独立实证，不报为新项。

其他只读覆盖没有得到新缺陷：Server workspace 文件读取持有资源并在 pipeline finally 释放，关闭时销毁活跃响应；Panel resource 下载已有持续授权复核与 finally destroy，auth-round7 已验证的下载撤销不重复跑；浏览器原生下载和 Cloud Workbench 的 Electron DownloadItem 不凭缺少产品层暂停/历史按钮判缺陷；后台面板已存在 list/output 请求代次保护，未报告迟到回包覆盖；Lightbox 保存取消返回空路径，不被当成下载成功。上述是排除理由和只读契约核对，**不是本轮新通过的动态测试**。

最终可交付：1 项 Core 原生已确认的新候选（建议 P2，完整 Desktop UI 链仅静态验证），1 个成功的隔离 native smoke 和正常/恢复对照；其他未完成候选保持未确认。

## Root分级与启动条件补充

正式列R57/P2，仅Core原生删除屏障及killAll已动态确认。Desktop完整删除成功是生产接线推断，非本轮观测；没有在fixture创建或删除真实会话历史目录。WorkerBridgeCore在崩溃时不会立即拉起新worker；后续显式ensureWorker入口（如agent/run）创建worker后，agent-server-stdio:462–474才扫描恢复。无worker时列表可回空，AgentBridge.closeSession:2062可直接返回，不能将“重开会话/启动Desktop必然已恢复”当作已证触发。当前正式条件是**新worker已成功恢复仍活跃任务之后**再close/killAll。复制保存的是实际执行的一次脚本/JSON/stdout，不为增加计数重复运行。

[第十二轮独立复核](download-quality-round12.md)保留限定P2，与R31/R36不重复；专用kill在原session域已证实可用，但删除磁盘历史后的全部授权恢复路径未实测。Sidebar视觉消失不能替代删除IPC成功证据，完整Desktop删除/退出均保持源码推断标签。
