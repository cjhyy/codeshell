# Goal 暂停、冷恢复与 Sleep 流程审查，第 20 轮

Completed。仅审查产品，不修改产品或主报告，不 build/clean，不启动真实 Electron、worker、CLI、模型请求、账户或网络 listener。已读 CODESHELL.md、主报告 R01–R77、flow-coverage 与 automation-round5 去重。范围是两个冻结产品快照 `84740d56e55517b004948a0a0e07649ad6fbf998` / `a66f4ef291f304ee4df9da8095a90671d9a8f140`；下列关键产品文件两快照 diff 为空。全部 fixture、原始日志及本报告仅在 `/tmp/codeshell-review-20261012-goal-sleep-round20*`。

**确认两个不同根因的冷恢复候选 G20-1、G20-2；建议各 P2，最终去重/分级由主审决定。** 两者都让合法持久目标的正式恢复路径不继续任务，但修复不同：第一个停在 Desktop Main 无 worker 分支；第二个已经抵达 Core 且真实 Engine 在模型前拒绝缺失 workspace authority。它们不是 R44–48/R63 的自动化状态/通知问题，也不是 R73/R76 的异步回答 admission 或 Host busy tracking。建议保留各自入口与恢复控制，即使主审按用户症状合并。

## G20-1 — Desktop 冷启动无 worker 时，恢复目标仅改持久 paused，未启动 continuation

**触发与影响。** Native CodeShell 会话已经有暂停目标；重启 Desktop 或 Core worker 退出后，打开该磁盘会话，在状态 popover 点击「恢复」。这是合法而常见的冷状态，初始创建 AgentBridge 本身不启动 worker，Main 的默认恢复需要后续普通 run。实际恢复操作通过 CAS 成功持久为未暂停，UI 从「已暂停 / 恢复」变成「暂停」，但 Main 没有 ensureWorker、没有发送任何 worker 请求，也没有后续 continuation。因此未完成目标继续闲置；界面无此次失败解释。没有把单独 paused=false 值解释成「运行中」；缺陷依据是**同一个恢复操作在正常 Core 路径具有显式驱动目标契约，冷 Main 分支却只做状态写入**。

**源位置。**

- [StatusPopover.tsx:189](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/topbar/StatusPopover.tsx:189) 的正式按钮调用 onPausedChange(!goal.paused)，191–193 依据 paused 显示恢复/暂停。
- [App.tsx:1962](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1962) 进入 Goal mutation；[1923](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/renderer/App.tsx:1923) 只发 goalUpdate，1929–1942 将 updated:true 视为成功并接受返回投影，没有随后 run/ensure。
- [preload/index.ts:620](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/preload/index.ts:620) 将该 API 发成 agent/goalUpdate。
- [agent-bridge.ts:856](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:856) 只有 run、fork、compact 进入 ensureWorker；[878](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:878) 无 worker 时走 fallback 并 return。普通 run 的实际 spawn seam 在 [559](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge.ts:559)。Main 构造 AgentBridge 入口为 [index.ts:1553](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:1553)；没有把任何外部 CLI 的 prepareResume handler 误当成 native 路径。
- [agent-bridge-fallback.ts:158](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/agent-bridge-fallback.ts:158) 接受 goalUpdate，176–193 只调用 updateActiveGoal 并返回成功。
- 正常契约：Core [server.ts:2684](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2684) 明确 paused:false 对 idle Goal 是 drive request；[2757](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2757) 在成功后 queueGoalResumeTurn，[chat-session.ts:373](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:373) 队列中的实际提醒要求继续目标。

**动态证据。** 最终 fixture 第 1 项使用完整生产 `agent:msg` Main callback 的原样抽取、actual fallback/SessionManager/磁盘、actual preload RPC、App Goal mutation/reconcile closures、actual transcriptsReducer 和 actual StatusPopover。只把完整 Electron/AgentBridge 进程宿主替换为 owned IPC 及 `canSend=false` 的 worker 边界；未改分支逻辑。此项磁盘 seed 是 unbound/legacy native Session；fallback 对 project-bound Session 同样只按 id/Goal CAS 操作，没有绑定类型分支，故 bound 情况仅源码推断，不宣称此项也实际执行了 bound/no-child 的完整组合。点击正式恢复按钮后：

- 返回 `{ok:true, updated:true, paused:false, revision:2}`，磁盘同目标同 id 为 active；UI 恢复按钮消失、暂停按钮出现。
- `ensureWorker=0`、`sendLine=0`、`modelCalls=0`，唯一发出的消息为 agent/goalUpdate；没有 goal.update.failed 日志。
- 随后的编辑、暂停、删除都正确持久；旧 revision 的更新返回 updated:false，不改当前 revision。它们本来可以是 disk-only 操作，不属于本项。

**正常与恢复对照。** 第 4 项同一合法 bound Goal 在 resident Engine 已持有实际 Host authority 时，恢复经真实 Core/ChatSession/Engine 运行一次内存 provider，complete_goal 真正持久到 terminal/completed；第 2 项 cold legacy 无绑定目标同样运行一次。用户可手动发一条继续消息绕过此入口：普通 native run 的 Main ensure 接线为上述源码，第 3 项实际 Core 普通 authorized run 成功；本轮没有动态启动完整 Main normal send/真实 worker，不能把该服务级恢复写成完整 Desktop 端到端通过。暂停再恢复且仍无 worker会重复本项，单独修正文案也不会启动目标。

**建议。** 将 native paused:false 视为需要实际 continuation admission 的操作，先安全确保 worker 并保留 Session/project/model authority，再交由 Core 执行；失败时保持/恢复 paused 状态并显示原因。不能为了恢复直接绕过项目、信任或 Goal revision gate，也不能把所有 edit/delete 都无条件启动 worker。

## G20-2 — 有 worker 但 bound Session 非 resident 时，Goal 冷恢复漏 Host WorkspaceContext，模型前失败被当作已续接

**触发与影响。** Desktop worker 已为其他会话活着，但当前暂停目标所属的合法 project-bound Session 尚未 resident（例如重启后先在别处运行，或原 Engine 已被 idle eviction）。点击恢复能抵达 Core：Goal CAS 先变 active，Core 准备 synthetic resume，但冷重建仅带 cwd/projectTrusted，没有从 Host 重建 WorkspaceContext。真实 Engine fail closed，返回 `text: "ERROR: bound Session requires an authoritative WorkspaceContext"`、`reason:"model_error"`、`turnCount:0`、全部 usage 为 0。这里的 model_error 是**workspace 初始化失败的结果枚举**，不是提供方/网络/模型错误。

随后 enqueueGoalResumeTurn 对所有 resolved EngineResult 返回 true，协议仅 catch rejection 触发回滚；此模型前失败既没有被公开成 error，也没有将 Goal 暂停回来。用户只看到目标未暂停，任务没运行，无法从此次恢复结果得知原因。没有实际执行错项目或越权；项目 authority gate 正确拒绝了执行。

**源位置。**

- [server.ts:2546](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2546) 冷 path 调 getOrCreatePersisted(sessionId,{projectTrusted:false})，2555–2562 enqueueGoalResumeTurn 只传 onStream/approvalRouter，没有调用 resolveHostSessionWorkspace。
- [chat-session-manager.ts:380](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session-manager.ts:380) 冷恢复 probe 后读取 cwd，397–401 只 spread 传入 slice 和 cwd，没有恢复 project roots 权威。
- Desktop worker [agent-server-stdio.ts:300](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:300) 的实际 engine factory 原样消费 slice.workspaceContext；[426](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/cli/agent-server-stdio.ts:426) 明确启用 workspaceBridge，436–438 提供同根 Goal disk callbacks。因此不是仅自定义 SDK factory 忘记提供配置才会失败。
- [run-workspace.ts:188](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-workspace.ts:188) 拒绝 bound Session 无权威 WorkspaceContext；[233](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/run-workspace.ts:233) 构造精确 model_error/turnCount0 结果，Engine 在 [engine.ts:1539](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/engine.ts:1539) 直接返回。
- [chat-session.ts:405](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/chat-session.ts:405) 忽略 resolved result 而 resolve(true)；[server.ts:2769](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:2769) 仅 rejection 才 reconcileFailedGoalResume。
- 可复用的实际 Host authority seam 是 [server.ts:4693](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:4693)，正常 background wake 在 [950](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:950) 会调用它；本报告不要求绕过这个 gate。

**合法 bound authority 与动态证据。** 第 3 项不是任意造 protocol 参数：在 own 临时目录使用真实 ProjectStore.createFromPath 注册目录、实际 canonical root identity 和持久项目 registry，用真实 SessionManager 写入该项目/root 绑定，真实 SessionCwdIndex 从磁盘刷新。再调用实际 Main resolveSessionRunWorkspace（内部实际 prepareAgentRunMetadata → ProjectStore.resolveRunProjectSync）取得与绑定完全相符、根目录健康的 authority，正常恢复对照消费此结果。Git root folding 参数固定返回已选的本地 owned 目录，以禁止任何 Git CLI；挂载身份/registry/CAS/解析仍实际。

失败 path 本身使用 actual AgentServer(workspaceBridge:true)、actual ChatSessionManager 冷重建、actual ChatSession、actual Engine 与磁盘。Engine.run 仅外包记录，完整 delegate 到生产 run；没有替换 run result。实际观测：

- 只有两个 factory slice（probe、实际 Engine），后者无 workspaceContext；正式 GoalUpdate 返回 updated:true/paused:false/revision2。
- 实际 synthetic turn 返回上述精确 workspace error，模型调用为 0；没有 Host `__workspace_action__` 请求，因为恢复 path 从未请求它。
- Goal 持久 lifecycle 仍 `active`，没有 stream error 或 session_started，队列已闲置。
- 随后普通 agent/run 携带**前述实际 Host resolver 的 authority**，同一 real Engine 成功运行一次内存 provider，持久 terminal/completed；它是 service-level ordinary run，对完整 Main normal-send/worker 没有新增执行声明。
- 第 4 项 idle resident bound 目标带同一实际 Host authority，Resume 一次正常完成；第 2 项 unbound legacy cold Resume 正常。排除了「所有目标恢复都坏」「任何冷重建都坏」和「故意拒绝非法项目」三种泛化。

**建议。** 在 cold synthetic continuation 前经已存在 Host workspace resolution 通道重建权威，与普通 run/后台结果唤醒对齐。对 pre-loop turnCount0/model_error 保留失败并暂停回滚/显示真实诊断，不能把所有 resolved EngineResult 当成功启动。继续保留 Goal identity/revision、owner、关闭/根变更等 fencing；禁止以合成 legacy context 绕过 bound Session gate。

## Sleep、取消、waiting 与去重排除

本轮 Sleep 和其他 Goal 控制以只读源码/已有测试审阅为主，新增动态运行只有上面最终 4 项，不把旧测试计入。没有确认新的 Sleep、定时器数学或长任务截止算法问题：

- Sleep 实际 clamp 为 0.1–300s，已 aborted 立即返回，运行中 abort 清 timer，正常完成 remove listener；运行中 abort 后其 acknowledgement 仍使用 Slept 文案可改进，但 TurnLoop/ChatSession 的实际 abort 停止语义另有 gate，不能只凭 acknowledgement 升成任务继续执行缺陷，未正式收录。见 [sleep.ts:8](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/sleep.ts:8)。
- Goal pause 的既有契约是当前模型/tool step 后的安全边界，updateGoal 不 abort 已开始工具；因此暂停期间 Sleep 未立即结束不能独自作缺陷。见 [engine.ts:4075](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/engine/engine.ts:4075)。
- Stop 的 cancelledSinceLastTurn sticky flag 与 cancellation epoch 已存在；background wake 在 authority await 前后重复检查 cancellation/owner，并在消费前验证 Engine 与 settled boundary，不能将普通后台完成一概写成绕过 Stop。见 [background-result-wakeup.ts:94](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/background-result-wakeup.ts:94) 和 [133](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/background-result-wakeup.ts:133)。
- waiting 只在真实 running background work 非空时接受，之前先持久 active→waiting；Goal continuation 和 update/delete 有 goalId/revision fencing，恢复队列合并同 goal pending entries、后续 pause/delete 会在 queue head 跳过。没有以人造永不 settle Engine 当作新问题。
- Goal token/time tracker 明确是 run-scoped；不能将一次新的合法用户 run 重置 run budget 本身写成跨所有时间的预算泄漏。文本截止交由 judge 及 setAtMs 原锚，本轮没有真实模型判断实验，未声称所有自然语言截止都准确。

## 最终复现与边界

冻结脚本：[goal-resume.test.tsx](/tmp/codeshell-review-20261012-goal-sleep-round20/goal-resume.test.tsx)，SHA256 `b9af1cb777b5fb030839600ced33d4ea369306ee7272127c9f57744d59f490b6`。全部三份 fixture source 同 SHA，[source-sha256.json](/tmp/codeshell-review-20261012-goal-sleep-round20/source-sha256.json)。产品源码未改。

| 快照 | 实际命令 cwd | 最终日志 | 最终结果 |
| --- | --- | --- | --- |
| 84740d56 | primary review worktree | [initial 最终日志](/tmp/codeshell-review-20261012-goal-sleep-round20/initial-84740d56/goal-resume.final.log) | 1 文件、4 tests、72 expect、0 fail/skip、Completed |
| a66f4ef2 | latest frozen worktree | [latest 最终日志](/tmp/codeshell-review-20261012-goal-sleep-round20/latest-a66f4ef2/goal-resume.final.log) | 1 文件、4 tests、72 expect、0 fail/skip、Completed |

命令是 `node scripts/run-bun-test-shard.mjs --timeout 30000 <该快照对应 goal-resume.test.tsx>`；没有绕过 maintained runner。最终 JSON：[84740 observations](/tmp/codeshell-review-20261012-goal-sleep-round20/initial-84740d56/observations.json)、[a66f observations](/tmp/codeshell-review-20261012-goal-sleep-round20/latest-a66f4ef2/observations.json)。每次 `networkCalls=0`、`subprocessCalls=0`；正常控制/恢复的主模型调用 3 次，辅助调用 3 次，均为注册的 owned LLMClientBase 全内存实现，真实提供方调用 0，不计为付费模型。fixture 删除所有自己创建的临时 roots/Session directories，runner 清理隔离 HOME。

导入 Core/Main 前安装 maintained 精确 `http://127.0.0.1:9` fetch/HTTP guard（没有启动该 origin），并拒绝所有 net/tls connect、spawn/spawnSync/exec/execSync/execFile/execFileSync/fork。每项 cleanup 断言两类调用都为 0。该守卫是进程内保护，不是 OS sandbox。没有 operator HOME 或 credentials、真实账号/CLI/worker/Electron/外网；完整 App 和完整 AgentBridge/WorkerBridgeCore 未挂载，Main callback 与 App closures 是原样源码抽取，actual renderer组件/reducer/preload/RPC/Core/Engine/disk 各层已明确。

## 保留的 harness 诊断，不计正式成功数或新缺陷

- [first.log](/tmp/codeshell-review-20261012-goal-sleep-round20/goal-resume.first.log)：3 fail/27 expect。Bun.Transpiler 在顶层抽取 callback 时将 this 改为 exports，造成 Main harness 无回包；另两个内存计数把辅助 title 请求也算入主调用，断言预期错误。与产品无关。
- [second.log](/tmp/codeshell-review-20261012-goal-sleep-round20/goal-resume.second.log)：2 pass/1 fail/35 expect。已区分 auxiliary，仍有顶层 this→exports 的同一 harness 问题；日志捕获确切 `exports is not defined`。
- [third.log](/tmp/codeshell-review-20261012-goal-sleep-round20/goal-resume.third.log)：与 second 同一诊断；加存 extracted JavaScript 以定位 transpile，不是第三个新产品错误。
- [fourth.log](/tmp/codeshell-review-20261012-goal-sleep-round20/goal-resume.fourth.log)：4 pass/68 expect/Completed 的先前成功版本，修复为在 function 内原样抽取，保留this语义；已加入真实 ProjectStore/Host authority 与 resident bound control。最终 source 额外加入 subprocess deny 与每项 0-calls 验证，正式最终为上述4/72，不能将4/68再累计。

所有 extracted JS 是 harness 调试证据，不是产品更改；最终目录各自保留原样抽取结果。
