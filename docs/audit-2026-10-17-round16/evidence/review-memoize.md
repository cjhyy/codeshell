# 只读交叉复核：Core minimal memoize

复核冻结基线 `ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f`。只读 `memoize.md`、首次 fixture/raw/exit/preflight、root source manifest、root dedup/script 及有关生产源码和既有 Skill 报告；**没有新增 runtime、测试、产品写入或 Git 操作**。

结论：接受本分区 **0 formal / 0 candidate**，无需修订。

- 首次 raw 明确为 **7 pass / 36 expect / 0 fail**，guard 末尾 `Completed Bun shard: 7 tests, 0 skipped; 0 failures.`；退出收据为 prescribed guarded command、firstRun true、exit 0。测试全为本次 7 个 focused，不能累计为已有基线。fixture 唯一生产模块 import 是已核验的绝对 `utils/memoize.ts`；callbacks 和 key 都为自有同步内存输入。
- 真实模块完整读取核验了 resolver 每次重算、`Map.has` 支持 undefined、`.cache.clear()`、side-channel key、普通特殊名称字符串 key、不缓存同步 throw 等断言。throw 是预先设计并由断言捕获的 callback 控制，shard 本身没有失败，不是失败后重跑。没有 Promise/receiver/replaced-cache 实验或异步失败结论。
- `pluginCommandsLoader.ts:198–215` 和 `scanner.ts:350–381,429,475–477` 的实际 key/clear 接线仅静态阅读。report 明确没有导入 loader/scanner、读取 mtimes、解析用户目录或运行安装；helper callbacks 的通过不能证明这些外部 key 的失效策略正确。
- helper 头部明确写 cache 随函数生命周期、非 LRU；本轮没有把有意非 LRU 设计当缺陷。已有 round6 `skills-agents.md` 已说明目录 mtimes/显式失效合同及两个首次失败 SKIP 方向；本轮 direct memoize 入口没有恢复 Skill parser/registry 动态验证。
- 独立 metadata 逐项核验 root manifest **9 个**条目的冻结 Git blob SHA/bytes 与当前文件，全部一致，且阅读/执行 scope 有界；pin 清单并非全文件执行覆盖。
- root dedup 的脚本确为递归 prior docs/bugs 的 MD 与 parsed JSON string leaves，包含 archives、排除本批。**1119 MD + 763 JSON = 1882 文件、222452 string leaves、0 parse errors** 与 report 一致；独立核验 1882 条 inventory SHA 均匹配。memoize 匹配总数 246、保存摘录 120；scan_invalidation 总数/摘录均 53。没有把 120 上限或字符串叶数写成总 scalar 叶数，也没有声称 keyword 检索穷尽语义。
- root navigation note 明确转录一次未使用静态路径猜测错误并 SKIP，不是 product/Bun failure；不影响唯一实际模块和首次 shard。未恢复旧 Slice 动态方向。

本复核只确认记录与这些证据一致；没有重跑测试、验证真实应用、用户数据、CLI/Engine、网络、终端/native、权限/安全流程或完整套件。
