# Prep86：ModelTraceStore 普通 query 数据审查

有限结论：**0 新 formal / 0 candidate / 0 new-related**。本次只审普通 query 过滤、metadata 投影、排序、cursor、limit 和 session summary/page DTO 的所列选段，没有建立可由真实普通调用产生的新反例；不据此认证整个 Store、Host 或 UI，也不声称全仓无 bug。[分类记录](classification.json)另存。

Root 提供当前产品 baseline `7dcd41b9a1bfd23ecc6e6563fd8fbf569cf9483b`，仅作外部上下文；本读者没有执行 Git。实际文件经 filename inventory 确认，`packages/core/src/model-traces/store.ts` 为 624 行、23181 B、SHA `4f05f5db8c1c216b2cce1dba339d464c7b64a597ba43f6602e634c9d0fcefb8f`。[最初 pins](initial-pins.json)在正文/行导航之前；测试与消费者各自的初始 pins 也在其正文或行导航之前，见 [support pins](support-initial-pins.json)、[consumer pins](consumer-initial-pins.json)、[sessions test pin](sessions-test-initial-pin.json)。CODESHELL 的当前同 SHA 217 行阅读沿用 prep71，重复 hash 不算新指令阅读。

正文前 fresh [历史库存](history.json)按 [扫描方法](history-method.py)覆盖 docs/bugs Markdown 正文与递归 JSON scalar values，含归档、纳已冻结49、排数字正式50+；未搜索 JSON keys。共 **4693 份 = 1457 MD + 3236 JSON**，2129441 strings / 3168045 scalars / 914461 objects / 81935 arrays；169 个精确 archive/_archive 目录成员，0 parse error。path/SHA/filename/old-cause 总命中为 **32/18/46/10**，各 cap100，全部保留为有界 [contexts](history-contexts.json)，没有把机器遍历量当作人已逐字阅读量。

实际 gate 读了全部23个 [精确 path/SHA 对象](coverage-gate-objects.json)、10个 old-cause 窗口、1个 R18 path 窗口和2个额外 filename 窗口，并看全部命中定位列表；其余窗口只保留，不声称逐字语义读完。[gate decision](gate-decision.json)检查 coverage/scope/readScope/reviewMode/inspectionScope/review 等字段。Canonical R18 `presentation-source-manifest.json /files/11` 同 SHA 明确只有“static read 446-460 only; no storage execution”；R3 root/coverage 只声称相关链路选择性静态阅读，未给完整范围。R49 的 trace-history 包明确未读 Store 排序/裁剪/文件实现。R28/R44 unknown/pin-only 和派生 claims 不作为未读保证，也不当新语义证据。未找到明确 canonical 同 SHA full，故进入有限选段；没有声称这是首次阅读或此前完全未读。

所读普通合同与反证如下：

- Store49–57 的普通非空有界字符串与 summary 投影；137–170 的普通 query 值边界；200–201/204–216/227–294 的 words、metadata 字段、时间与精确值过滤、显式 summary 字段投影。输入/输出/attempt 正文不进入所列 summary 返回字段。`deriveModelTraceCallType` 只是调用边界，未展开分类函数实现。
- Store295–330 按 startedAt 倒序、相同时间按 id.localeCompare 倒序；cursor 后继用相同时间和比较器方向，再 slice limit，nextCursor 来自最后一项，total 在 cursor 过滤前计算。没有把另处旧 comparator 家族套到此处，也未手造 Unicode ID/坏 DTO 当真实 producer。
- Store331–442 在分页前按有区分前缀的 session/trace key 汇总匹配 metadata；计数、去重 trace、sources/models/callTypes，选择最大 updatedAt 后以 startedAt/id 解同值，最后按 updatedAt/key 排序并用相同规则做 cursor 后继。未由这些普通值流建立新反例。
- types94–105/108–145 给出普通 query/page/group DTO；server54–89 对普通 transport 字段作新 DTO 校验、limit1–200 与 since/until 顺序检查，203–206/213–218/223–229 将 validated 值传入 Store 并映射 session cursor 错误。Store 较宽的 limit 上限500本身不构成正常 UI 错误。
- 实际 Desktop `ModelTracesView`250–258 请求 sessions limit50并收 page，299–306 请求 list limit100并消费 items/nextCursor，372–382 将 nextCursor 传回并保留下一页 DTO。这是真实源调用证据；未运行 UI、IPC、Host 或网络。

[源码清单](source-manifest.json)为 **6 selected / 0 full**，463 普通语义行 = **405 产品 + 58 测试声明**，累计唯一显示664行；display/nav 与 semantic 范围逐项分开。Store 全624行只显示356行、普通语义274行，不称 full。17个现有 test titles 仅导航，其中2个 ordinary test declarations 选读意图：store119–139 的 metadata list/search/paging 与 sessions39–49/56–81 的聚合和页面断言。现有测试没有运行；同测试的 FS/crypto 损坏正文设置50–55只相邻显示、不认证该机制。[source excerpts](source-excerpts.json)在实际显示后捕获，只保存已显示行，不伪称阅读前快照。

workspaceScopes 的 admission/visibility/authority、prune/retention、读取/反序列化真实文件、原子写、locks、crypto、真实 trace/account/config/session 内容都停在边界；即使相邻源码打印出来也不纳语义结论。get/write 主体、完整 recorder/provider/Host 生命周期、Desktop 异步生命周期与绘制也未认证。旧 NDJSON/timer 等失败方向继续 SKIP，没有恢复执行、借旧 pass 或扩大本次 negative。

[validation](validation.json)记录 **0 产品函数 / 0 helper / 0 import / 0 fixture / 0 tests / 0 UI / 0 模型 / 0 native / 0 network / 0 Git**；仅运行自有标准库 metadata/hash/search 脚本。本次没有失败命令、缺失路径、截断输出或 late initial pin。结束 [checks](ending-checks.json)的8个源码/指令 pins 全同 SHA，4693份原历史同 filter 的成员与 bytes 全同；结束 hash 不是第二次语义阅读。该包只写 exact tmp，不改产品与旧冻件。[冻结回执](reviewer-receipt.json)逐项列 SHA。
