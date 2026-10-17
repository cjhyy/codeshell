# Chat 投递停止与持久队列交接：有限静态候选

作者分类 **0 正式 / 1 候选 / 0 新 related**：`CHAT-R138-C1`，建议 P2，等待独立反证与 Root 决定。固定产品上下文由 Root 提供为 `f31a847f45e4805bce34aeb9e6db7efb503cfcb0`、branch58；本作者没有调用 Git。只写本 tmp，0 产品导入/函数/fixture/测试/进程/账户/网络/native 执行。

**候选原因。** `packages/chat/src/delivery-queue.ts:131–137` 的 `stop()` 只停标志和定时器，`241–315` 已启动的投递仍可完成并在308写盘。`537–571` 持久化整个实例的 `pending/completed`，`580–592` 只串行化同一实例。真实调用 `chat-gateway.ts:144–186` 创建队列并仅等待 adapter runners；finally 不等待投递便 `queue.stop()`。CLI `cli.ts:138–144` 等 gateway/watch 后释放 lease；`instance-lock.ts:76–90,156–159` 创建后即关 fd，release 删除自己的 marker。因此旧投递结束前，新 CLI 可以取得同一配置的 lease。

**正常入口反证已核。** package bin 指向 CLI，CLI 是 Node 入口，317–320 只设 `exitCode`，没有强制 `process.exit`。Mimi 正常 middleware `gateway.ts:224–243` 调 `petChat`；`desktop-control-client.ts:101–118` 待完成轮询不接 CLI shutdown signal，request275–291仍创建局部 timeout；相反 watcher 的151–190/208–218确实接收并检查 shutdown signal。候选不依赖非法 DTO、任意 reject 或 attachment spool 故障。参见[准确范围与读前 pin](source-manifest.json)、[可恢复的已读关键源码](candidate-excerpts.json)、[入口补读](entry-lifecycle-display.json)及[watcher signal 反证](watch-signal-forwarding-display.json)。

**有限时间线。** 旧实例持久接受普通文本 A，正在等正常 Mimi 结果。SIGTERM 结束入站 polling 和空闲 watcher，CLI 释放 lease，但 A 的请求未被该 signal 取消。新实例用同配置启动、恢复队列并持久接受/ACK 新文本 B。旧 A 随后完成，用不含 B 的旧实例快照替换文件。此时 **B 仍可能在新实例内存中，后续 persist 可补回**；只有在恢复写入前异常退出/崩溃，下一次 load 才无法从这份队列文件恢复 B。这里指出的是 ACK 后的持久状态可被撤销，**不以 A 重复投递本身报 bug，不声称 B 每次永久丢失**。无 UI、进程存活时序、实际平台投递或磁盘故障的运行观察。完整条件、反例与边界见[分类](classification.json)。旧投递先结束、没有新实例、或新实例后来写回等均可避免/修复该状态。

**历史边界。** 复用共享5850份 MD/JSON、递归 value 含档案、排 formal58+ 的[路径/SHA导航投影](shared-history-projection.json)：delivery79/bound68均完整保存，cap100；机器访问不等于读完147窗口或全史原因。亲读旧 canonical 见[旧范围](prior-canonical-read.json)及[CHAT-R11原对象](entry-and-old-r11-display.json)：SWC-01账号顺序、SWC-02去重账号、SWC-03小附件 spool fallback、C8同实例重试顺序均保留旧分类；没有把它们再次计数。CHAT-R11-01实际是 notification-progress 首次 rejected load Promise 缓存，与本项不同。先前把该措辞混成失败fixture/Mimi缓存的口述已在[诊断](diagnostics.json)更正，未复跑任何旧验证。R24仅两个派生 bounded contexts 已读，不冒称其巨型文档或全部旧因已穷尽；Root另安排143独立源反证和144旧因复核，本作者冻结不借它们未冻的最终报告升级。

**阅读口径。** 9个产品源：1153行声明语义，其中 bound-session-chat99行 full，其余8个 selected；2个既有测试只读声明98行，0运行。产品/测试共显示1984行，package入口元数据语义7/显示38行，另2 instruction hash-only。本次含旧审查重叠；不是全局唯一新覆盖，也不认证真实账号、路径保管、凭据、权限或平台机制。相邻 spool、Mimi cache、登录/服务选项等显示已明确排除。所有14个源/元数据/instruction pin 与所用旧文档及共享 batch 的结束字节均相同，见[ending](ending-checks.json)。[收据](reviewer-receipt.json)自排除，并冻结当前作者计数；Root 如晋升需另记、不倒写本包。
