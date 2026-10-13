# G20-1：Desktop 无 live worker 的 Goal Resume 独立质量审计

**Completed。支持保留 G20-1，建议 P2，信心高。** 本审计新增测试、原生进程、模型、网络实验均 **0**，没有修改产品、主报告或作者 fixture；只读 latest `a66f4ef2` 源码及作者冻结报告、源码、日志、JSON。第二候选 G20-2 的 bound Core workspace 根因由另一审计负责，本报告不重复判定，也不借其失败提高 G20-1 的影响。

作者报告：[goal-sleep-round20.md](goal-sleep-round20.md)。最终便携 fixture：[goal-resume.test.tsx](validation/original-goal-sleep-round20/goal-resume.test.tsx)，冻结 SHA256 收据是 [source-sha256.json](validation/original-goal-sleep-round20/source-sha256.json) 中 `b9af1cb777b5fb030839600ced33d4ea369306ee7272127c9f57744d59f490b6`。已读取作者 [latest final log](validation/original-goal-sleep-round20/latest-a66f4ef2/goal-resume.final.log) 与 [initial final log](validation/original-goal-sleep-round20/initial-84740d56/goal-resume.final.log)：**各 1 文件 / 4 tests / 72 Bun expect / 0 fail/skip / Completed**。这包括两项候选及两项正常控制，不能将 72 都归到第一项。第四份历史日志 4/68 不是最终收据，前三份 harness 失败不计成功或新缺陷。root 的 portable 重跑与作者运行独立记账；本审计没有重跑其中任何一份。

## 正式 UI 与 Main 路径可达

1. 持久普通 native 会话有暂停 Goal。打开聊天后，[useTranscriptBuckets.ts:384](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/app/useTranscriptBuckets.ts:384) 调用 goalGet，并在 385–419 将磁盘 Goal 的 goalId/revision/objective/paused 投影回当前 bucket。无 worker 时 [agent-bridge-fallback.ts:146](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge-fallback.ts:146) 正常从磁盘回答 goalGet，不要求先运行。
2. [App.tsx:2093](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2093) 的 sessionChromeVisible 是 native 聊天视图条件；[2162](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:2162) 向 TopBar 传 activeGoal 和 Goal handlers。没有 workerAlive 的可用性门禁。
3. [TopBar.tsx:311](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/TopBar.tsx:311) 仅凭 activeGoal 就允许打开状态详情，373–390 渲染实际 StatusPopover。即使 busy=false、没有 tasks，暂停 Goal 也不是不可见的测试状态。
4. [StatusPopover.tsx:186](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/StatusPopover.tsx:186) 的按钮按 `!goal.paused` 调 onPausedChange；没有 worker/busy 禁用条件。实际 App [1962](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1962) → mutation [1923](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1923) → actual preload [620](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:620) 只提交带 expectedGoalId/revision 的 agent/goalUpdate。
5. [prepareAgentRunMetadata:89](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-run-metadata.ts:89) 对非 agent/run 原样返回，不存在隐藏的 Goal worker 启动。Main [agent-bridge.ts:856](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:856) 的 spawn 分支只有 run，以及后续 fork/compact；878–910 的 no-child 分支直接调用 fallback 后 return。[fallback:176](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge-fallback.ts:176) 只做磁盘 updateActiveGoal CAS，182–193 返回 updated:true，未启动、转发或排入 continuation。

native 路径不会被 external Goal handler 意外修复：[external-runtime-goal-rpc.ts:81](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/external-runtime-goal-rpc.ts:81) 对非 external Session 返回 undefined；Main [index.ts:1677](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1677) 依据实际 runtime/canonical model 判定 external。作者第一项 native seed 的 handler 未配置与这条 native fallthrough 一致；不能把 external prepareResume 的正常 ensure 视为 native 已有恢复。

## Resume 的契约确实包含驱动执行

这不是仅凭按钮名称推断。Core [server.ts:2684](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2684) 明确把 `paused:false` 作为 ESC、model failure 或 worker restart 后 unpaused-but-idle Goal 的显式 kick；2687 计算 driveRequested，2757–2775 在成功更新后调用 queueGoalResumeTurn。该逻辑同时避免 live Goal run 重复排队。

[chat-session.ts:373](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:373) 注释和实际实现要求 Resume 驱动 idle/dormant Goal；395 行 synthetic reminder 明确要求读取当前持久目标并继续执行，408 行调用 pump。这是实际生产契约，而不是文档中的未来 TODO。

正常对照也符合契约：作者第 4 项让 idle resident bound Engine 持有实际 Main resolver 生成的 Host authority，actual Core/ChatSession/Engine 恢复后运行 owned 内存 provider 一次，complete_goal 持久 terminal/completed。第 2 项 actual Core cold legacy resume 也运行一次。没有真实提供方请求；这些控制证明 Core drive 语义，不等于完整 Main→真实 worker→Electron 恢复已实测。

因此 Main fallback 的 updated:true 虽正确描述磁盘字段写入，却没有完成同一恢复操作要求的 continuation admission。App 成功路径只接受 canonical Goal 投影；它不会再发 agent/run 补救。

## 无 worker 是自然状态，不依赖人工异步窗口

[WorkerBridgeCore:129](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/worker-bridge-core.ts:129) 初始 child=null，140–143 的构造不 spawn；[AgentBridge:348](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:348) 构造 worker bridge、订阅、注册窗口与 IPC，至 431 没有启动 worker。应用重启后，尚未由普通 run/其他合法 producer 启动 worker，就可从磁盘打开暂停 Goal 并点击 Resume。

另一个自然入口是 worker 退出：[WorkerBridgeCore:245](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/worker-bridge-core.ts:245) 清 child，254–260 明确不预先 respawn，等待下一次 run。Goal 生命周期在磁盘，退出不等于删除持久 Goal。Core stdio [agent-server-stdio.ts:412](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:412) 也明确承认重启后重新打开会话本身不创建 resident ChatSession。

这些是静态生产生命周期依据，作者没有实际重启 Electron、杀 worker 或等待 native lifecycle；不能把它们写为完成过的原生操作。也不声称所有 Desktop 启动都无 worker：后台自动化/Pet/其他运行可先启动它。触发条件就是**点击 Resume 时该 native bridge 实际无 live worker**。不要把仅某个 ChatSession idle eviction、但 worker 仍活着的情形并入第一根因。

## 动态证据与正常保护

第一用例 [fixture:206](validation/original-goal-sleep-round20/goal-resume.test.tsx:206) 到 259 原样抽取完整 maintained Main agent:msg callback（保留 this 的 function wrapper），配实际 fallback/SessionManager/磁盘、actual preload RPC、原样 App Goal mutation/reconciliation closures、actual reducer 与 StatusPopover。worker boundary 是 `canSend=false`/hasChild=false 的 owned recorder，记录 ensureWorker/sendLine 调用；不是 fake worker 已启动后丢帧。

实际断言与 JSON 一致：

- 正式 Resume handler 被调用；唯一出站 RPC 为 agent/goalUpdate；返回 ok/updated true、paused false、revision2。
- 同目标 goalId 保留，磁盘已解除暂停；actual UI 删除恢复按钮、出现暂停按钮；没有 goal.update.failed 日志。
- ensureWorker=0、sendLine=0、该场景 modelCalls=0。**UI 只呈现未暂停，不证明 busy 状态变 running，也不应描述成任务已开始后卡死。**
- 后续编辑、暂停、删除正确持久；旧 expectedRevision 的更新返回 updated:false、当前 revision 不变。对应真实 [SessionManager:1401](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:1401) 的 goal identity/revision CAS 与 [1360](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:1360) 的精确删除；本项不否认这些保护。

第一场景动态磁盘 seed 是 **unbound/legacy native Session**。project-bound 情况走相同 id/Goal CAS 分支属于源码衔接，没有第一用例完整 bound/no-child 组合实测。完整 App、完整 AgentBridge/WorkerBridgeCore、native Electron IPC 和真实 worker 进程均未挂载；状态 getter/reducer bridge 替代完整 App state 宿主，Main safeSend/IPC 是 owned 内存桥。主模型/辅助内存调用的全文件计数不能当作真实模型或用户账户。

guard 在 Core/Main 导入前安装精确 origin fetch/HTTP guard、net/tls connect deny 与 child_process spawn/exec/fork deny，最终 JSON networkCalls/subprocessCalls 均0；仅进程内 guard 与隔离 HOME，不是 OS 网络沙箱或所有可能原生接口的隔离证明。清理 await server.close/dispose、自有 roots/session dirs 与 runner HOME 的边界在 fixture 明确。

## 恢复与严重程度

支持 **P2**，因为正式任务恢复操作在自然冷启动状态下确定性成功回执却不驱动任务；原目标持续闲置、用户没有失败解释，单纯暂停再恢复且仍无 worker会重复。它直接影响“继续完成持久 Goal”这个核心任务流程，区别于 R29 的临时 renderer 目录投影或 R39 的已完成恢复后多一次离开确认。

也应明确可恢复和影响上限：目标文本、id、revision、历史仍在，用户可编辑/暂停/删除；未证明文件丢失、错误项目执行、权限绕过、模型费用、永久锁死或所有聊天不可用。用户另发一条正常继续消息可能驱动任务，普通 Main run 的 [agent-bridge.ts:559](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:559) 会 ensureWorker；作者第 3 项的普通 authorized run 是 Core/service 恢复对照，**没有第一候选的完整 Desktop normal-send/worker E2E 恢复实验**。不能借它声称一键 UI 恢复已通过，也不能反过来称没有任何 workaround。

本项不是单纯解除暂停的刻意设计，Core 显式 drive 代码和正常控制已反证；不是 R44 自动化 FIFO 超时、R73 approval lease 污染或 R76 Host follow-up running 投影。与 G20-2 也是独立修复位置：这里只需在 native no-worker Resume 做正确 authority/admission/启动，根本没有进入 Core；G20-2 已抵达 Core 的 cold workspace 重建由另一审计评价。两项将来可以作为一个恢复功能的修复批次，但不能用只修其中一层宣称两者均已恢复。

建议修复保留 Goal CAS、Session/project/root/trust/owner fencing；将 paused:false 的需要 drive 情况交给真实 Core continuation，失败维持/回滚暂停并解释原因。磁盘 get/edit/pause/delete 本来可正常离线执行，不应全部无条件启动 worker；也不能靠宽放项目权限修复 Resume。

**最终：Completed；G20-1 保留 P2；作者两基线各4/72已读，审计新增执行0；无实质证据矛盾，恢复/legacy动态与bound静态/组件和原生边界均已收窄。**
