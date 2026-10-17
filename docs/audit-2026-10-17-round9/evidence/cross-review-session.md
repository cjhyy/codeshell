# Session cap / durable full fork 交叉复核

结论：**支持 SESSION-R9-01 确认为 P3，后果限定完整响应超出工具批次上限后，正常结束的历史无法 full fork**。没有证据支持 resume/send 必然失败、真实工具被错误执行、数据丢失或永久无法继续。复核仅阅读实际源码、fixture、首次 raw logs、退出收据和报告，没有运行任何测试、产品修改或 Git 写操作。

## Fake producer 合法性与实际链路

fixture 没有直接拼接坏 JSONL。它通过实际 SessionManager.create 创建自有临时会话、append 普通 user message，然后把完整静态 LLMResponse 交给实际 ModelFacade 和 TurnLoop。26 个 ToolCall 的 ID 唯一，名称均在本 fixture 的 tools 定义中，args 为普通空对象，无 invalidArguments；ToolCall/LLMResponse 的生产类型没有 25 项 response 限制，TurnLoop 的 slice 正是处理超限批次的现有合同。fake executor 返回同 ID、同名称和普通字符串结果。只替换 client/executor seams，没有替换 Facade 记录、队列、Transcript 投影、ContextManager 或 fork validator。合成 usage 用于离线响应元数据，不代表真实 provider 对 26 calls 的 token 用量。

ModelFacade.call 在返回前调用 recordResponse；`:294–303` 遍历完整 response.toolCalls 并写入 assistant 事件。TurnLoop 随后在 `:1634` 截取执行集合，并只为前 25 项写 metadata（`:1659`）和结果（`:1684`）。actual StreamingToolQueue 返回已入队集合的结果，不会为被 slice 的第 26 项生成结果。cap reminder 通过 `appendContextReminder` 只进入 live Message[]，不重写之前持久化的 assistant 事件。

首跑实际断言了：26-call case 正常 completed/done，实际只执行 25 个 fake tools；第二次模型请求与最终 live messages 配对完整；持久化 transcript replay 却有 26 个 provider uses、25 个 metadata uses 和 25 个结果，配对检查失败。SessionManager.fork 通过 readForkSnapshot 从同一临时磁盘 JSONL 读取，再在 `:2330` 调用完整事件验证。validator 的 pending 队列在 25 个结果之后还剩第 26 个 ID，最终 assistant `done` 触发 `:2548–2552` guard。这不是 metadata 计数误判、cap 不生效、fake 后续响应失败或手工构造的损坏文件；失败 fork 前后源 JSONL 字节相等。

25-call 对照使用相同组件和相同 cap，正常完成、落盘工具配对完整，且实际 full fork 成功并复制相同投影。fixture 没有构造完整 Engine.run，也没有最终保存 completed state；报告的“正常完成”依据是实际 TurnLoop result，生产默认和后续 Host 连接仅静态核对。SessionManager 普通 tail fork 本身不依赖该 state.status，所以这是有效的组件级持久化/fork 控制。

## 生产连接与不能扩大的后果

Engine 当前默认 `maxToolCallsPerTurn` 是 25（`engine.ts:3535`）；run-accounting 的 wiring 创建同一 ModelFacade（`:105`）；Engine.forkSession（`engine.ts:1281–1282`）直接委托 SessionManager，普通 full fork RPC consumer（`protocol/server.ts:1632`）使用该入口。它们证明源级连接，没有当作动态 Engine/RPC/UI 证明。

`run-session-open.ts:126` 在 resumed messages 上调用 patchOrphanedToolUses，`transcript.ts` 的 reader normalization 也明确把缺结果留给 run-resume 边界处理。报告据此主动排除“下一次 send 必然失败”，这个限制必要且正确。此次没有执行 resume、真实模型、工具服务、网络、用户历史或原生客户端；没有测试截断响应分支。

## B-3 与其他旧项的重复风险

已直接阅读历史 `docs/archive/core-complete-review.md:474–481`、当前 TurnLoop B-3 注释和 `turn-loop-tool-cap.test.ts`。旧项讨论 live cap 后调用意图被忽略、缺少提醒；现有 B-3 修复是在 live user history 增加 dropped-names reminder，其既有测试使用空操作假 transcript。新项讨论 Facade 在 cap 之前已经写了全部 provider uses，后续持久化集合和执行集合不一致，实际 full fork 失败。**相同 cap 触发不等于相同根因**：提醒的修复不能改变先前写入的 durable assistant 内容，新项需要持久化/有效会话投影的一致性处理。因此本项可以独立登记，不是把旧 B-3 提醒问题换成新标题。

July 的多 reader synthetic duplicate/fork 旧项是重复结果；本项是超限后缺少结果。CTX-1 是 compaction snip 丢掉成功结果；本 fixture 没有触发 snip/summary。这些问题共享 pairing symptom，触发、写入原因和修复位置不同。既有 M1 is_error 丢失也已明确排除。定向去重和 1000 文件 corpus 的边界在报告中披露，没有将关键词未命中冒充绝对语义去重证明。

## 计数、来源与报告精度

三个首次 shard 都 exit 0、Completed、0 fail/skip：2 新数据控制 / 11 expect，29 既有 baseline / 123 expect，2 cap characterization/control / 18 expect，合计 **33 pass、152 expect**；新增 focused tests 为 4，不是 33。25 个 source-manifest 条目的当前字节/SHA 与记录相同；本复核没有重新执行 Git blob 验证。session.md 的 25 个本地链接存在，主定位 ModelFacade:294、cap:1634、fork validation:2330/pending:2548 和默认值/wiring/RPC 行号正确。

session.md 的标题写“超出工具批次上限”。起初 session-findings.json 的 title 写“达到上限后”，已由 session agent 同步为“超过上限后”并刷新该方向 artifact receipt；本复核再次只读检查确认修正已落实。25 本身是正常对照，修正只涉及记录精度，不影响证据或 P3 结论。没有剩余阻断问题，未增加任何测试或产品执行。

复核时 session.md SHA-256 为 `3c9b761ab2c81f63bb585ad92a9dae15455b105dde09d30681f70e25cdc6213e`，session-call-cap.test.ts 为 `49904ff3e214e403747521260b974a1c6ed80b41e47ef72dfeeb6fa3af4ac2e0`，首次 cap raw log 为 `c3edc881a9f2e70553f8e502b4e427b2a5182872a726964ca426b778011555b8`。后续最终 evidence index 负责最终产物哈希。
