# 第十四轮通知候选独立只读复核

结论：**建议保留 P3。** 在普通通知已经耗尽 5 条/10 秒预算、且第六条正在等待速率槽时，后到的 urgent 自动化停止通知仍被同一串行队列挡住，不能实现代码与现有测试要求的 urgent 绕过 burst 限速。当前便携证据证明的是 notifier 的 show 调用与路由 Promise 延迟，没有证明通知丢失、OS 实际呈现、scheduler 错报完成或任务重复运行。

本复核只读冻结工作区 `/Users/admin/.codex/worktrees/review-latest-20261012/codeshell`（`a66f4ef291f304ee4df9da8095a90671d9a8f140`）源码和已有 fixture/log，未启动新测试、Main、worker、原生通知、模型或网络实验。新增运行文件/测试/断言数均为 0；只写本文件。正式主报告 R45 和已有 notification-click 能力排除记录另在原审查工作区只读对照。

## 因果链与真实路由

`packages/desktop/src/main/desktop-notifier.ts:42–43` 的生产默认是普通通知每 10,000 ms 最多 5 条。Main `packages/desktop/src/main/index.ts:3349–3355` 构造 DesktopNotifier 时只注入 focused、supported 和 native show，未覆盖 rate window、limit、clock 或 sleep，因此真实应用采用上述默认。

`desktop-notifier.ts:56–62` 把每个 `notify()` 的完整 `load → notifyLoaded` 接在 `mutationQueue` 尾部。`:127–129` 明确要求 urgent lifecycle failure 绕过 burst throttling，但 urgent 判别发生在该通知获准进入 `notifyLoaded` 之后。普通第六条会在 `:162–179` 的 `waitForRateSlot()` await sleep；这段 await 仍在当前 mutationQueue 节点内部，后到 urgent 因而连自己的 urgent 分支也尚未执行。

真实停止路由 `packages/desktop/src/main/desktop-notification-routes.ts:47–69` 用 `automationLifecycleNotification(job_stopped)` 生成持久 deliveryKey，并提交标题“定时任务已停止”、`urgent:true`。mapper `automation-notification.ts:16–25,46–53` 以 job ID/runCount/type 生成 key；fixture 的 job ID、名称、runCount 满足此分支实际读取字段，不依赖伪造通知 key 或错误映射。

Main `index.ts:3519–3547` 的 requireExisting resume 请求收到 SessionNotFound 后，确实 `await notifyMissingAutomationResumeTarget(...)` 才返回 `stop`。这使延迟的路由 Promise 位于正式用户流程。Core `packages/core/src/automation/runner.ts:100–105` 在 runner 返回 stop 后才 disableWithReason，所以源码也显示该返回可能随通知等待而推迟；现有 fixture 未运行 scheduler，此项应只作为静态范围说明，不能扩张成已复现的重复执行或永久未停用问题。

## 普通 burst 在生产路径可达

Main `index.ts:3599–3601` 订阅 `agentNotificationBus`，把 result envelope 交给实际 `notifyBackgroundResult`；`desktop-notification-routes.ts:95–117` 检查 result/status/description/workId/workKind/finishedAt/from/to，`:120–140` 以不同工作身份生成独立 key，并发起**没有 urgent 标记**的 deliver。该 route 不等待上一条通知，能够在前一条 queued/sleep 时继续加入通知。

需区分 Main 与 worker 中各自的进程内 bus。可达证据不限于 worker 内部发出 result：

- `packages/desktop/src/main/automation-host.ts:245–250,295–328` 的正式 isolated automation runner 在 Main 内创建 headless Engine。`automationToolset.ts:20–35` 的禁用清单没有 Agent；明确禁止的是 background shell 工具及 Bash background 参数，不能将它误读为所有后台 subagent 都被禁用。
- Core `packages/core/src/tool-system/builtin/agent.ts:444–460` 支持显式 background Agent，并以 `agent-registry.ts:59–60` 的 `MAX_BACKGROUND_AGENTS=6` 控制并发；并非最多只能产生 5 条完成结果。各成功结束在 `agent.ts:590–601` 调用 notificationQueue.enqueue，`agent-notifications.ts:614–619` 持久 mailbox 后同步 fan-out 到 bus；其 bus `:905–917` 没有 5 条/10 秒的提前丢弃门禁。headless 运行也并未禁止该能力，`engine.ts:2171–2188` 明确等待其后台 subagent 完成。
- 其他 Main consumer 也使用同一个 notifier。例如 `index.ts:1980–1985` 的 Pet task closure 是普通通知；`pet/pet-long-task-coordinator.ts:489–492` 可对多个终态任务并行执行 notifyClosed，`:1196–1224` 通过 onTaskClosed 进入 Main 闭包。此处只是额外静态来源，不把所有清理都必然产生新通知或所有 Pet 任务都必然在 10 秒内完成作为结论。

因此“后台期间六个不同结果在同一限速窗口到达”符合生产支持范围，不需要取消限流、超过并发上限、使用非法 envelope 或借用另一进程的 bus。生产 burst 的完整模型/调度时序本次没有动态运行；fixture 在正式 Main 订阅形状上直接 publish 六个合法独立 result，动态验证从 bus/route 到 notifier 的链路，生产源头可达性由上述源码支持。

## 已有动态证据与正常对照

只读文件为 `docs/review-2026-10-12/reproductions/notification-round14/notification-queue.test.ts` 与同名 `.log`。**最终日志为 3 pass / 19 expect() calls / 0 fail / 0 skipped**，不是任务说明中的 18 断言；当前脚本逐项共有 19 次 expect。该文件是 root 已执行的一份证据，不能因本独立复核再次累加。

第一项 `:31–64` 使用实际 DesktopNotifier、actual notification routes 和实际 agentNotificationBus，保留默认 5/10,000。show 用内存记录，注入 now/sleep 只固定事件顺序：先 publish 六个不同 result；前五个 show 成功，第六个提出一次 10,000 ms sleep。此时调用真实 missing-target urgent route，两个事件 tick 后仍无该标题、Promise 未结算。释放 sleep 只推进注入 clock 10,000 ms 后，普通第六条先 show，urgent 随后 show，最终 7 个 receipts。没有将真实 OS 的呈现替身结果冒充原生通知验收。

第二项 `:66–77` 证明预算刚饱和但**没有普通通知占住 sleep**时，urgent 正常不等待；同 key 在当前实例和 store-like restart 后正确去重。此控制支持缺陷限于队列已有 ordinary wait，不是 urgent 标记被普遍忽略。

第三项 `:79–94` 证明普通通知的 focus、unsupported、show throw 都没有赚取 receipt，之后支持恢复、解除 focused、show 成功时同 key 可重试，成功后才去重；不存在由该场景证明的永久丢通知。生产 `desktop-notifier.ts:123–125,131–155` 与控制一致。旧现有测试 `desktop-notifier.test.ts:89–101` 只在上一条普通通知已完全返回后提交 urgent，所以未覆盖此次 sleep 正在持有队列的时序；`:104–116` 的 urgent 不占普通预算保护也不消除此队头等待。

clock/sleep 接口是生产依赖 seam，fixture 没有改小速率窗口或 limit，也没有把普通通知的等待伪造为通知永久挂起。本次单一 blocker 的被测等待为 10 秒；真实时延取决于剩余窗口、此前耗时和前方积压，不能把“最多 10 秒”当成全局上界，也不能声称会无限等待。

## 分级、去重与修复范围

P3 合理：需要已有普通 burst 且 ordinary sleep 已开始，随后恰好到达 urgent；系统支持的普通未聚焦背景流程可触发，但影响在当前证据中是短暂迟到和 Promise 暂未结算，恢复 sleep 后实际 route/show/receipts 均完成。普通完成通知等待而不静默丢第六条是有意设计，不应报为缺陷；问题是该等待阻止了本应豁免的 urgent。

与 R45 独立。R45 是**非 SessionNotFound 的 JSON-RPC 错误**被 Main 转为普通 reason，runner/scheduler 随后映射 completed；原 `automation-round5.md` 已明确把 SessionNotFound 的永久 stop 分支列为正常保护。本候选正用 SessionNotFound 的 urgent stop route，失败语义、文案和 deliveryKey 均正确，缺口是串行通知队列中的到达时机。修复 R45 的结果语义不能让 urgent 越过已开始的普通 sleep；修复通知调度也不能修复 R45。

已有 `search-routing-round11.md` 将原生通知点击导航协议缺失明确排除，此次继续不计。也不主张实际原生通知已送达、系统通知中心可见、所有窗口焦点行为已实测或所有自动化均受影响。

建议让普通速率等待不持有所有通知的串行执行权，或让该等待可因 urgent 到达而让出执行机会；保留同 key 去重、普通预算计费、successful show 后回执与回执更新合并。单纯给“尚未开始执行”的队列项排序不足以抢占已经持有 queue 的 sleep；也不宜简单并行改写 receipts 而失去原有序列化保护。

只读 git diff --stat 确认上述 desktop-notifier、desktop-notification-routes 与 Core agent-notifications 在初始 `84740d56e55517b004948a0a0e07649ad6fbf998..a66f4ef2` 间无差异。工作区状态只见先前已有 `?? docs/review-2026-10-12/`；产品、主报告和目标均未改。
