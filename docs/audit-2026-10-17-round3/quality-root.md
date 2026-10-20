# 主审收据与源码核对

本页是主审的只读整理复核，不是第二次动态复现。没有为质量核对重跑任何 fixture。确认数为12个独立缺陷位置：1 P2、11 P3；相关缺陷家族另作交叉引用，不把旧已确认的位置再计一次。

## 独立复核的实际边界

- Host分审对CDP/Arena提交过部分交叉意见：三个CDP行为及Arena三个行为与源码相符；建议把私有legacy CDP两项降P3。主审采纳，最终CDP总计1P2/2P3。
- CDP分审对Host/Link及Root提交过部分交叉意见：精确路径/代理对条件P3成立；成功读取了同版本官方Codex schema，支持file_change数组和MCP结构化形状。
- **两路完整独立质量 turn 随后都报“Selected model is at capacity”而终止，没有落盘完整quality报告。** 本批不将上述片段包装为完整独立复核，不改用其他模型重复相同分审；主审继续自己核对原始日志、生产源码和索引。中断发生在审查代理服务，不是产品错误或Bun测试失败。

## 源码与语义核对结果

| 范围 | 保留决定 | 证据限制 |
| --- | --- | --- |
| R3-01/02 | Codex 0.142.4官方SDK类型与实际parser不一致；真实本地RoomManager将缺失Edit/无意义MCP摘要持久化；保留P3 | SDK tag精确匹配源码声明版本，未运行真实Codex或MCP；plain command/text对照正常 |
| R3-03 | null对象校验缺失真实；损坏/非schema边界P3；与旧R2-04相关家族但独立Codex live入口 | 不声称正常writer产生null或实际Host崩溃；同一个修复不能自动修另一parser |
| R3-04 | 默认Windows格式name整段cwd，name>512后同一writer/reader不一致；保留条件P3 | 自有本地metadata、无agent启动；未在Windows创建真实长路径 |
| HL-01/02 | 路径trim改变精确引用、defaultLabel尾部UTF-16切分破损，条件P3 | 自有Map命中不是实际GitHub读取；source identity/label消费是静态接线；%2F拒绝保留能力边界 |
| CDP-R3-01/02 | quad被外接矩形替代导致错误点，Shift text/key不一致；私有legacy范围P3 | 只验证fake sender输出及几何；不从中心可见推断真实scroll行为，已在报告修正该句 |
| CDP-R3-03 | visibility:hidden祖先可有显式visible后代，提前剪枝漏报；生产diagnostics消费者使P2合理 | 实际callback在Node VM中运行、DOM/style是纯对象；无真实CSS排版引擎或Desktop适配器E2E |
| LAB-R3-01 | correction门禁使用最新、reflection find取首项形成过期反馈；实验flag-off范围P3 | 真实grading/reflection纯转换，Controller追加/冻结链路静态；不声称真实模型候选必然错误 |
| ARENA-R3-01/02 | explicit agree契约与默认agree冲突；早退绕过明确unresolved sweep；私有保留源码范围P3 | 真实parser/state/ledger/early-return；四桶summary消费者静态，未将复制过滤当作真实私有summary函数执行 |

所有原始日志按首次guarded运行保存。CDP的stdout/stderr分开保存，聚合计数按每一对作为一个shard；不得漏掉stderr中的Bun统计。其他日志是合并stdout/stderr。成功总计按完整Completed门禁计算，Lab第二轮provider registry实例不一致失败独立保存，未进入fakeLLM，候选不计确认。

完整staged diff空白检查仅有一条原始日志例外：`lab-offline-round2.raw.log:11` 的provider错误诊断以字面空格结束。按首跑原始字节保留；排除raw日志后的材料检查通过。16个原始log已在本任务目录显式force-add，未带入其他ignored文件。

CDP `cdp-receipt.json` 内包含首次收束报告的SHA，之后因P2→P3及主审收紧scroll表述而修改报告；该条是**历史报告版本哈希**，不可当作最终report当前哈希。源码/测试/原始日志没有改；最终材料以总 `evidence-index.json` 逐文件哈希为准，原分审receipt不覆写。

主审检查只证明当前证据与所列窄契约一致。全仓全部实现、真实外部服务/模型/操作系统、所有竞争或异常仍未覆盖，持续目标不能在此标为完成。
