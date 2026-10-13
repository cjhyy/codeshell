# 第十二轮：后台下载候选独立质量复核

结论：保留 **1 项 Core 已确认候选，建议 P2**，没有新发现。建议正式标题收窄为「恢复为 orphaned 的后台 shell 被会话删除屏障和全局关闭筛选掉」。这不是普通下载全都关不掉，也不是已经实测的完整 Desktop 删除成功。R31、R36 的根因、资源归属和必要触发条件均不同，不应合并。专用 scoped kill 已有正常恢复对照，不能写成不可恢复。

快照固定为 `a66f4ef291f304ee4df9da8095a90671d9a8f140`，工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。已读 `CODESHELL.md`、第十一轮报告、3 个原生脚本、JSON、保存的 stdout，以及主报告 R31/R36 与既有资源复查。**本轮没有新跑测试、没有启动进程实验、没有查询或操作其他进程、没有构建、模型或外部网络调用。**仅写本文件；产品、主报告和目标未修改。

## 1. 既有动态证据真正证明了什么

已读 [orphan-download.mjs](validation/download-round11/orphan-download.mjs)、[crash-worker.mjs](validation/download-round11/crash-worker.mjs)、[quiet-download.mjs](validation/download-round11/quiet-download.mjs)、[原始 JSON](validation/download-round11/native-observations.json) 和 [保存的 stdout](validation/download-round11/native-run.log)。这是 **1 次原生 Node smoke、退出 0**，不是 Bun/JUnit 测试；本轮只读这些材料，不把它计作新的运行。

fixture 在私有 HOME/state 内创建自己的本地 HTTP 服务、helper 和两项下载；先让真实 manager 产生 pidfile，再 SIGKILL 自有 helper，使 quiet 下载仍存活。重新导入后的真实 manager 调 `reapOrphansFromPidfiles`；真实 `AgentServer` 接收 backgroundWork、cancel、closeSession 和专用 kill RPC。恢复时原下载的 OS start time、完整命令、唯一目标路径与崩溃前一致，进程组仍活，排除了本次观察只是 PID 刚好复用的解释。下载 quiet 输出，文件写入真实 HTTP body，故其存活不依赖 stdout pipe 继续存在。

| 已有观测 | 实际结果及边界 |
| --- | --- |
| 恢复列表 | `orphaned`、`canCancel:false`；不是 `running`。 |
| 正确 session/id/startedAt 的通用取消 | `{cancelled:false}`，没有终止该下载。 |
| 真实 Core `agent/closeSession` | `{ok:true}`；之后字节数从 49,152 增至 73,728，原进程身份仍匹配。 |
| 真实 manager `killAll()` | await 后原进程仍活，文件继续增至 98,304。 |
| 专用 `agent/backgroundShells` scoped kill | `{ok:true}`；进程组消失，文件稳定在 98,304。 |
| 同一套 Core close 的普通 `running` 对照 | `canCancel:true`，close 后状态 `killed`、进程组消失、文件稳定。 |

这里没有执行真实 Bash ToolRegistry/权限审批，没有启动 `agent-server-stdio` 整个入口，没有运行 Electron/Main，也没有创建并删除真实 SessionManager 历史目录。RPC 用的是实际 `ChatSessionManager`，但它没有 resident Engine；`engineFactory` 是抛错哨兵。因此「冷 session 的 Core close ACK 仍遗漏 manager 内恢复的任务」已实测；「完整 Desktop 删除按钮已成功删盘」未实测。原 stdout 的 `close/delete barrier` 应理解为对 Core 屏障契约的描述，不能扩大成 Main/UI 运行证据。

隔离 runner 的实现确实创建私有 HOME/state、仅保留 allowlist 环境变量，见 [bun-test-completion.mjs:15](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/scripts/bun-test-completion.mjs:15) 至 45；原脚本在 Core 导入前安装 exact-origin guard，后代继承 preload。两个负例拒绝的断言有代码支持。JSON 的 `unexpectedRequests:0` 是脚本写入的常量，不是独立网络计数器；不应把它当成完整网络审计结果。已有脚本以精确自有 OS 身份匹配兜底清理，并删除自有临时根；本轮没有重新检查进程状态。

## 2. 正式重启与冷恢复入口

生产后台命令来自 [bash.ts:55](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/bash.ts:55) 至 66：用途明确包含慢下载，并告知 session/app 退出会杀进程。真正接线在 [bash.ts:192](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/bash.ts:192) 至 207；`allowBackgroundShells:false` 与无 sessionId 均拒绝。Desktop automation 明确设置 false，见 [automation-host.ts:320](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/automation-host.ts:320)。本候选限定获准的交互式后台 shell，不扩展到 automation、浏览器 DownloadItem 或 Panel 原生下载任务。

跨 worker 恢复依赖同一 `codeShellHome()/bg-shells`：spawn 在 [background-shell.ts:244](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/runtime/background-shell.ts:244) 至 270 写 pidfile；启动后 [agent-server-stdio.ts:462](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:462) 至 473 调扫描。扫描保留 session/shell/PGID，并以 `groupAlive` 为依据注册 `orphaned`，见 [background-shell.ts:535](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/runtime/background-shell.ts:535) 至 616；没有要求恢复目标先存在 resident ChatSession。

**不要省略延迟启动门禁。** Desktop 的正式 worker entry 在 [agent-bridge.ts:188](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:188)，构造器只是把它交给 WorkerBridgeCore。实际 spawn 在 [worker-bridge-core.ts:171](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/worker-bridge-core.ts:171) 至 185。crash 的 exit handler 清 child/outbox，并明确不立即 respawn，见 [worker-bridge-core.ts:240](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/worker-bridge-core.ts:240) 至 260。后续获准 `agent/run` 在 [agent-bridge.ts:558](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:558) 调 ensureWorker；fork、compact 在 866–875；项目主根迁移也在 2152–2156 显式启动 worker。后两种入口可以不靠真实模型运行就产生正式启动扫描，但本轮没有执行它们。

仅重开历史会话、打开后台面板、手动刷新列表，不是必然启动/恢复 worker 的路径。无可发送 worker 时 [agent-bridge.ts:878](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:878) 至 902 走 no-child fallback；[agent-bridge-fallback.ts:142](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge-fallback.ts:142) 至 145 回空列表，而非扫描 pidfile。`closeSession` 在 [agent-bridge.ts:2062](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:2062) 直接返回，也不启动 worker。因此正式触发可写为「旧 worker 非正常退出，原后台进程与 pidfile 仍在；同一状态根的新 stdio worker 已启动并扫描；用户再显式关闭该 session 或关闭 worker」。不能写「任何 app 重开立即恢复并清理」，也不能把无 worker 的删盘分支作为本次动态复现。

仓库非测试调用中，直接扫描入口只有该 stdio worker。TUI 本进程或自定义 Core SDK host 不能只凭共享 manager 类型就被推定会自动扫描；同样不泛化到任意 Hub 拓扑或远端账户。

## 3. 关闭/取消入口与已有保护

| 正常入口 | 生产路径与结论 |
| --- | --- |
| Core 明确关闭 session | [server.ts:2993](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2993) 至 3002 在 await manager close 后，无条件 await `killSession`，再回 `{ok:true}`。注释明确这是 Desktop 删除屏障。`killSession` 的筛选 [background-shell.ts:512](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/runtime/background-shell.ts:512) 至 518 遗漏 `orphaned`，不取决于是否还有 Engine。已实测。 |
| Desktop 明确删除历史 | [index.ts:6748](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:6748) 至 6789 先 await `bridge.closeSession`，之后删 Session 历史、附件并 forgetSession；已恢复且 live worker 的成功 Core ACK 按源码会放行后续步骤。bridge 在 2074–2092 对 error、timeout、sendFailed/workerExit 明确抛错，是实际保护。没有 full Main 运行，不能报告已观察删盘成功。 |
| 普通应用/worker 的完整 Core shutdown | [server.ts:4918](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:4918) 至 4923 await `closeAllAsync`；[chat-session-manager.ts:612](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session-manager.ts:612) 至 624 await `killAll`。同一个筛选 522–526 遗漏 orphaned。stdio 的 SIGTERM/SIGINT/SIGHUP/stdin EOF 在 [agent-server-stdio.ts:443](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:443) 至 459 接 graceful close，graceful helper 在 [graceful-shutdown.ts:39](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/graceful-shutdown.ts:39) 至 60 等 Promise 后退出。因此不是所有 Core shutdown 都漏 await；恢复状态被跳过才是根因。已有动态仅直接 await killAll，完整 app 退出为源码链。 |
| 普通切 tab、idle eviction、ChatSessionManager.close | [chat-session-manager.ts:620](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session-manager.ts:620) 至 624 明确不在 close/sweepIdle 杀后台命令。idle 后应继续 dev server；这是设计，不报缺陷。 |
| 输入区 Stop/`agent/cancel` | [server-run-controls.ts:74](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server-run-controls.ts:74) 至 79、91–116 取消 active turn、排队 run 和审批，不调用 shell kill。不能用该入口未杀长期后台命令证明异常。 |
| 通用后台取消/任务 Inbox Cancel | [background-work.ts:277](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/background-work.ts:277) 至 286 正确校验 owner、id、expectedStartedAt，但状态只许 running/starting。UI list 的 201 行也令 orphaned `canCancel:false`；[task-inbox-sources.ts:374](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/task-inbox/task-inbox-sources.ts:374) 至 379 因此不给 cancel capability。真实 Core 正确身份取消仍 false 已实测；没有 Inbox 组件实测，不另列新问题。 |
| 专用 KillShell/后台 shell RPC | [background-shell-tools.ts:79](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/background-shell-tools.ts:79) 至 90 和 [server.ts:2958](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2958) 至 2964 调 manager.kill，后者 492–508 拒错 owner、允许 orphaned、await 真正 kill/finalize。RPC 已实际恢复；模型发起 KillShell 未执行。 |

Desktop 当前后台面板在 [BackgroundShellPanel.tsx:575](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/panels/BackgroundShellPanel.tsx:575) 至 592 只有 running 显示 Stop，orphaned 显示 exit ?；221/256 行也不将它算作轮询中的 live shell。preload 已暴露专用 kill 方法 666–671，但「API 有方法」不等于 UI 给恢复 orphan 的 Stop。请求代次/owner 显示和 late result 防护已存在；不把该展示缺口拆成第二个问题。

Sidebar 删除先移除 renderer 本地摘要并把 IPC 错误仅写日志，见 [useSessionNavigation.ts:255](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useSessionNavigation.ts:255) 至 290；**视觉消失不能证明 Main 删除成功**。独立 Sessions 页在 [SessionsView.tsx:158](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/sessions/SessionsView.tsx:158) 至 174 等待 IPC，并在失败时显示 deleteError。此处只用于核对观测应怎样命名，不扩展另一项删除缺陷。

手动恢复的条件还包括原 session 能以合适权限发起工具，或者宿主已授权专用控制 RPC。KillShell/ListShells 按当前 ctx.sessionId 限定，跨 session id 不能当作一般恢复捷径；普通新会话不会借 ListShells 枚举别的 owner。删除历史后旧会话的工具恢复是否仍可达、所有 host 的授权细节，本次没有动态闭环；不可承诺「删后随时从 UI 恢复」，也不可断言「删除后永久不可恢复」。

## 4. PID 身份、平台与优先级

生产 pidfile 的 `startedAt` 是应用 `Date.now()`（259 行），不是 OS birth。恢复判断只查 `groupAlive`（569 行），没有把命令/OS start time 与当前进程核对。fixture 的强归属证明只保证本次被杀的是它自己的原下载；不把该证明推广为陈旧 pidfile 的安全终止保证。`killProcessGroup` 在 [spawn-common.ts:331](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/runtime/spawn-common.ts:331) 至 346 已防 0/1/非整数并分 Windows 分支；这不能证明任意长期复用 PGID 的 owner 身份。本轮没有测试 PID 复用，不新增安全发现，也不建议无条件遍历孤儿 PGID 直接 kill。

已有实际平台是 macOS/POSIX、Node v25.8.1；fixture 明确拒绝 Windows。筛选逻辑是共享代码，但 Windows 的子树/崩溃存活与恢复没有实测，不写全平台复现。缺陷需要已有获准后台进程在 worker 非正常终止后存活、pidfile 未丢失、随后 stdio worker 启动恢复；不是每次 session 删除或正常下载都触发。

在这个范围内仍建议 **P2**：应用已经把活着的任务恢复为可归属记录，用户明确请求 teardown，Core 还返回成功屏障，但网络与文件副作用继续；普通取消 UI 又不提供此状态的停止。不是 P1：没有证据显示任意文件丢失、跨账户读取或通用代码执行新增风险。只因为崩溃前置和专用 RPC 可恢复，不足以把明确 teardown 的遗漏降为纯 UI P3；若报告选择只列「面板 exit ?、无 Stop」，那部分应作为同一根因的辅助展示证据，而非独立 P2。

## 5. 与 R31/R36 的去重及修复建议

R31 是 Node Hub/serve 的 **Panel process service** close 没有 join TERM→KILL Promise，Host 提前 process.exit 让定时 SIGKILL 来不及执行；这里是 Core background shell 已被恢复，`killSession/killAll` 直接筛选遗漏，即使调用者完整 await 也不进入 kill。R36 是 WorkerBridgeCore stdin 异步 EPIPE 没监听导致 **Node Host 退出**；本 fixture 使用自有 helper SIGKILL 构造 worker 崩溃，不依赖 Host EPIPE，后续 Core RPC 正常返回。崩溃可以是触发前置，但共享「进程未停止」表象不构成同根因。无需依赖 R31/R36 就能复现本项。

建议修复以确认 owner 的资源生命周期为准：

1. 为恢复任务保留并复核足够的进程身份，区分「确认归属且仍活」和「身份无法证实」。不要仅把所有 orphaned 加入 kill filter，随后对不可信陈旧 PGID 执行 destructive signal。
2. 确认归属的恢复任务应进入 session 明确删除与完整 shutdown 的终止集合，并在实际终止完成前保持屏障；无法确认/无法终止时返回明确结果，不用笼统成功掩盖未清理。
3. 在现有 owner/id/attempt 校验后，给同类恢复任务提供通用取消与明确 UI Stop/状态；保留跨 session、attempt、Host authority 门禁。不要改变普通 tab/idle eviction 继续后台服务的契约。
4. 后续修复验证应覆盖普通 running、已确认原身份的 orphaned、dead pidfile、身份不符和错误 session/attempt。若正式声称「Desktop 删除成功后仍下载」，再补完整 Main 删除屏障到自有历史目录的闭环；目前不必为确认 Core 根因启动 full Main 或真实模型。

可直接保留现有第十一轮 5 个证据文件，本轮只新增本复核说明。最新关键筛选/扫描/Core RPC/后台 UI 文件与 `84740d56` 的 diff 为空；原生运行仅在 a66f 进行，不把静态一致写成旧基线已实际运行。


Root归档注：本轮只读复核没有新增运行；正式编号为R55/W21、R56/W22、R57/C1。已接受各项限定分级，当前主索引为准。
