# Mappers 独立只读复核

复核者：`model_catalog_round17`。冻结基线：`d86db33012dffd5d1849e76b869fa15eb260324f`。本复核没有新增产品运行、测试、网络、Git 写入或其他方向恢复；只新增此文件。

结论：接受作者 **0 formal / 1 candidate / 0 related** 的归档，未发现需改正的证据或计数。

- 先用实际 `rg --files` 库存找到 mappers 报告与 JSON；raw 路径来自已有 exit/validation receipt，未猜日志后缀。检查 report、candidate/related、fixture、FIRST combined raw/exit、validation、source manifest、dedup supplement 和 artifact receipt。此复核没有导航或元数据失败。
- 首次 raw 为 1,088 bytes，SHA-256 `29b48cc6c9468a4407798a723bd65bfd94cc8f8360258067a55850b3b943d840`。原文明确为 **9 pass / 33 expect / 0 fail**，guard 明确 **9 tests / 0 skipped / 0 failures / Completed**，exit `0` 与 guarded 命令一致。9 个都是自有聚焦 fixture，未把现有混合测试或任何旧结果并入。
- 逐项核对 artifact receipt 的 **13 个文件** bytes/SHA，全部一致；逐项核对 **14 个 source pins** 与冻结 Git blobs、当前文件 bytes，全部一致；报告 **15 个本地链接** 存在。以上只证明归档完整性与选定源码一致，不代表全文件/传递依赖审查。
- fixture 仅绝对 leaf import `messageMappers.ts`，实际调用 `roomMsgToEvent`、`roomHistoryToEvents`、`ccHistoryToEvents`。其纯 `roomHistory.ts` re-export 可被加载，但没有 accumulator/collect 调用。没有 runtime mock，也未导入/调用 parser、follower、RoomManager、reducer、AskUser、hooks、React/UI 或 Host。
- 静态复读 `messageMappers.ts:54–59,112–123`、当前 coding 包 `HistoryMessage:7–15`、`transcript-subscriptions.ts:135–140,217–225,551–557` 和 `useRemoteApp.ts:1157–1177`。候选只直接证明自造普通形状的 history start 使用合成 `cc-hist-0-0`，room result 保留 `toolu_owned_running`，live start/result 控制保留相同真实 id；它没有证明这两个对象来自同一次真实在途调用。报告明确保留跨 snapshot/live 协议和消费者处理的证据缺口，未宣称 UI 丢失、挂错卡、卡住或重复，因此候选定性恰当。
- 历史 assistant 的 completed 边界与旧重复 turn_complete 区分清楚。旧 Codex MCP summary、AskUser/reducer/Question、非数组 history 修复、parallel id pairing，以及 round14 失败的 userMessageDisplay 方向都明确排除，没有通过混合 shard、筛选或替代入口恢复。
- 历史去重分清 **1,134 MD + 804 JSON = 1,938 files**、**239,449 string leaves / 335,081 scalar leaves**；上下文 cap 与未封顶匹配数区分清楚。`cc-hist-` 精确查询 0 旧命中，宽查询 4 条是旧敏感结果记录；报告没有把关键词扫描当作语义穷尽证明。

通过的 characterization 测试表征当前 mapper 行为与对照，未修改产品，也不构成候选已修复的证据。

复核材料核对完成后，一次尝试向猜测的作者 agent 名发送“复核完成”通知失败，首次工具响应为 `live agent path /root/history_mappers_round17 not found`。这是协作地址导航错误，未送出消息、未执行文件/产品操作；不再猜测或重试该地址。正式复核结果已经通过 root 的有效地址通知，不影响上述 raw/source/artifact 校验。
