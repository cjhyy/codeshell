# Round27 external file identity：Root 独立复核

支持 **AGGREGATOR-R27-01 / P3 静态 formal**，一个根因。Root 全文读 aggregator396行和 external changed-files extractor，并选读 DriveAgent launch/完成/cleanup、renderer 事件到 FilesPanel 打开路径的值流。精确范围固定在 [review source manifest](review-aggregator-root-source-manifest.json)；这不是全文件 UI/DriveAgent 审查或端到端运行。

普通路径足够：显式 `isolation:worktree, cleanup:keep` 是工具公开支持输入；自动并行隔离也走同一 cwd。launch 把 cwd 改成 managed worktree，完成时 normalizeChangedFiles 先将文件规范成 job-cwd relative，record 同时带正确 job cwd。cleanup keep 只保留和解锁；default auto 对有改动 worktree 进入 keep，源码没有合并/复制到 owning chat。因此 `/isolated/src/a.ts` 和 `/repo/src/a.ts` 在正常未合并状态下可以确实是不同文件。

aggregator 内部绝对 identity 原本正确，displayExternalPath 却去掉 job root；FileEditEntry 只留下 path。MessageStream 给 Card 的是其 own chat cwd，Card 的 path/cwd pair 经 openWith、bucket 保留，FilesPanel 对相对 path 与 revealFile.cwd 做 join。因此源码静态得到 `/repo/src/a.ts`，不能还原期望的 `/isolated/src/a.ts`。LocalRuntimeActions 默认true；云surface不在本发现范围。只读这些函数，没有调用它们、真实启动代理、创建/切换 worktree、点击UI、发送打开请求或打开磁盘文件。

同 cwd 或 job root 外的绝对 path 是明确反证；original marker 的 cwd 仍可供恢复，故不能声称原始数据已丢失或内容被删除。多 root 同 relative path 的 row/key 冲突是同一信息丢失的条件性传播，不另算问题，也不声称观察到 React warning。

独立全文读作者报告、finding/history decisions/validation，并核最终 [作者 receipt](aggregator-artifact-receipt.json) **15份材料** byte/SHA 全匹配；最终report6380B/SHA `c369d8897f3d575464042da899c60b49985706d3efa1f81cc18639a0ee8a2092`，receipt SHA `de0690d7ea833bb62d8b7f2e4767cde81a0ced1c699b61d64ea7e6ff473ba3b3`。作者0产品/测试/import/Git范围与实际记录一致。Root先前的compose fixture import failure是另一个方向，完全不能证明本项。这是通过生产者、类型和真实消费链确认的静态问题，不借failed shard的16个既有pass升级。

[独立去重查询](review-aggregator-dedup.json) 对Root已保存的2596历史文件库存逐项重新hash，全部相同；全MD/JSON value scalar的exact producer-loss query0、宽worktree/open query2352，后者仅保留60 context，不称关键词全语义穷尽。另实际选读两个旧报告：旧dock wrong-cwd是主会话workspace解析遗漏；旧DriveAgent research的§6.3是外部CLI在启动后改变实际cwd/transcript导致launch snapshot陈旧。当前从正确known child cwd开始，在renderer汇总才消失，因果不同。旧R13失败组不恢复测试或重新计数。

Root在作者metadata更名窗口遇到receipt locator缺失，已保存 [metadata说明](aggregate-metadata-notes.json)；之后按作者最终冻结路径核这15份，未重复append已写的12-pin review manifest，更未重跑产品。169 exact archive目录和174 substring paths是不同计数定义，全部在同一完整库存中。

同意保留这一P3；没有产品修改或修复验证。最终source frozen/current/main分离、索引和stage/commit保全另由Root聚合工具完成。
