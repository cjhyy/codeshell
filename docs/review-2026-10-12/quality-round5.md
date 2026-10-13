# 第五轮独立质量复核

产品基线：`84740d56e55517b004948a0a0e07649ad6fbf998`。工作区：`/Users/admin/.codex/worktrees/server-desktop-review-20261012/codeshell`。已读取本会话的 `CODESHELL.md`、第五轮三个报告、对应脚本/日志/观测 JSON 和生产代码；`git diff --stat 84740d56 -- packages` 为空。

本轮只读产品及既有证据，没有新增或重跑测试、启动进程、访问付费模型/外部服务、改其他报告或调用 goal。下列“通过”均指既有日志，不冒充本审计独立重跑结果。

## 审计结果

九项主结论均有足够的因果和可达证据；建议保留 **7 项 P2、2 项 P3**。未发现应撤销或降为纯静态候选的条目。没有新 P1。自动化 A1 与 A2，以及 A4 与 A5，可保持独立计数：它们分别需要不同的修复，不是同一观察重复计数。

| 候选 | 对应新索引 | 建议 | 独立审计结论 |
| --- | --- | --- | --- |
| W15 | R40 | P2，保留 | 明确预入队拒绝时，后续稿 B 阻止原稿 A restore；A 的唯一产品可见副本又被移除/未建立，确有恢复损失。 |
| W16 | R41 | P2，保留 | 未确认且实际未接受的意图只在内存；草稿被 take 后未计入离页保护，刷新会销毁此副本。 |
| C1 | R42 | P2，保留 | 两种普通新建流程都可能生成已有 ID，并执行完整 upsert 替换；与显式“重新登录”更新入口不同。 |
| C2 | R43 | P3，保留 | 真实存储拒写经过 IPC reject，但 Token save 缺 catch；输入仍在，恢复存储后可重试。 |
| A1 | R44 | P2，保留 | 120 秒是最终 response 的整轮等待，accepted 不解锁计时；过早释放 scheduler 占用，真实 FIFO 可积累相同任务。 |
| A2 | R45 | P2，保留 | 即时 RPC error 被转换为普通 reason，生命周期映射 completed，并有生产网关用户通知链。 |
| A3 | R46 | P2，保留 | 实时记录忽略稳定 cronJobId；持久回退用同目录/24 小时认领其他任务并可实际打开。 |
| A4 | R47 | P2，保留 | fire-and-forget 运行后的单次刷新早于异步自动停用；当前挂载页面没有后续权威刷新。 |
| A5 | R48 | P3，保留 | 底层 disabledReason 持久存在，但 Desktop summary 丢弃字段；重新打开也无法解释自动停用。 |

## W15：挑战“丢失”与实际可恢复副本

生产 `SessionDrafts.restore` 在 `packages/web/app/drafts.ts:54–59` 拒绝覆盖 revision 已变化的新稿，是合理保护。问题在调用者：Hub `useHubController.ts:127–140` 无论 restore 是否成功都从当前 chat 删除提交的原用户气泡，`:584–587` 又删除 submissions entry；明确 rejection 不进入 uncertainSubmissions。配对端 `DesktopApp.tsx:364–388` 也不保留 restore=false 的失败稿，且 `useRemoteApp.ts:1339–1357` 在 ACK 成功前没有原消息气泡。

Workbench textarea `:721–735` 发送期间仍允许编辑，根因所需的 B 并非脚本制造的非法操作。两端都没有 composer 发送历史/失败队列来保存 A；普通 localDrafts 来自 SessionDrafts 当前 map，不包含结束的 SubmittedDraft 闭包。Hub 服务器 `headless-server.ts:958–970` 的 configuration-changing gate 和 `:990–1009` 的附件拒绝发生在转发 worker 前；配对 `handle-client-event.ts:404–409` dispatch 失败也直接回关联 error。因此可以选取真实无 accepted、无 stream、无任务持久副本的拒绝，不能以历史恢复反驳。

既有测试同时覆盖“无 B 时 A 正常 restore”对照和“有 B 时只剩 B”，支持缺陷恰在恢复冲突处理，而不是宣称所有失败都会丢稿。该文本无法从产品恢复的结论成立；报告已正确避免扩大为二进制附件已删除、已接受的任务历史也消失或永久服务器数据丢失。

与旧 R03/R04/R06 不重复：R03 是已执行后换意图重试的重复执行；R04 是迟到展开覆盖另一个会话；R06 是原生 JSON-RPC 解释失败。W15 是共享 Web 两个客户端明确未入队后的原稿保管失败。

## W16：挑战刷新保护与主机是否已接收

Workbench `:215–223` 的真实 beforeunload 只依赖 navigationDirty/uploadBusy/hasUnsent。Hub `useHubController.ts:567–572` 将 transport/timeout 提交存入 uncertainSubmissions，但 `:705–707` 的 hasUnsent 独立取普通 SessionDrafts，uncertain 还只是当前会话值。没有其他持久化 pending intent；`drafts.ts` 的 in-memory-only 注释是明确隐私设计。

既有真实 Hub 测试不是只给 controller 一个虚构拒绝：完整账户认证、真实 WS 和 HTTP session 查询均保留，传输 wrapper 仅在一次 agent/run 交给底层 socket 之前丢弃并断开。浏览器 WebSocket.send 成功进入本地发送流程不等于主机已经接收；网络断线前尚未送达是合法现实窗口。测试前后真实 session list 均为空，worker 不需要处理模型任务。普通草稿 beforeunload 会拦截，uncertain 时不拦截，证明监听器真的挂载，未以漏挂 UI 造成假阳性。

因此“刷新后唯一副本丢失”仅对实际未接受/未持久化的窗口成立，报告限定正确。若保持当前页面且成功重连，recoverUncertainSubmissions 有机会恢复；这不反驳刷新销毁 map 的缺陷。无须违反“不把敏感草稿入 localStorage”的设计，只需将待核对意图纳入离页保护并提供明确恢复状态。P2 适当；不能扩大为所有正在运行的任务刷新都会丢失。

## A1：120 秒整轮计时和真实 FIFO

`main/index.ts:3518` 的生产 injectResumeTurn 调用 `injectAndAwaitResult`，`_signal` 未使用。该 helper `handle-client-event.ts:131,166–180` 的默认 agent/run timeout 为 120000ms，只用最终响应顶层 id 匹配。runAccepted 是 method/params 通知，不会触发 done，也不取消 timer；到时 done 退订，不取消 worker。

Production `makeCronRunnerWithResume` 在有效 workspace 校验后直接 await injector；`runner.ts:100–106` 只解释 stop；scheduler `:1144–1175` 以 runner 结算释放 running 和 controller。实际 AgentBridge/WorkerBridgeCore 的注入路径执行 session/root/configuration 权威校验并转发，没有按 scheduler job ID 为这轮继续持有防重入锁。已保存的合法 Session 可以仍 busy。

Core ProtocolServer 将任务交给 ChatSession.enqueueTurn 后先发 accepted、再 await run；ChatSession `:173–191` 推入真实队列并 pump，活动任务未完成时后继仍排队。既有 fixture 没有重实现 FIFO：实际 ChatSession queueDepth=1，放行后 fake Engine 收到相同 prompt 两次。测试仅把 helper 的 120000ms 等待压为 20ms，生产固定值和通知不解除计时都已由源码核对。因此它证明的是生产机制，并非测量真实 120 秒实际耗时。

A1 限定超过两分钟的续接路径，不能称两个 Engine 同时执行；普通 headless 新会话与 Hub waitForRunCompletion 不适用。P2 合理。它与 A2 不重复：即使改为在 timeout throw，scheduler 仍会释放占用，而未确认结束的 worker 仍可能产生后果；必须额外修复 admission/completion 与运行权威。

## A2：错误 completed 是否会暴露给用户

Main `index.ts:3534–3543` 只把 SessionNotFound 变为 stop，其他 helper error 转为 `{text:"",reason:res.message}`。runner 不把普通 reason 解释为失败，scheduler 因而产生 job_end，notification mapper `automation-notification.ts:64–68` 返回 automation.completed 与“已完成”。该即时失败复现没有依赖 A1 的压缩时钟。

这不是无人消费的 mapper：生产 Main `:3580–3583` 立即调用 publishGatewayControlEventBestEffort；`:1038–1068` 经 GatewayControlServer.publish 持久发布，再交给 imGatewayService.deliverPublishedNotification。Gateway event allowlist 接受 automation.completed；真实 `/v1/events` watcher 可读；配置过授权通知目标时，`im-gateway-service.ts:724–778` 及 `chat/notification-relay.ts:106–134` 将该 event.text 送到对应渠道。这里仅静态确认生产送达链，本审计未向任何外部用户或渠道发消息。

建议主报告表格一句加“网关/生命周期”限定，避免被读成普通桌面 OS 成功通知：`notifyMissedAutomation` 只负责 missed，并不对普通 job_end 发 OS success 通知。第五轮专项附录已经正确写明已配置网关，且承认 worker stream 可能另有错误。P2 可保留：配置通知后用户确可收到错误成功回执；没有网关的用户不必然看到同样的成功提示。

## A3、A4、A5：状态与历史归属

**A3 成立且宜保持一项。** Main 自动化 announcement `automation-host.ts:352–359` 发送 name+date 和精确 cronJobId；实际 `placeLiveAutomationSession` 保存该 ID 和日期标题，`useHostSubscriptions.ts:439–495` 用它 upsert session。AutomationView `:159–162` 却用完整 title/name 或 RunStore name 关联。没有后续代码保证 date title 会改成纯 job.name。磁盘回退 `:211–214` 的 timeMatches 与 promptMatches 为 OR，同目录另一个 automation session 只靠 24 小时就被认领。列表排序后 `:603` 用首项作为 lastSession，真实按钮能打开 disk B。现有 origin、cwd、archived 和去重保护均不会确认 job 归属。没有原对话丢失或跨权限读取；P2 针对用户把其他任务结果当成本任务。

**A4 成立。** Scheduler.runNow `:924–925` fire-and-forget 后立即返回，UI action 只随后 refresh 一次；异步 workspace/Session authority 校验确可在此次 refresh 后返回 stop。AutomationView `:305–308` 只 mount 读取，无 lifecycle 订阅、focus refresh 或轮询；普通 parent rerender 不会重读 jobs。既有 test gate 控制的时序就是生产 await 可出现的时序，不依赖不可能数据。只要页面保持挂载，已停用仍显示 active 和旧 nextRun；重新打开能恢复权威。P2 可保留。

**A5 成立，P3 恰当。** Scheduler.disableWithReason 持久保存原因；automationSummary `:85–106` 不透传该字段，UI `:726` 只看 enabled，task inbox 又以 schedule 作 summary，不能兜底原因。即使重开避开 A4，仍只能看到普通暂停。网关可能收到 stopped 原因、磁盘仍有原值，限制了影响。A4 加订阅不能补回缺字段，A5 加字段也不能刷新已挂载页面，故两项独立计数合理。

## C1、C2：新增与更新语义、恢复边界

**C1 是正常新增误覆盖。** CookieTab 注释/实现把顶部 new login 与卡片 relogin 明确分开：新建 `:171–189` 从 suggestedLabel/defaultAccountName 生成 ID，重新登录 `:273–290` 才通过 fixed.id/fixed.label 保留旧身份和策略。无用户名提取脚本的普通站点会返回 undefined label；usernameScriptFor 的有限域集合已核对。ASCII slug `:102–109` 令中文不同名称统一为 account；两种新建都会碰撞。rename `:328–344` 只改 label，不改 id。

CredentialStore.save `:368–384` 的 upsert 是明确设计中的底层操作，本身不宜指责为“不该更新”。缺陷是新建 UI 不能分配独立 identity、又不审阅已存在 ID，导致意外调用更新语义。既有真实 Electron 测试保留了 save/list/patchMeta 和 on-disk store，只 stub 登录/capture；其 synthetic jar 足以证明保存行为，native keychain fallback 不影响 ID 因果。旧 jar、权限 flags、label 和 switchMode 被新记录替换有磁盘前后证据。meta.note 是 synthetic marker 而非 UI notes 功能，附录已说明。当前打开浏览器可能仍有旧 cookies，故不能说第一账号在所有地方都被注销；已保存凭据缺失需重新捕获这一恢复结论成立。P2 合理。

**C2 成立且不应升格。** TokenTab `:61–82` await save 没 catch，`:249–252` void 调用。真实存储 readGuarded 拒绝覆盖 corrupt file 是保护，error 经生产 Main/preload 传播为未处理 Promise rejection，UI 未解释失败。测试保留 draft 并恢复自身 fixture 文件后重试成功，证据支持“缺错误反馈”，不支持 Token 输入丢失或按钮永久失效。P3 与既有 Skills 409 或原生 run envelope 问题不是同一生产路径。

## 证据完整性及收束建议

既有日志计数吻合：Web 1 文件、9 tests、56 assertions；Automation 2 文件、7 tests、38 assertions；Credentials 实际 Electron 4 场景。测试结果均为对缺陷/正常控制的观察，没有声称问题已修复。产品 packages 未变更。

最终整合应保留各报告的限定：W15 预入队明确拒绝、W16 实际未接受窗口、A1 整轮120秒/FIFO而非并行Engine、A2 网关/生命周期而非普通OS成功通知、A3 同项目自动化历史、A4 当前挂载页面、A5 底层原因未丢、C1 synthetic登录/keychain未验证、C2输入可重试。除此之外，本审计没有要求撤销九项或合并其独立修复边界。
