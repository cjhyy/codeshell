# 自动化日常流程审查，第五轮

审查对象：`84740d56e55517b004948a0a0e07649ad6fbf998`。工作区 HEAD 为报告提交后继，但本报告涉及的全部产品路径与 `84740d56` 的 `git diff --stat` 为空。没有切换分支、修改产品、重建 dist、运行真实模型或访问真实账号。

已先读 `CODESHELL.md` 和 `docs/review-2026-10-12/README.md` 的 R01–R39。下面项目与该索引无重复。建议主报告计为 4 项 P2、1 项 P3；可由主审决定是否将 A4/A5 合并为状态呈现问题。

证据目录：`/tmp/codeshell-review-20261012-automation-round5/`。

## A1 — P2：非once续接自动化超过 120 秒后退出运行保护，前一轮仍运行时可再入队同一个任务

**位置**

- `packages/desktop/src/main/index.ts:3518`：续接任务调用旧 `injectAndAwaitResult`，没有使用已具备 `waitForRunCompletion` 的 Host request 接口。
- `packages/desktop/src/main/mobile-remote/handle-client-event.ts:131`、`:166`、`:180`：120 秒整轮计时，只按最终 response `id` 匹配；`agent/runAccepted` 不清除超时，超时直接退订。
- `packages/core/src/automation/scheduler.ts:1173`：executor 一旦返回就清掉同 job 的 running/controller；它不知道 worker 仍在执行。
- `packages/core/src/protocol/server.ts:2034`、`:2068`：真实协议将续接输入交给 `ChatSession.enqueueTurn`，先发 runAccepted，再等待实际结果。

**可达操作及实际影响**

1. 在自动化详情选择“续接已有对话”，保存真实有效的对话绑定。
2. 点击“立即运行”或让定时器触发；本轮运行、排队或等待工具/审批总时长超过两分钟。
3. 两分钟时 helper 返回 `worker did not respond`，Main 返回普通结果，scheduler 结算并移除 running 状态，实际 worker 未被取消。
4. 此时再点“立即运行”，或后续计划时间到达，会发送第二个 `agent/run`。实际 ChatSession 将其排在仍在执行的前一轮后；第一轮结束后，同样的任务提示会再次执行。

这会破坏 scheduler 原本“同 job 上轮未完成即跳过”的保护，造成同一计划连续排入尚未完成的对话，也会过早产生“自动化完成”事件。**没有声称同一个 ChatSession 内两个 Engine 同时运行**：真实 ChatSession 仍保证 FIFO；缺陷是调度器过早认为本轮结束，允许堆积后继任务。

**复现**

`resume-outcome.test.ts` 第二项载入 Main 原始 `injectResumeTurn` 闭包，组合生产 `injectAndAwaitResult`、`makeCronRunnerWithResume`、`bindCronToEngine`、`CronScheduler` 和真实 `ChatSession`。只将 helper 120000ms 等待压成 20ms，fake Engine 第一轮由 gate 暂停，不访问模型。观察为：两次 `agent/run`；旧轮仍 busy 时真实 queueDepth=1；放行第一轮后 fake Engine 收到两次相同 prompt。见 `resume-timeout-observed.json`。

**保护及限定**

- scheduler 自身 `scheduler.ts:1125` 确实拒绝尚未结算的同 job 重入，问题发生于 Desktop Host 提前结算。
- 两分钟内取得真实最终 response 的普通续接不触发本项。
- 新建独立对话的 headless runner 直接 await Engine.run，不走此 helper。
- Hub `automation-worker.ts:111` 使用 `waitForRunCompletion:true`；`:123–134` 在未确认 admission 或 worker 退出时等待进程结束并抛 unknown outcome，不会以本地计时结束释放活跃 Session。
- `_signal` 在 Main `index.ts:3509` 未使用，第三项 fixture 验证 scheduler.abort 不发送 cancel；但本轮未证实独立正常 UI 入口能用该 job controller 取消续接轮次，因此不把它另列正式发现。

## A2 — P2：worker 已拒绝续接任务，自动化生命周期仍报告 completed

**位置**

- `packages/desktop/src/main/index.ts:3543`：除 SessionNotFound 外的失败转成 `{text:"", reason:res.message}`，未抛出或返回失败语义。
- `packages/core/src/automation/runner.ts:100–106`：仅处理 `result.stop`，普通 reason 不表示失败。
- `packages/core/src/automation/scheduler.ts:1144–1151`：未抛出且无 stoppedReason/cancelled 的 executor 被归类 job_end。
- `packages/desktop/src/main/automation-notification.ts:64–68`：job_end 转成 `automation.completed`、“自动化任务完成”。

**可达操作及实际影响**

有效绑定已有对话后点击“立即运行”或等待计划触发，worker/bridge返回实际JSON-RPC error拒绝该轮，例如Core会话容量/初始化拒绝；不泛指通常返回EngineResult的所有提供方错误。失败由 helper 正确识别，但 Main 随后吞掉错误状态。scheduler 仍发 job_end，发往已配置网关的控制事件宣称“已完成”，没有该错误详情；用户不能依赖自动化生命周期判断任务成功。

**复现**

`resume-outcome.test.ts` 第一项让 fake transport 返回真实结构的 JSON-RPC InternalError（`-32603`，初始化失败文本），实际 Main 闭包及真实 runner/scheduler 产生 `[job_start, job_end]`，实际 notification mapper 产出 `automation.completed`。见 `resume-rejected-observed.json`。本项没有压缩时钟，也没有使用 A1 的超时条件。

**保护及限定**

- SessionNotFound 有单独永久停止分支 `index.ts:3534–3540`；不属于本项。
- worker/chat stream 仍可能显示自己的错误；本项不声称所有错误踪迹都消失，而是自动化生命周期和网关通知错误地宣告成功。
- headless runner 的 throw 会被重新抛出并产生 job_error；Hub `automation-worker.ts:135–142` 也明确抛出 RPC error、识别 cancellation，并拒绝非 completed 的最终 reason。
- A1 需要区分 admission 与 completion 并保留活跃权威；A2 即使瞬间错误也发生，需保留失败语义，不能只提高超时值。

## A3 — P2：执行历史不用任务身份关联，真实实时记录缺失，重开后混入其他任务结果

**位置**

- `packages/desktop/src/renderer/automation/AutomationView.tsx:159–162`：本地 session 按 `session.title === job.name` 或旧 RunStore 名称筛选，忽略已有 `session.cronJobId`。
- 同文件 `:211–214`：disk fallback 只要同 cwd 且距 job.lastRun 24 小时内就接纳，prompt 不匹配也可以。
- 同文件 `:230–233`、`:1191–1200`、`:1233–1236`：按更新时间排序，取第一条为最近执行，并能打开被错误纳入的 disk session。
- `packages/desktop/src/renderer/automation/liveSession.ts:69–77`：真实 live summary 已保存精确 cronJobId，但 title 使用 Main 公告的带日期标题；Main `automation-host.ts:352–359` 构造 `${name} ${date}`。

**可达操作及实际影响**

正常执行 A 任务时，新 session 公告带 A 的精确 cronJobId，标题为“任务名 日期”。详情的完整标题相等比较不能匹配它，因此运行 session 列表可为空。重开自动化页面后，磁盘回退又将同项目 24 小时内 B 的独立自动化 session 纳入 A 的“运行 session”；如果 B 更新时间更晚，它会成为 A 的最近记录。点击该记录确实打开 B 对话，用户可能把另一项任务的输出当成 A 的结果。

**复现**

- `desktop-display.test.tsx` 第二项调用真实 `placeLiveAutomationSession` 得到带正确 cronJobId 的生产形状，真实 AutomationView 仍显示“这个任务还没有可跳转的历史 session”。见 `live-link-observed.json`。
- 同文件第三项给 A 两条同 cwd 的 automation disk session，其中 B 的标题/任务指令完全不同，仅时间相近。实际 A 详情显示 B，点击 B 调用 onOpenDiskSession 并得到 B.id。见 `cross-job-history-observed.json`。

这两个现象统一作为**执行记录缺少稳定 job 身份关联**的一项，不重复计数。

**保护及限定**

- 原始对话/侧栏记录没有丢失，本项是自动化详情的归属错误。
- disk fallback 对非空 job.cwd 有 cwd 过滤，对非 automation origin 也过滤；因此已复现影响限定为同项目的 automation sessions，不声称能访问未授权数据。
- session list 本身跳过 archived；已有 seenSessionIds/seenRunIds 会去重，但去重不能确认归属。
- 建议实时路径消费已持久于catalog的cronJobId；独立headless的state也可持久automation:job:hash clientMessageId，但它属于当前轮，后续人工run会覆盖。应为磁盘历史建立稳定job provenance，不能称现有强身份都未持久化。名称、共同项目和24小时只能做迁移提示，不应直接认领。

## A4 — P2：执行后自动停用，仍打开的自动化页面长期显示“活跃”

**位置**

- `packages/desktop/src/renderer/automation/AutomationView.tsx:305–308`：只在首次挂载读取 jobs，没有生命周期订阅或轮询。
- 同文件 `:343–345`：用户动作只在 IPC 返回后立即 refresh 一次。
- `packages/core/src/automation/scheduler.ts:924–925`：runNow 以 fire-and-forget 启动，立即返回 true；异步 authority/execution 可在页面 refresh 后才停止任务。
- Main `index.ts:3574–3588`：生命周期会刷新 task inbox 并发出通知，但没有通知 AutomationView 的 jobs state。

**可达操作及实际影响**

打开自动化详情并点“立即运行”；异步持久 Session 验证或 workspace 解析稍后返回永久停止。Main scheduler 已 enabled=false，后续计时器不再运行；仍打开的页面保留动作完成时读取的 enabled=true，继续显示“活跃”和旧下次运行。普通父层项目/session state 更新也不触发 refresh。用户会以为计划仍按时运行，直至离开重开或做另一项 mutation。

**复现**

`desktop-display.test.tsx` 第四项组合真实 UI 按钮、真实 CronScheduler/bindCronToEngine 和 gate 控制的异步停止。先让 runNow 的刷新结束，再返回 stop；scheduler.enabled=false，正常父层 rerender 后详情仍含“活跃”，listAutomations 调用数仍为 1。见 `stale-enabled-observed.json`。

**保护及限定**

- 调度器已正确停用，没有错误继续执行。
- 新打开页面可读到实际 disabled；本项仅影响当前挂载页面。
- 对周期任务完成后的 runCount/lastRun/nextRun，同样缺少后台刷新；本报告选择自动停用这条实际错报状态作为正式触发。

## A5 — P3：自动停用原因在 Desktop 摘要丢失，重开后只能看到普通暂停

**位置**

- `packages/desktop/src/main/automation-service.ts:85–106`：automationSummary 没有透传 CronJob.disabledReason。
- `packages/desktop/src/renderer/automation/AutomationView.tsx:726`：仅按 enabled 显示活跃/暂停，没有停用原因。
- `packages/desktop/src/main/task-inbox/task-inbox-sources.ts:287–305`：任务中心也只按 enabled 映射 queued/paused，summary 使用 schedule，无法补回原因。

**可达操作及实际影响**

续接对话被删除、根绑定变化或工作目录失效时，正确的 trigger-time guard 会用 disabledReason 自动停止计划。离开重开详情能纠正 A4 的活跃状态，但摘要已把原因丢弃，只显示“已暂停”，与用户手动暂停完全一样。用户不知道应恢复目录、修复绑定还是主动重新启用，失败恢复诊断受阻。

**复现**

`desktop-display.test.tsx` 第一项真实 scheduler.disableWithReason 后，经真实 listAutomations/automationSummary 载入新 UI；schedulerJob 保留原因，summary.disabledReason=undefined，新详情显示“已暂停”且无原因。见 `disabled-reason-observed.json`。

**保护及限定**

- 原因仍在持久 CronJob 中，没有把底层数据丢掉；已配置的网关可收到 job_stopped 原因，因此按 P3。
- Hub summary `hub-automations.ts:61–63` 已透传 disabledReason 和 lastExecution；此问题限定 Desktop 摘要及其 Panel/Desktop UI 消费方。

## 未发现新问题的主要路径与保护证据

1. **Desktop 绑定项目和对话**：`automation-authority.ts` 读取 durable Session 权威，stable project/root 由 Host 解析；`automation-service.ts:216–228` 在 await 后重新读取并拒绝绑定发生变化的旧更新。`scheduler.ts:890–901` 禁止运行期间修改 Session/workspace 绑定。现有 `automation-service.test.ts` 有保存、清空、非法 Session 和异步绑定竞态覆盖。
2. **Hub 编辑、启停、跨设备冲突**：`hub-automations.ts:318–356` 在授权 await 前后重查授权与 Session，按 cwd/session/appId 过滤；`:379–409` 使用 locked mutation 的 assertPanelAutomationRevision，独立写入不能被旧表单覆盖。pause/delete 可用于旧包版本，resume/update 需 revision 相符。
3. **Hub 执行与重启**：持久 receipt 在 dispatch 前写 running；`hub-automations.ts:212–249` 保存 completed/failed/cancelled/interrupted，unknown outcome 停用。`:274–294` 重启时将遗留 running 改为 interrupted 并停用；不自动重放未知任务。对应现有测试明确覆盖 receipt、startup reconcile、uncertain/cancelled。
4. **Hub 关闭和并发**：`hub-automations.ts:260–264` 等待 scheduler.abort/实际 executor teardown 后才释放 owner lease；worker `:80–84` 排除同 Session 自动化并在 finally 才释放 reservation。现有测试覆盖取消期间占用、未确认 admission 时实际退出和独立进程 lease。
5. **下一次执行及启停持久性**：CronScheduler 对 unchanged live timer 保留 nextRun，对 schedule/timezone/enabled 变化重建；暂停不会复活 timer，手动 runNow 不平移计划时间。MAX_TIMER_DELAY 分块和 cron misfire grace 已有专项测试。本轮没有发现新的调度时间算法错误。

以上保护为源码与已有测试证据，不额外声称全部真实提供方端到端通过。本轮只新运行下述七个 fixture 测试。

## 复现命令与结果

```sh
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-automation-round5/resume-outcome.test.ts
node scripts/run-bun-test-shard.mjs --timeout 30000 /tmp/codeshell-review-20261012-automation-round5/desktop-display.test.tsx
```

- `resume-outcome-test.log`：3 tests、20 assertions、0 failures、0 skipped。
- `desktop-display-test.log`：4 tests、18 assertions、0 failures、0 skipped。
- 合计 2 文件、7 tests、38 assertions，全通过。通过表示缺陷表征稳定复现，不表示缺陷修复。
- 所有 Core/Host 动态导入前安装精确 loopback origin guard；fixture 无实际网络请求。guarded runner 提供独立 HOME、应用状态和移除凭据的环境。Main closure 抽取仅用于避免启动 Electron，其生产分支未重写；timeout fixture 唯一时间缩放已在脚本和 JSON 记录。

第十八轮只读反证见[独立审计](automation-quality-round18.md)：新增运行0；R44同job再排队限结算后仍存在的非once任务，once会删除；R45限定实际JSON-RPC error被错误归类、配置/授权有效的网关生命周期链，未实际外发；R46已有catalog cronJobId及headless可持久clientMessageId，详情未消费，不能写为所有强身份缺失。三项仍P2，旧双基线2文件7测试38断言不重复累计。
