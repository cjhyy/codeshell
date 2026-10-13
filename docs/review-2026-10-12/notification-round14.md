# 第十四轮：系统通知队列与正常恢复

冻结审查快照 a66f 与初始 84740 的三个通知生产文件 diff 为空。新增便携脚本在两基线分别 guarded 通过：**1 文件、3 测试、19 断言、0 fail/skip**。未启动实际 OS Notification、Electron Main、worker、Scheduler 或模型；动态范围是实际 notification bus、routes、DesktopNotifier 与临时 durable receipt，show 和时钟/sleep 使用依赖边界替身。

## R63 / N1 / P3：紧急停用提醒排在已经等待限流的普通通知后

主要位置：[desktop-notifier:56](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-notifier.ts:56) 将所有 `notify` 串在同一 mutationQueue；队列内的 [notifyLoaded:130](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-notifier.ts:130) 让普通通知 await `waitForRateSlot()`，但其 urgent 分支必须等前一项完成才能运行。

触发条件：应用无聚焦窗口、系统通知支持，10 秒内已有五个普通结果提示显示，第六个普通提示已经进入 10 秒 rate-window 等待；随后发生需要 urgent 的提醒，如续接目标被删除或定时任务错过。它即使设置 urgent，仍在第六个普通通知后等待。单独在额度饱和时调用 urgent、而没有已等待的普通通知，能够正常绕过限流，不能写成所有紧急通知都受限流。

生产可达链：[Main:3599](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:3599) 订阅真实 agentNotificationBus，并调用 [notifyBackgroundResult:91](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-notification-routes.ts:91)，后者对 completed/failed/cancelled 的结果发布普通提示。bus 的同步 fan-out 没有等待一个通知显示完才发布下一条。独立复核确认Main内的headless Engine支持最多6个background Agent，其完成通知可从同一Main进程bus进入此订阅；不混用worker内独立bus，完整模型源头本轮仍未运行。[Main:3542](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/index.ts:3542) 在缺续接目标时 await 实际 [notifyMissingAutomationResumeTarget:47](/Users/admin/.codex/worktrees/review-latest-20261012/codeshell/packages/desktop/src/main/desktop-notification-routes.ts:47)，该 route 明确传 `urgent:true`；job_missed 的 route 同样传 urgent。Main 的这一完整错误/调度分支仅静态核对，本轮没有启动计划任务或模型。

[便携 fixture](reproductions/notification-round14/notification-queue.test.ts) 在真实 bus 上挂与 Main 相同的 route 回调，快速发布六个互异合法结果形状，使用实际 routes 与 DesktopNotifier。保留生产默认额度 **5 / 10,000ms**。注入的 sleep 只让测试能暂停该真实等待，不改排序逻辑；前五个已显示、第六个正等待时，调用真实 missing-target urgent route。断言没有紧急 show、urgent Promise 未结算；释放 sleep 并让注入时钟前进 10,000ms 后，第六个普通结果先显示，再显示“定时任务已停止”，七个 durable receipt 都存在。

这证明的是已有普通限流等待阻塞 urgent 的排队关系，没有实际等待十秒墙钟，也没有跑六个真实模型任务。合成 bus 结果不是实际 Agent 执行收据；生产 fan-out 与 notification mapping 接线已核对。fixture 的 job 只提供 route 读取的 id/name/runCount，不声称该最小对象经完整 Scheduler 配置校验。只模拟 OS show 入口，不能据此声称用户操作系统实际已收到或点击了通知。

影响是需要用户注意的紧急生命周期提醒迟到，本例等待一个普通 rate window；本例七条通知没有丢失，等待完成后均调用show并保存receipt；实际OS呈现未测试。在没有排队普通提示时，urgent 正常即时显示。若未来证明大量普通项已在前面排队，等待可以跨多个窗口，但本轮只动态验证一个窗口，不把未运行的大队列时间写成实测。建议 P3。与 R45 的 gateway/lifecycle 把失败映射 completed 不同，本例通知内容和 urgent 标记正确，缺陷在优先级无法越过限流等待。

修复应让普通限流等待不占用紧急派发通道，且保留序列化的 receipt/dedupe 提交。不要简单让所有 urgent 并发跳过 mutationQueue，以免引入相同 key 重复 show 或 durable receipt 覆盖。可以让调度器优先处理 urgent，并在普通等待结束、取得提交权后重新检查 duplicate/focus/额度。

## 正常控制与排除

- 五个普通额度已用满但没有第六项等待时，同一个真实 urgent route 不 sleep，正常显示；同 key 在进程内和重建 notifier 后均 dedupe。
- focused、unsupported、show 抛错都不赚 receipt；恢复条件后同一 key 重试可显示，随后 duplicate。真实 durable 文件只保存成功项。
- receipt 文件损坏隔离、普通 burst 等待而不丢弃等已有套件已在基线运行，本轮只读复核，未重复增加执行计数。show 成功但写盘失败的进程内 receipt 保留是明确的非事务 OS 边界设计，不当作新缺陷。
- 通知数据结构只有 key/title/body/urgent；Main 创建 Notification 后 show，没有 session 点击目标协议。缺少点击导航已在第十一轮记录为能力范围，本轮不作为新实现缺陷。没有人为给不存在的 click handler 注入旧会话场景。

两基线执行都使用项目 guarded runner 和隔离 HOME；在任何 Core/Host 动态导入前安装 `http://127.0.0.1:9` exact-origin 守卫，没有请求该地址。所有 receipt 是自有临时目录，afterEach 清理；bus listener 在 finally 释放，无网络或原生进程创建。模型/真实帐号/外部消息未使用。

两基线完成日志见 `reproductions/notification-round14/notification-queue.test.ts.log` 和 latest archive。最初版本用真实 closure route 构造普通队列，最终补真实 bus + background route，最终计数按 3/19，未把早版 3/18 重复累加。独立只读复核认可限定P3，root正式编号R63；见[通知质量复核](notification-quality-round14.md)。
