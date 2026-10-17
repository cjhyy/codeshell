# Web 材料只读交叉复核

结论：**没有阻挡整合的问题。** `WEB-R14-C1` 保持静态候选、无严重级别；普通消息展示方向首次 import 失败仍为 SKIP，不可升级为已复现。复核没有执行 Bun、fixture、产品模块、浏览器/存储/网络或替代验证，没有修改 Web 作者材料。

- 独立读取 `web.md`、findings/candidates/validation、两条首次 raw log 与 exit、捕获器、source manifest 和 artifact receipt。roomHistory 原始日志确为 8 pass / 9 expect / 0 fail，guard Completed；user-display 为 0 pass / 1 fail / 1 error、无 Completed，exit 1。后者明确是自有 import 多向上一级，模块加载前失败，不是产品断言失败；报告没有把 “Ran 1 test” 当成功覆盖。
- 两条 raw log SHA-256 与 exit 收据都一致：roomHistory `3da37ec6595211fcd84370e0f30d8199aab13ea7809718cdbf0a6c32d75bdd8c`；user-display `5ea8f0c8538679395f20284290366429e735807311d9016218c44c3ad656e126`。原始长度分别 500、496 字节。捕获器拒绝覆盖 first 文件，并先写 combined bytes/exit 后输出收据路径；这里只核对机制与现有材料，不能从机制证明所有外部历史操作。
- 独立以冻结 `badc2262a90966f6f903977b849adf1f22b55e9f` 的 Git blob 重算 **22/22** source SHA，当前字节全相等；独立核对 **14/14** worker artifact 字节数和 SHA，全部匹配。只证明列出的选定来源/材料，不证明全仓覆盖或动态生产链。
- 只读 `userMessageDisplay.ts` 与既有 `transcriptReplay.test.ts:104–121`：file 分支要求 absolutePath/origin，目录分支直接移除匹配块，imagePaths 与 image block 数量取 max，因此普通 XML 误识别的静态推演有源码依据。现有测试仅给 ordinary attached-file XML 控制；没有把它当作本轮目录/图片路径运行结果。最终正文由显式 displayText 覆盖、原始 transcript 不受显示投影修改，报告已清楚限制这些差异。
- 只读 roomHistory 现有测试验证八项 case 与报告相符；没有新正常触发违例记录。报告清楚区分既有基线与失败的聚焦 fixture，不恢复旧 i18n/展示/TTY 方向。
- 去重数值的“185197 JSON 字符串叶子”与其他分区计入 number/bool/null 的全部叶子口径不同，报告明确标注字符串，不能把这两个口径混为同一总数。与历史 R84 的“缺少投影”分开描述，并保持当前候选未复现，范围适当。

这次复核全部 metadata 检查首遍完成，无产品重跑；没有新增正式发现。材料若再改动，应仅刷新相应 metadata receipt 并核对最终字节。
