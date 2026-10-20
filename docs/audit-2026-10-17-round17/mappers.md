# 第十七批：普通房间消息与外部会话历史映射

冻结源码：`d86db33012dffd5d1849e76b869fa15eb260324f`。本方向 **0 项新增确认缺陷、1 项候选、0 项另计旧问题关联**。自有首轮 guarded shard **9 tests / 33 expect / 0 fail / 0 skip / Completed**；9 个都是本批纯函数表征/控制测试，没有把旧整组测试计入通过数。

## 范围与证据层级

实际执行 [messageMappers.ts](../../packages/web/src/lib/messageMappers.ts) 的 `roomMsgToEvent`、`roomHistoryToEvents`、`ccHistoryToEvents`。fixture 使用绝对 leaf import 和自造普通 `RoomMessage` / `HistoryMessage` 对象。模块尾部 re-export 的 [roomHistory.ts](../../packages/web/src/lib/roomHistory.ts) 为纯模块，被加载但其 accumulator/collect 函数没有调用。本次没有 runtime mock。

[RoomManager](../../packages/server/src/mobile-remote/room-manager.ts) 的 `RoomMessage`（276–300）、append（699–720）、普通 agent 事件持久化（1143–1193、1239–1251）和 send 的用户记录（1257–1337）只作静态形状依据。[HistoryMessage](../../packages/coding/src/cc-orchestrator/session-history.ts) 当前实际归 coding 包所有，7–15 行的历史 tools 合约只有 name/summary/args；这里沿用 mapper 注释的旧“Core HistoryMessage”称呼时，不能理解为运行了 Core 或旧 Core barrel。Claude/Codex 历史归一化、tail 事件 ID 传递、[transcript-subscriptions](../../packages/desktop/src/main/cc-room/transcript-subscriptions.ts) 和两处消费调用段均只读；没有执行 parser/follower、读取任何实际 transcript、创建/运行 agent 或调 transport。

明确排除 `extractAskUserOptions` / AskUser、streamReducer、hooks/UI 动态、Question/multiselect、旧 Codex MCP summary parser、round14 已失败的 userMessageDisplay 动态方向。现有 [messageMappers.test.ts](../../packages/web/src/lib/messageMappers.test.ts) 混含 reducer 与 AskUser，**没有执行该文件或通过筛选恢复其混合方向**。不构造 null、未知 role、恶意 payload 或没有普通 producer 的记录来新增缺陷。

## MAPPERS-R17-C1：历史工具 start 的合成 ID 与后续真实 result ID 的边界需要核对

状态：**候选，非确认缺陷，未定优先级**。

普通触发假设是用户在外部工具调用尚未产出结果时打开/重新订阅正在跟随的会话。静态 follower `subscribe()` 的现有记录分支（135–140）和初次分支（217–225）会返回 `active: true` 的历史 snapshot，未在这些段落要求工具全部结束。`HistoryMessage.tools` 当前不带原始 ID，`ccHistoryToEvents`（112–123）因此给历史工具生成 `cc-hist-${i}-${t}`，并在每条 assistant 历史后生成 completed 边界。后来 tail 结果则经 follower 的 `tailEventToRoomMessage`（551–557）保留 `event.id`，`roomMsgToEvent`（54–59）继续透传该真实 toolId。

自有 fixture 的最后一个表征用相同工具的普通历史对象和普通 RoomMessage 结果对象，实际调用 mapper 得到：历史 start 为 `cc-hist-0-0`，随后 result 为 `toolu_owned_running`；两者不同。控制组同样调用 `roomMsgToEvent` 处理 live start，start/result 都保持 `toolu_owned_running`。前面的多工具控制还证明一页历史中的三个合成 ID 唯一且重复映射稳定。

[useRemoteApp](../../packages/web/src/hooks/useRemoteApp.ts) 1157–1177 的静态调用先回放 snapshot，再以 snapshot 的 roomCursor 请求后续；[CCConversationView](../../packages/desktop/src/renderer/cc-room/CCConversationView.tsx) 78–93 亦提供历史与普通房间消息的入口。以上接线使边界值得留档，但**fixture 没有运行这些生产者/消费者，没有证明这两个自造对象实际来自同一次正在运行的调用**。尤其没有执行 reducer，不能断言结果丢失、挂错卡片、工具永久等待、消息重复或任何视觉故障；每条 assistant 的 completed 边界也可能是消费者有意的历史收口政策。

将其升级为正式缺陷还需要独立确认：当前普通 snapshot/live 协议要求同一在途工具跨边界保持身份，以及真实消费者如何处理已收口的历史工具和后续真实 ID 结果。当前证据只直接证明两个纯 mapper 的 ID 形式不同。问题若成立，也涉及历史 DTO/producer 的原始 ID 信息，不能推断单改 mapper 前缀即可修复。

## 已核对的正常行为

用户文本、附件元数据、agent prose、room_created audit anchor、tool args、真实 ID、legacy seq-derived ID/id-less result、turn_end/error/agent_exit 均按现有合同产生事件。room replay 保持“prose → tool → result → prose”顺序，history prose/tools/完整 args 被转发，多工具历史 ID 唯一；冻结输入与 JSON 前后比较未发现这些 mapper 修改输入。

正常退出 code 0 仍映射成 error 类事件，是现有明确的 agent_exit 表达方式；本次没有消费者判错的证据，不把它另报缺陷。历史每条 assistant 补 turn_complete 已在旧 2026-07-09 记录作为等价 replay adapter 讨论，不另报旧 Engine 双发问题。

## 首轮验证与去重

唯一运行命令：

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round17/evidence/mappers-pure.test.ts
```

[first combined raw log](evidence/mappers-pure.first.raw.log) 与 [exit receipt](evidence/mappers-pure.first.exit.json) 在查看输出前已保存；exit 0，9 pass，33 expect，0 fail，guard 报 0 skipped / Completed。没有重跑、修复 fixture、安装依赖、构建 dist、扩展到混合 shard。首次 metadata preflight 仅验证真实源文件/Git 字节和 fixture 存在，未猜根依赖路径或声称 resolver 通过。没有导航失败或测试失败。

完整历史去重读取 prior `docs/` 与 `bugs/`（含 archive/_archive）所有 1,938 个 MD/JSON：1,134 MD、804 JSON，递归解析得到 239,449 个 string value leaves、335,081 个全部 scalar leaves，0 解析错误；排除本批。首份正则匹配计数不封顶，展示上下文每类最多 40 条；补充扫描 MD 用跨行有界正则、JSON 用相同全量 string leaves，上下文最多 20 条。合成前缀 `cc-hist-` 没有旧记录精确匹配，宽泛边界匹配 4 条均是旧敏感结果上下文，不是本候选。以上是有界关键词检索，不能证明语义穷尽。

旧非数组 room history 修复、旧 top-level Engine 重复 turn_complete、旧并行工具 id-pairing、旧 Codex MCP summary，以及 round14 userMessageDisplay 失败方向均不作为新增项或通过数。详见 [dedup](evidence/mappers-dedup.json)、[supplement](evidence/mappers-dedup-supplement.json)、[validation](evidence/mappers-validation.json)、[source pins](evidence/mappers-source-manifest.json) 与 [artifact receipt](evidence/mappers-artifact-receipt.json)。这些 source pins 限定已读范围，不代表全文件/整个包或转移依赖覆盖。
