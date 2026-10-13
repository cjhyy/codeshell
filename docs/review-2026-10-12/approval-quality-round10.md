# 第十轮：R10 / R11 / R12 / R14 / R19 独立质量复核

冻结版本：`a66f4ef291f304ee4df9da8095a90671d9a8f140`。工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`。先读 `CODESHELL.md` 与已确认索引、原 portable fixture / 最新复跑日志。以下所列根因文件 `git diff 84740d56..HEAD` 为空；新版 Panel scope 变化不改变这些控制路径。

结论：没有新增发现。R10、R12、R14 保留；R11 建议改为 P3 并收窄到连接失效但 UI 尚在线的短窗口；R19 保留条件性恢复缺口，建议 P3，必须证明错误发生时请求仍 pending，不能把所有 worker 错误或普通运行中状态当成同一种故障。

## 验证与隔离

- 新增 `/tmp/codeshell-review-20261012-approval-quality-round10.test.tsx`：5 tests / 38 assertions / 0 failures。
- 新增 wrapper `/tmp/codeshell-review-20261012-approval-quality-round10-core.test.ts`：复用 3 个现有生产测试文件，20 tests / 104 assertions / 0 failures。
- 合计 25 tests / 142 assertions / 0 failures / 0 skips。各自通过 `node scripts/run-bun-test-shard.mjs --timeout 30000 <tmp test>` 执行，runner 隔离 HOME / 状态并剥离凭据；所有 Host / Core 动态导入前安装 exact-origin guard `http://127.0.0.1:9`，未实际监听该端口或访问网络。
- R10 / R11 / R12 新测试使用真正的 `ResidentAgentProcess`、`RoomManager`、`ApprovalBridge` 与当前 `useRemoteApp` / `DesktopApproval`，子进程只是临时目录内自制的本地 stdio 协议脚本，收到 user 后发 control_request，直到收到 control_response 才落盘。它不执行 Claude/Codex、模型或账号调用。仅自制子进程会被关闭和清理。
- R19 使用真实 Core `AgentServer` 的 pending 容器与 Main `injectAndAwaitResult`，人为暂存入站处理模拟“尚未处理”，以 20ms 覆盖生产 10s 超时分支。它是延迟处理 seam，不是实际 worker 卡顿捕获；测试清楚区分这一限制。
- 当前 mini DOM 渲染了真实审批组件并调用真实按钮 props；没有启动 Electron、真实浏览器，也没有捕获真实浏览器 close 与 click 的时序。
- 未修改产品、主报告、goal 或构建产物；未 build。最后 `git status --short` 只有 root 持有的 `?? docs/review-2026-10-12/`。

## R10：保留 P2，待审批恢复缺口独立成立

生产路径：

1. `packages/server/src/mobile-remote/resident-agent.ts:84-100` 把 CLI control_request 映射为 approval_request；`:231-234` 才会真正把 control_response 写入 resident stdin。
2. `packages/desktop/src/main/index.ts:1168-1178` 将 RoomManager 请求接入 `ApprovalBridge.request(...).then(decision => roomManager.respondApproval(...))`。
3. `packages/desktop/src/main/cc-room/approval-bridge.ts:17-20,36,75-83` 仅保存 resolver / timer，不保存可恢复的完整请求，也无 pending snapshot 接口。
4. 浏览器 `packages/web/src/hooks/useRemoteApp.ts:1004` 在 CC opened 时清卡；`:1064-1067` 丢弃非当前 room 的请求；`:1195-1220` 重连 / focus 时只恢复 transcript / room.history。
5. `packages/server/src/mobile-remote/room-manager.ts:1104-1109,1120-1125` 的 approval 历史只有 tool / summary，缺 requestId、input 和可答复的身份，无法重建审批卡。

正常用户可达：已接管且正在运行的 Claude Code room 等待工具审批，用户切到另一会话再回来；或离开 / 刷新页面、重开会话。恢复后的历史可见“审批”记录，却没有可操作卡。仅观察外部 CLI 的 observe-only 会话不在此范围；Codex room 不产生该 per-tool control_request。

新本地进程对照：请求卡出现后切 native 会话，再接收同 room opened + 历史，卡为 0，子进程仍未收到任何 control_response；显式 `bridge.respond` 返回 true，随后实际 stdin 收到 denial。这补足原 hook / bridge 测试的“真实 resident 控制请求仍等待”证据，未调用真实 CLI。

保护和恢复边界：bridge 默认 5 分钟自动拒绝并 publish resolution（`:42,75-79`），关闭 room 会拒绝全部等待（`:109-127`），`onResolve` 抛错也不会阻塞 resolver（`:132-137`）。因此不是无限服务器悬挂，影响是当前可见客户端无法在剩余等待期恢复决定，最后自动拒绝原工具。另一个仍持有卡的客户端可以回答。

原报告已识别的 Desktop 保护继续成立：`packages/desktop/src/renderer/cc-room/CCConversationView.tsx:159-182` 将审批监听独立于 transcript 的 active 状态，PanelArea 保持非当前 tab 挂载；单纯在已挂载 Desktop Panel tab 间切换不会丢请求。实际卸载 / 返回列表 / 重开才暴露无 snapshot 的边界，不应泛称所有 tab 切换。

## R11：建议降 P3，排除“已经离线仍可点击”的原宽泛触发

根因仍是 `packages/web/src/hooks/useRemoteApp.ts:1450-1452`：CC 回复不检查 `socket.send` 返回值，随后立即删卡。

但当前实际入口 `packages/desktop/src/mobile/main.tsx:4,14` 挂载 `DesktopApp`；`packages/web/app/DesktopControls.tsx:306` 的 handler 在 app.status 非 online 时直接返回，`:343,361,401,405` 所有答复按钮均禁用。旧 mobile/App 不应用来扩大当前入口的影响。新实际组件负向对照将 WS 关闭并 flush 到 offline 后，允许按钮 disabled=true；即使直接调用其 handler，也不发送、不删卡，resident 仍等待。原 fixture “close 后直接 hook.respondCcApproval”不能证明 UI 可达，原 P2 离线点击表述不成立。

剩余限定条件：底层 readyState 已进入 CLOSING/CLOSED，或者 send 抛错，而 onclose / React 更新尚未把可见卡的 app.status 从 online 改掉。`packages/web/src/hooks/useRemoteSocket.ts:56-70` 会返回 false；按钮仍以 online 快照进入 handler；CC 回调忽略 false 后删卡。新对照把 readyState 设置为 CLOSING 而不派发 close，使用真实仍启用的 DesktopApproval 允许按钮，确认发送帧没有增加、卡变 0、真实本地 resident 控制请求仍未收到响应。显式 bridge 回复仍可恢复。

限制：这是确定性 transport/event-order seam，没有真实浏览器自然时序捕获；不能声称持续 offline 可以操作，也不能声称网络断开必现。以 P3 的短窗口丢卡记录较匹配证据；若要求 live browser timing 才计正式发现，也可仅留本项为已确认代码缺口候选。5 分钟拒绝 / room close 的边界同 R10；重连自身没有 CC pending snapshot，所以一旦短窗口丢卡，恢复仍受 R10 限制。

正向对照：普通 Core 路径 `useRemoteApp.ts:1563-1573` 已检查 `if (!sent) return`，不会在相同明确发送失败时消费卡。不要把 R11 扩大到 Core 或 Hub。

## R12：保留 P2，单个 CC 多题请求遗漏后续题，非并发身份混淆

生产根因 `packages/server/src/mobile-remote/room-manager.ts:195-213` 的 `askUserPrompt` 只读取 `questions[0]`；`:955-967` 在回包前消费整个 request；`:982-986` 只以首题文本构造 answers，再回送包含全部 questions 的 updatedInput。`buildAskUserUpdatedInput` 本身支持多项 answers，但调用方只提供一项。

正常用户可达：Claude Code 发出一次 AskUserQuestion，`questions` 有两个或以上问题。Desktop `CCConversationView.tsx:775-779,794-823` 和浏览器 `DesktopControls.tsx:303-322,334-349` 都只能显示上游的单个 askUser prompt；首题答复消耗整个请求，后续题没有卡可答。自制 resident 子进程新对照实际收到 `request_id=control-1` 的终结 stdin 回包，questions 长度仍为 2，answers 只有 Language?→TypeScript；第二次同 ID 在 bridge 与 manager 均返回 false。

范围限定：这是一个 control request 内的多题截断。两个独立 requestId 的问题、不同 room / session 并发是另一维度，不能据此声称串答。Core 内置 AskUserQuestion 采用单 question 参数，不走 CC questions[] 解析。Desktop 首题的 multiSelect 选项累积（`CCConversationView.tsx:777,798-830`）也不等于支持多个问题。

保护：bridge 按 roomId:requestId 关联；同 room 重复 ID 会统一拒绝而不覆盖原 resolver（`approval-bridge.ts:53-72`），RoomManager 每个请求只终结一次（`:963-967`）；其它 room 的同 ID 独立。现有两项 integration tests 实际通过，防止将 malformed duplicate 或 intentional approve-once 保护列为新问题。影响是缺失用户输入；后续 CLI 如何解释不完整 answers 依其行为，不能声称必定执行错误任务或必定崩溃。

## R14：保留 P2，Core 异步契约正确，浏览器发送门禁错误

Core `packages/core/src/tool-system/builtin/ask-user.ts:83-97` 明确 AskUserQuestionAsync 显示后立即返回、可稍后回答；`packages/core/src/protocol/server.ts:4205-4217` 标记 asynchronous=true，`:4285-4289` 返回交付 receipt，要求继续不依赖答案的工作。现有 `server.askuser-async.test.ts:160-177` 验证 asking run 已结束、session.isBusy=false，但 pending question 仍存在。本轮整套测试通过，包含答案失败后保留重试、异步提交去重、排队至其它 run 后、原权限继承、Stop/cancel、session close、idle eviction 边界。

浏览器代码依然把所有 approvals 算 busy：paired Desktop `packages/web/app/DesktopApp.tsx:332-338`，Hub `packages/web/app/useHubController.tsx:522-528,663`；Workbench `:810-826` 因此显示“等待你的确认” / Stop 而不提供正常发送，Panel 发送也在 `Workbench.tsx:28-35` 被拦截。`useRemoteApp.ts:469-479` 保留 async 卡穿过 turn_complete 是正确的；错误在把这张保留卡当作下一独立任务的阻塞条件。

用户流程和证据：实际 controller 收到异步问题、completed 后，输入无关后续任务仍 send=false，不发送 agent/run。原 portable paired / Hub hook 测试与 a66f4ef2 复跑日志均成立；本轮 Core 正向对照排除“服务器其实仍执行本轮”的反证。

范围：当前 paired Desktop Web 与 standalone Hub 的共享工作台。未据此断言 Electron 原生 ChatView 同样受影响。用户答复 / 拒绝 / Stop 等可以结束问题后恢复发送；Core 保护 pending session 不被普通 idle TTL 回收，不能期待等 idle TTL 自动解锁，也不能把这种正确驻留保护列为泄漏。

## R19：保留条件性恢复缺口，建议 P3，不能泛化 worker 错误

路径：paired Web `packages/web/src/hooks/useRemoteApp.ts:1574-1583` 的 async 分支保卡等待确认，但普通同步分支 send=true 后立即删卡；`:911-915` 的 approvalId 错误只释放 async submitting 并显示 notice，`:307-311` 约 5 秒后消失。Main `packages/desktop/src/main/mobile-remote/handle-client-event.ts:140-185,467-477` 用默认 10 秒 control budget 等 worker；失败携 approvalId 回 error，无即时恢复 / pending snapshot。

本轮严格限定的状态：原请求仍由相同 worker/session 等待，但 approve 尚未被处理，例如 worker 入站处理停顿超过 10 秒或交付在消费前失败。新 test 对真实 Core pending 容器人为暂存 approve 入站，以 20ms 触发真实 Main helper 超时，随后真实错误进入当前 hook：Core 仍 pending、决定未 resolved，卡却为 0。回放 Main `PendingMobileApprovals.replayLines` 能重新建立卡；之后释放暂存请求，Core 实际消费并 resolve。20ms 是测试注入，不改变生产 10s 常量。

反证 / 保护：

- `packages/core/src/protocol/server.ts:2399-2408` 的正常同步 approve 先移除匹配 pending、调用 resolver，立即回 ok；`:2424-2428` legacy 同理，并不等普通工具或 engine turn 完成。新正向对照直接处理可立即成功，所以“worker 正常忙 / 工具等审批”不足以触发 R19。
- 错误若只是 No pending approval / session 已关闭 / worker 已退出，不能再声称后端继续等待。`packages/server/src/mobile-remote/pending-approvals.ts:14-17` 在 worker generation 变化 / dead 时清空缓存，防止继任者接受前任请求。严格 session/request 路由拒绝是保护，也不应当作为无需条件的失败。
- `handle-client-event.ts:299-314,569-587` 的显式 session.select / session.sync 会重放 pending，实际重放实现是 `mobile-remote-orchestrator.ts:245-249`。`useRemoteSocket.ts:248-265` 在 focus、pageshow、visible、online 时触发恢复，`useRemoteApp.ts:1220-1247` 原生会话 resync 可送 session.sync；协商 outputJournal 后 `mobileOutputClient.ts:67-82` 改送带 recoveryId 的 session.select，经过授权后仍走同一 pending 重放入口。本轮新对照未协商 outputJournal，实际派发 focus，确认自动发出匹配 session.sync，随后回放可恢复；协商分支本轮只读源码核对。因此“只有重连 / 手动重新选择才能恢复”过宽；合适表述是“错误本身不恢复卡，下一次有效 resync 可恢复”。
- Hub `packages/web/app/useHubController.tsx:599-625` 直到 RPC 成功才移除卡，失败后解除 busy 可重试；Desktop CC IPC `CCConversationView.tsx:369-402` 也 await 后才删卡，reject 时保留并提示。R19 只对应 paired Web 的普通 Core 同步审批。
- Late approve 若随后成功执行，则原问题已结束；不能继续套用仍 pending 的影响。Core 有默认 5 分钟工具审批超时（`server.ts:691,4141-4155`）；普通同步 AskUser 的无超时 / goal 特例是不同类型，不从工具审批扩大推断。

限制：没有制造真实 worker 10 秒停顿，也没有付费模型 / 实际 Electron。证明的是当前恢复实现与“尚未消费 pending”的交付失败组合；原 flow-review 单纯注入 error 的日志单独不足以证明 pending。建议 P3 或保留现有较低优先级但明确条件，避免和 Hub 正确错误恢复混合。

## 可选择复制的证据

本轮源码：

1. `/tmp/codeshell-review-20261012-approval-quality-round10.test.tsx`：真实本地 stdio 控制回包、实际 DesktopApproval 正反对照、Core pending + helper 延迟 seam / focus 恢复。
2. `/tmp/codeshell-review-20261012-approval-quality-round10-core.test.ts`：guard 在导入前，复用 Core async、Core session isolation、CC duplicate-ID integration；不调用真实模型。

本轮日志：

1. `/tmp/codeshell-review-20261012-approval-quality-round10.test.log`：5 pass / 38 assertions。
2. `/tmp/codeshell-review-20261012-approval-quality-round10-core.test.log`：20 pass / 104 assertions。

原便携 fixture 与已冻结最新日志仍可保留，但 R11 原 hook 测试不是实际离线按钮可达性证明，R19 原 error 注入不是后端仍 pending 证明。建议将这两个限制与新对照放在一起，避免读者仅看旧日志扩大结论。

## 主代理收束

五项实际组件/本地stdio/仍pending控制已复制为 reproductions/quality-round10/approval-lifecycle-controls.test.tsx，使用脚本位置定位仓库，两基线各5测试38断言通过。原20测试Core正常wrapper保存在validation/approval-quality-round10/，单列现有套件，不累计到便携总数。R11/R19已按条件范围降P3，原hook/error-only日志不得单独解释为完整UI/仍pending证据。
