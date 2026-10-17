# Future43 ordinary process receipt/event data review

**0 新 formal / 0 新 candidate / 0 新 related**。本次选择 [process-state.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/panels/process-state.ts)（127 行），沿实际 producer→有界事件/回执→分页 DTO→consumer 静态核对，未建立普通新反例。该模块不是仅显示标签；审查范围仍限定于普通数据、保留窗口和游标，不表示整个 Panel/native process 生命周期、身份或权限机制正确。只写本 exact tmp，没有修改产品或仓库文档。

初选前先做新全历史 gate。纳冻结39，排 mutable40 与 future41/42/43：3581 文件（1369 MD +2212 JSON），1030881 JSON string leaves /1550274 scalar leaves，169 exact archive/_archive 路径，0 parse 错误。普通 MD 文本与所有递归 JSON value scalars 都参与查询，keys 不作为文本搜索。canonical 库存哈希及末核见 [finish checks](finish-checks.json)；同范围结束时集合与 bytes/SHA 无变化，没有回写旧时点。

路径初查 5 个 unit hits、当前 SHA 1 hit 均已读：只见 source/module inventories，当前 SHA 来自 R28 package inventory；没有在该 bounded gate 建立旧 same-current-SHA full-semantic receipt。不能据此称历史从未读过。预选库存另有 agent-transcript-translator.ts（195 行），未打开其产品源码，不是替换过的审查方向；它的 84 hits cap80 多含旧 loaded-module/native-failed 路径值，不借为语义阅读或运行证据，旧失败方向不重开。[覆盖 gate rows](coverage-gate-rows.json) 的 36 行是显式元数据，不当全文阅读。

实际数据链中，[process-service.ts:732](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/panels/process-service.ts:732) 初始化 sequence=0、空 events/eventBytes；emit 使用 appendProcessEvent 的返回 payload。leaf 111–127 每次统一递增 sequence，将同一序号放在事件 envelope 与 payload，按事件数与 JSON byte 上限淘汰最老记录。普通 stdout/stderr 路径以 MAX_EVENT_CHARS 切段再 emit；没有用任意巨 payload、无效 DTO、坏时钟或 NaN 构造问题。

同 service 877–885 将终态 status/time/code/signal 与 exit event 写入 record，再交回执容器；leaf add/get 有到期 prune、分组/全局 FIFO 上限。文档 [96–99 行](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/docs/panel-native-tools.md:96) 明确 get 返回 ordered retained events/terminal receipt，且存在 retention/capacity limits，因此此处不推导永久完整历史保证。分组字段仅按普通 bucket 数据使用，不审身份比较或授权机制。

service 922–959 的普通 get 路径按 afterSequence 过滤保留事件并按 limit 分页，返回 nextSequence、当前 sequence、hasMore 与 truncated，复制返回 events。[实际 tool-executor](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/panels/tool-executor.ts:389) 389–431 按序接收、忽略旧序号并通过 get 补取，遇到 truncated 明确报告输出已丢失。没有把淘汰窗口或有意 receipt 到期误报成新的无声丢失；没有声称任意错误消息/所有可能 payload 都有固定上限或整个 host 调度均无问题。

现有 [process-state.test.ts](/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/server/src/panels/process-state.test.ts) 全文 55 行仅作测试声明阅读，2 个 test 语法项覆盖回执期限/分组/全局界限与事件数/bytes/终态序号。没有运行测试、fake clock/timer/Promise/Buffer/语言 fixture，也没有产品 import/helper 调用、真实进程/流/输出文件、网络/native/模型/身份权限实验或 Git 命令。0 passes/expectations，不借其他线程运行结果。

[source manifest](source-manifest.json) 明确区分显示与语义范围：3 产品路径 232 行普通语义 +55 行测试声明 +4 行文档=291；456 行显示含相邻 native/授权/model 代码，只有列出的普通数据范围计入覆盖。leaf 全127行显示而只计99行选读，不能当127行完整机制审验；另3文件只 hash。文档读前 SHA 来自本历史库存，dedicated pin 晚于首次导航 snippet 如实保留。8 条实际 source/hash-only pins 结束全同；Root 只提供 main48bc 短上下文，本 review 不做独立 Git baseline 绑定，也不倒填正式40/41/42状态。

[focused gate](history-focused.json) 在同3581库存得到 exactNames0 /replayLoss0 /replayFields1（cap80，保留0/0/1）；该1项是大文档跨章 AND 命中，初始窗口落在相邻 model-trace 文字，不能当旧同因，实际合同另精确读96–99。实际 source gate 读取计数与边界见 [decisions](decisions.json)。没有语义穷尽或整个仓库无 bug 断言。

[metadata notes](metadata-notes.json) 保留一次 exit0 的 unused translator 历史打印截断；其 basename-only 命中的初始窗口锚点不精确，原 method/contexts 未改，计数不受影响，不作为本选择的旧覆盖或同因证明。也没有将这解释为 regex 转义故障。末尾收据见 [artifact receipt](artifact-receipt.json)。
