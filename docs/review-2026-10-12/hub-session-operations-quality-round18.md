# 第十八轮 Hub 会话操作独立质量审计

**只读新增执行严格 0；支持保留单项 HS18-1/P3。** 已核对冻结的[作者报告](/tmp/codeshell-review-20261012-hub-session-operations-round18.md)、[最终 fixture](/tmp/codeshell-review-20261012-hub-session-operations-round18/session-followup.test.tsx)、[最终日志](/tmp/codeshell-review-20261012-hub-session-operations-round18/session-followup.test.log)和实际源码。作者原始执行仅 latest：2 tests / 37 expect / 2 pass / 0 fail / Completed；本审计不认领 root 随后的双基线复跑。这里不新增正式编号，不执行测试、worker、模型或存储实验，不修改产品、主报告或 goal。

## 候选结论与生产可达性

普通 native run 已结束后，仍有效的可稍后回答问题收到合法答案，实际 Core 通过 enqueueTurn 自动开始 follow-up。Headless Host 只按前一个 agent/run 请求 ID 登记 running；该请求已结束，后续 turn 没有新的 agent/run ID，于是历史 API 的 running=false。实际 HubSessions 因而允许归档，并经真正 HTTP session service 写 archivedAt、从当前历史列表隐藏行，而实际 Core 仍忙。

生产入口有源码支持：AskUserQuestionAsync 是公开 builtin，定义 [ask-user.ts:78–87](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/ask-user.ts:78) 说明立即返回、之后答案作为新 user message；[128](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/tool-system/builtin/ask-user.ts:128) 调 ctx.askUserAsync。AgentServer [1024–1031](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1024) 给 interactive session 安装实际 callback；[4187–4197](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:4187) 核 session identity、route ownership、cancellation generation，问题并非绕过已取消/已失效授权的任意 follow-up。

HubApprovalCard [40–59](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubApprovalCard.tsx:40) 有正式回答控件，connected/非pending/非空答案才可提交；实际 controller [599–615](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/useHubController.tsx:599) 发 approve 并按 ACK retire。候选测试直接发送真实认证 WS agent/approve，没有渲染并点击此回答卡；该前半 UI 入口是静态核对，不能称完整问答 UI E2E。

**自动第二 turn 的因果是实际 Core，不是 fakeEngine 或测试直接发第二次 agent/run：** server [4233–4253](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:4233) 调实际 deliverAsyncUserAnswer，携带原 turn options、workspace resolver、onStream/onBoundary；[async-user-answer.ts:34/38–55/67–83](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/async-user-answer.ts:34) 在 idle/未 steer 时 enqueueTurn，clientMessageId 为 ask-user-requestId。Core ownership 和取消控制保留；fixture 断言真实 ChatSession.isBusy、runs===2 以及真实 envelope 的该 clientMessageId，且原 run 已 ACK、Host pending response 已为 0，排除了仅 HTTP/WS 旧回包尚未消费的时间窗。

## Host 没有遗漏的补偿 running 路径

headless-server [220/238–239](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:220) 的 isRunning 只查询 runningSessions map 或 automationWorker.ownsSession。普通 browser agent/run 经过 [1163–1167](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:1163) 以 workerRequestId 注册；对应 response [468–479](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:468) 删除，并发 running:false。

完整 follow-up agent/streamEvent 走 [356–381](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:356)，仅 publishStream；后者 [257–271](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:257) append replay/广播，不向 runningSessions 注册。agent/runAccepted [384–399](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:384) 处理原 request 的 input/路由，也没有凭 Core 新 turn 修补 map。Core observeRunBoundary [server.ts:1571–1573](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/protocol/server.ts:1571) 只是调用 process-local protocol observers，不是给 Headless Host 创建一个外部 run 请求 ID。没有另一条 event-based active-turn 计数被漏审。

真实 automation reserve [1230–1254](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:1230) 自有 running 登记/释放，isRunning 也查询 automation owner，因此不把本次普通 native async-answer fixture 扩成所有 automation、所有 Core wakeup 或所有 session 的归档失败。

## 正式归档 contract、正常保护和影响界限

createHubSessions 由 Headless Host [653–664](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/serve/headless-server.ts:653) 注入同一个 isRunning；summary [session-management.ts:181–201](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/session-management.ts:181) 的 running 直接用它。PATCH [333–336](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/session-management.ts:333) 明确运行中拒绝归档/恢复，export [280–281](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/session-management.ts:280) 也拒绝运行中导出。HubSessions [435–438](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:435) 同样禁用 entry.running 的归档按钮。这是已有 contract 的运行态漏算，不是自行发明「运行中归档必须禁用」的新要求。

fixture 的正常原 agent/run 期间，真实 PATCH archive 和 export 均 409、archivedAt 未写。follow-up 时 Core busy=true、API running=false、实际归档按钮可点，等待真实服务写 marker、实际 response 回到 onChanged 后才断言 current 行消失；不是抢在 response 消费前看 state 的 harness 假象。

P3 限定为活动状态错误及不符合既有门禁的归档，历史列表当前行隐藏。没有证明 follow-up 被停止、回答丢失、权限扩大、文件/历史删除、模型重复执行，不能升为 P2 安全或数据损坏问题。服务写 marker 使用 [SessionManager.setSessionArchived:1158–1159](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:1158) → field patch [1561–1566/1585–1603](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/core/src/session/session-manager.ts:1561)，并非删除 session。fixture 明确断言磁盘 state.sessionId 仍在；fakeEngine 不做实际 Engine transcript append/终态 flush，不能把此断言扩大成已经动态校验后续真实 run 的全部消息落盘、marker 后续保持或各种并发写盘无损。

## 恢复

动态控制为同一实际 HTTP API archived:false 返回 200、真实 archivedAt 清除，随后释放 owned follow-up gate，实际 Core 正常 idle，session state 仍存在。没有执行 Stop/cancel 来恢复，因此只说恢复归档和自然完成。

正式 UI 恢复也有静态入口：HubSessions [292–296](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:292) 可切已归档/全部；列表 API [229–233](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/session-management.ts:229) 支持 archived filter；归档行的 [435–438](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:435) 按钮为恢复，或 open [253–256](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:253) 先 PATCH archived:false，mutate [173–186](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:173) 成功后回调 onOpen。该 UI 恢复没有在候选测试里动态点击；不冒充完整恢复 E2E，也不称会话永久消失。

## fixture、隔离和计数边界

候选运行的是实际 Headless Hub auth/setup、Cookie、Origin、HTTP、WebSocket、session routes、HubSessions、AgentServer/ChatSessionManager/ChatSession 和 Core 自动 enqueue helper。WorkerBridgeCore 被替换成 memory transport；其 emit 转发候选里的全部 Core 通知与 WS-dispatched responses，未过滤 run/status/stream。内部 correlated `request` 自有 pending 返回分支属于该 seam 的 Host request 模式，不是删除本候选的 follow-up通知；候选 WS inject 走 receive → AgentServer → emit → routeWorkerLine 的实际链。真实 stream 中的 session_started/turn_complete 内容由 fakeEngine.run 经 onStream 发出，但 envelope、follow-up admission/pump、busy 与回答 ACK 是实际 Core。

fakeEngine 边界是模型/工具执行、run 等待和 stream payload；测试自行调用已安装的 async question callback 来构造正常提问场景。它没有实际 Engine、LLMClientBase/provider、native worker/子进程、完整 Workbench 或真实浏览器。fixture 另建了真实磁盘 source，仅用来给 HTTP SessionManager 读写；不把 fakeEngine 的运行状态当成真实 Engine 已保存磁盘 run state。

Core/Host import 前已有 exact owned loopback guard，direct net/tls deny，WS wrapper 只允许同一个 reserved origin；guarded HOME 要求在 fixture 入口。finally 释放两等待 gate、unmount/移 DOM、关 WS、await Host.close/Core server.close、删 owned temp。这个小 shard 的 global fetch/WebSocket/module mock 在当前测试进程保留；不宣称恢复全局为原值，也不将它与其它不隔离测试共进程并跑。**本审计没有自行启动任何上述运行或清理命令。**

已另只读审作者追加的 title 正常控制：actual HubSessions editor → HTTP createHubSessions → actual SessionTitlesStore，认证仅 owned Cookie predicate，**不是另一次真实 HubAuth 运行**。其它设备先提交 B 后，C 草稿遇 CAS409仍保留，原保存禁用；实际「读取最新标题」只更新 expectedTitle/reviewedTitle 而保留草稿，核对后保存 C。源码保护为 HubSessions [189–198/219–230/304–306/351–353](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:189)，SessionTitlesStore [169–174](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/session-titles-store.ts:169) 校验 expectedTitle；同步 write.current [165–167](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/web/app/HubSessions.tsx:165) 防同 tick 两次 form submit，fixture 两次 submit只得到一个 PATCH，不列重复提交发现。

最终追加的 500 控制将 owned session-titles.json 暂存后在原路径建目录，实际 registry 拒写，UI 保留 D 草稿且同稿可重试，恢复文件后成功；**这是非文件 registry 错误，不是成功的 EACCES 控制。** 独立的 parent chmod/EACCES 诊断因为 lock 等待超过 test deadline 失败，保留于 diagnostic-parent-EACCES-lock-timeout.log，不用于正式正常控制或新增发现。404 控制把 owned session dir 暂移，UI保留 E 草稿并禁保存，恢复后显式读取才重启提交，同稿成功，generated Engine title 保持不变。元数据错误状态映射见 session-management [341–355](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/server/src/hub/session-management.ts:341)。没有把这类测试构造的错误目录/临时移走直接称为普通生产事件。

冻结的最终作者日志为 2 tests / 37 expect，其中候选 17、标题正常与恢复控制 20；1 file，2 pass，0 fail/skip，Completed。原始作者只在 a66f latest 执行，本审计新增执行为 0；早期 harness failure 日志不算产品缺陷或额外通过测试，独立 EACCES 真实 Bun 诊断也不算本轮发现。最终日志保留 12 条 React act 警告。候选通过 until 明确等待真实 archive response 被 onChanged 消费和对应 DOM 提交，正常控制明确等待错误/保存结果；它不能扩成 native 浏览器布局/焦点或完整多设备 UI 并发覆盖。

两冻结产品基线的静态比较中，HubSessions、session-management、async-user-answer、Core server/ChatSession、回答卡及 controller 的相关路径一致；headless-server 的变化仅为无关的 Panel projectScope 导入及路由处理，不改变本候选的 running 登记、帧透传或归档 gate。本文精确行号按 a66f latest；84740 在无关新增代码之后有行号偏移。两基线动态适用以 root 自有 guarded 复跑收据为准，不把外部报告的复跑混入本审计或作者原始计数。

## 去重和修复范围

与 R73 独立：R73 是 configuration mutation admission 之前 submit lease，合法答案未派发、重试/重连排除旧题；本候选配置不变，approve ACK 成功且真实第二 turn 正在运行，缺的是 Host 活动投影与归档门禁。改 submit/admission 次序不能修这里的 running 误判。

与 R72 独立：R72 是 Desktop Settings 恢复仅改 renderer catalog，Core archivedAt 仍在并使 root 使用保护误判；这里 API 真正写/清了权威 marker，问题发生在 active turn 时错误放行归档，没有工作区 root 移除或 catalog/marker 不一致证据。R14 的未回答异步问题阻塞新任务也不是该已回答后实际 follow-up 场景。

建议把 Host runtime activity 的来源覆盖到真实 Core 的内生 turn，并保留多个并发 run/queued follow-up、automation ownership 和终态身份保护；不能简单用每个 stream frame 无条件 toggle boolean。归档 HTTP/UI 使用同一权威活动态，无须为本候选另造数据损坏发现。
