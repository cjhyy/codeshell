# Round27：审查快照与展示消费静态审查

本方向 **0 formal / 0 candidate / 0 related**。冻结基线由 Root 提供为 `9b667863e8a8eb91db7b1f99eb9876169dcf19ec`；本作者未运行 Git，不把该上下文冒称自行核过 Git blob。只做源码、文档、JSON 与文件 SHA 静态核对，没有修改产品源码或执行产品、测试、import、fixture、VM、React、浏览器、native、业务 Git 或网络。

实际完整阅读 5 个核心文件，共 1026 行：UnifiedDiffViewer449、其 review test41、reviewSnapshot47、其 test48、ReviewPanel441。另完整读 CODESHELL217 行，并选读 types42、FilesChangedCard61、bucket19、workspace test227 行。完整字节 SHA 不等于其它未声明行已语义阅读；范围与读时 SHA 保存在 [source manifest](evidence/snapshot-source-manifest.json)，原作者初始版本逐字节保存在 [initial manifest](evidence/snapshot-source-manifest.initial.json)。恢复作者已重新读完相同范围并逐文件核 finish SHA，10 pins 均与初始文件相同；源码与测试声明都未执行。

反证和本轮边界如下：

- [ReviewPanel:103](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:103)、[Viewer:114](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx:114) 区分 snapshot 缺失和明确空字符串。空快照继续走 snapshot 分支，不查询当前 Git；Panel:203–218 也不为净空准备 AI 审查。这是当前源码明确合同，不能把有空串分支本身登记为缺陷。
- [capFiles:236](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx:236) 按所有 hunks 的累计行数分配预算，在截断时 clone file/hunk，不修改原快照。Panel 仍将未经过 display cap 的 `turnDiff` 交给 snapshot selector。旧“首个大文件绕过行预算”的候选不能按当前实现重复登记；本作者没有运行旧候选或性能实验，也不宣称动态修复验收。
- [groupReviewSnapshot:3](../../packages/desktop/src/renderer/diff/reviewSnapshot.ts:3) 明确为 legacy payload 保留每个已记录 hunk，不从部分 snippet 猜净变化。普通路径按 path 分组；rename 两身份保留独立 section。多次 legacy hunk 仍表示历史编辑，而非保证真实最终文件完整状态，不能据此凑一个新的“没有算 net”问题。
- [reviewDiffFileKey:66](../../packages/desktop/src/renderer/diff/UnifiedDiffViewer.tsx:66) 的 live Git 路径包含 rootId、repoRoot 和文件路径，后续按各 repoRoot 展示/open。已有测试声明针对同名多仓库键和跨 hunk cap；本轮未执行这些测试。
- [Panel:138](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:138) 在 render 时把不再存在的 turn-file filter 回退到 ALL_FILES；[recent loader:55](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:55) 用 exact session/cwd target 与 request sequence 阻止旧结果落入新工作区。只有源码反证，没有运行 React 或异步竞态。

`__all__` 与真实根文件同值的问题已归 Round26 `RENDERER-R26-01`，本轮不重报、不执行。[SessionFileDiff](../../packages/desktop/src/renderer/types.ts:290) 只有 path/toolCallId/diff；[card:83](../../packages/desktop/src/renderer/messages/FilesChangedCard.tsx:83) 合并字符串并按 path 分组；[Panel:417](../../packages/desktop/src/renderer/panels/ReviewPanel.tsx:417) 与 Viewer:116 将 snapshot 赋统一 cwd。此消费链事实已交 aggregator 作者核真实多 cwd producer 合同；若出现新的 producer 缺陷，应由其登记同一因果，本方向不重复计数。外部 attribution 没有 diff payload 时如何表示“未知”也已交其核对，当前不凭人工输入升级。

全历史去重 [snapshot-dedup.json](evidence/snapshot-dedup.json) 搜 docs/bugs 的 Markdown 行与递归 JSON value scalar，包含归档、排除本轮：2596 文件（1250 MD、1346 JSON）、468104 字符串／676635 scalar，0 parse errors；exact70、snapshot-contract305、old-families600 是命中单位数，各保存 cap120 条 context，excerpt 最长900字符。正则导航和 hash 都不代表已语义审完全部历史。恢复作者逐项重核2596文件 byte/SHA 保持相同，见 [recheck](evidence/snapshot-dedup-recheck.json)。

[validation](evidence/snapshot-validation.json) 中所有执行计数为0。本方向不使用 Root 的失败 compose 夹具来证明任何 snapshot 行为；Root 的 existing16 pass/54 expect 与 focused import 未进入、整 shard 失败必须单独记录。当前结论仅覆盖上述源码范围，未宣称整个仓库审查完成。
