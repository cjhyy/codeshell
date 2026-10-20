# Round29 房间历史与普通消息映射静态审查

本方向 **0 formal /0 candidate /0 new-related**。冻结上下文由Root提供为`b3488ec155ecf0c3bb39f5e4d3cd21a783077ad0`；只读源码、测试声明、历史文档和JSON/hash，0产品函数、import、测试、fixture、React/browser、VM、native、Git、网络、模型执行，没有修改产品或恢复旧失败方向。

完整读 [roomHistory](../../packages/web/src/lib/roomHistory.ts)76行、[既有测试声明](../../packages/web/src/lib/roomHistory.test.ts)42行与[messageMappers](../../packages/web/src/lib/messageMappers.ts)144行；mapper tests、Web catchup、Desktop CCConversationView、preload DTO及显示reducer只读明确选段。共 **1251行产品/测试合同**、222行指令、79行旧父报告；12 pins与范围在 [source manifest](evidence/room-source-manifest.json)。11项先固定filesystem SHA后读；跟随阅读的streamReducer首次durable hash在选段后捕获，initialSemanticReadSha256保持null，见[metadata notes](evidence/room-metadata-notes.json)，不倒填读前证明。Root须独立绑定冻结Git；全文hash不是大文件全文阅读。

普通DTO合同反证如下：

- Accumulator固定snapshotId/throughSeq，逐条要求连续seq，final必须刚好覆盖throughSeq且没有nextCursor；重复、gap、切换boundary、cursor循环、空中间页都有显式拒绝路径。超过view limit也显式报错，而不是静默返回tail。这些是源码分支，没有压力、边界数字或错误复用实验。
- `collectRoomHistory`只有完整range才返回messages。Web `room.history.ok`在accept完成前只继续请求；catch会标failed、保留失败边界，不折叠partial或推进catchup位置。Desktop先collect全量再replay，plain room reset与CC backlog/live分源有明确说明；没有实际连接、分页传输或恢复时序验证。
- ordinary user/text/tool/result/turn_end/error形状按顺序转成事件；完整agent prose使用assistant_text而非把多段折成token delta。真实toolId在start/result两侧保留，legacy seq-derived/idless result为明示的best effort；结构化args转发。选读reducer有真实ID匹配与orphan结果分支，不能仅凭旧legacy路径猜成新并行工具故障。AskUser/Question并非本轮动态或结论范围。
- 非数组history已有Array.isArray旧守卫；FrozenRoomPage序号检查会拒绝null/无seq记录。没有普通producer证据支持的malformed数组条目、任意抛错后复用对象、伪造极大序号、callback mutation均不凑候选。journal、认证、权限、identity机制遇到字段后止于公开DTO/consumer阅读，未验证其实现，更没有实验。

先做全历史导航再分类：[dedup](evidence/room-dedup.json) 覆盖docs/bugs **2765=1275MD+1490JSON**，562917strings/833428scalars，0parseerror，含169 exact archive/_archive目录路径（substring口径174），排除current29。exact-source267/room-page-contract774/history-mapping51为occurrence总数，保存context100/100/51、cap100；完整库存SHA与正则不代表历史语义穷尽。

已全文读 [R14 Web旧报告](../audit-2026-10-17-round14/web.md)与[R17 mapper旧报告](../audit-2026-10-17-round17/mappers.md)。R14的roomHistory既有8cases通过记录是旧时点，本轮不借为当前通过；其user-display失败仍SKIP。R17 `MAPPERS-R17-C1`的历史合成start ID与后续真实result ID边界仍是既有候选，本轮没有建立新的真实在途producer/跨snapshot合同，不升级或重报。非数组守卫、旧toolID修复和重复turn边界也已记录，见[history decisions](evidence/room-history-decisions.json)。

[validation](evidence/room-validation.json) runs为空，0pass/0expect/0rerun。没有读取真实transcript、调用RoomManager/follower、实际WebSocket/IPC/浏览器或显示reducer；既有测试定义和旧绿色日志都不能当本轮执行。该negative只覆盖声明的普通DTO/映射选段，不代表服务器journal、安全边界、平台交互或全仓已无bug。
