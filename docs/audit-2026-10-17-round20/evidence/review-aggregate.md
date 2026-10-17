# 第二十批独立聚合复核

结论：**无阻塞内容修订**。README、coverage、分类、validation、source manifest、worker integrity、证据索引、初始/合并前 snapshots、integration plan 与四份 scope review 相互一致。本批 **0 新正式问题、0 新候选、1 处旧机制关联**；**46 pass / 127 raw expect / 0 fail / 0 skip = 7 existing + 39 focused**，四组各一个 guarded first shard，0 产品重跑。零新项不代表全仓或各子系统已审查完成。

本复核仅读取真实库存中的材料、JSON、源码/Git blob 元数据和现有 raw，新增本文件；不 import 产品、不执行测试、不改作者材料、不作 Git 写入。四份 scope review 已读，toolsummary 的独立实质复核也已保存。本聚合复核不会把其他 reviewer 的静态选段扩大为完整模块动态覆盖。

独立核对结果（新增本复核文件之前）：

- 索引 **74 项 / 总计 75 文件**，除索引自身外文件集合完全相同，逐项 bytes / SHA 匹配。没有把 ignored raw log 从实际文件集合中漏掉。
- **44 个唯一全局 source pin** 均独立匹配冻结 Git blob、当前 owned 文件及 main Git blob；记录的 bytes 和 frozen/current/main 标记一致。**42 条 worker source checks** 逐项回到各自真实 manifest 的 `frozenSha256` / `sha256`，再核当前字节；**43 条 author artifact checks** 逐项回到对应 receipt，bytes / SHA 均一致。类型/选段/历史文件的 hash 不是整个文件或传递依赖已执行的证明。
- 四组 raw 分别 **7/21、13/36、14/42、12/28**，每组有 Completed、exit 0、0 failed/skipped。真实 receipts 同时存在 `command` 与 `argv` 两种字段；命令与 aggregate validation 一致，均是 guarded runner。Root mediaKind exit 的原始 schema 没有 raw SHA；其 raw 独立计算 SHA 与 validation / index 匹配，其余三个 receipt 的原有 raw SHA 也匹配。没有补造 Root receipt 字段。各记录声明先保存 combined raw 与 exit 再查看，未发现改测或重跑材料。
- findings / candidates 的 count 与实际数组均 0；related 的 count 与 observations 数组均 1，唯一项为 `TOOLSUMMARY-R20-R1`。null/undefined callback 拒绝仅为手工触发；普通 producer 未建立、下游 catch 仅静态选读，没有新增 severity 或普通 provider/Engine/进程/UI 失败的外推。旧非 Error catch 已去重，旧 JSON repair 与其他失败动态方向保持排除。
- 全批 **74 个本地 Markdown 链接**均存在，声明的行锚在实际行数内。四个 scope reviews 对 leaf/mock/真实 Commander/type-only store/mixed media module 的范围描述与聚合一致。7 个 existing baseline 没有重命名成新复现；mediaKind 的 21 expectations 按 raw 采用，未推断 hook 数目。
- integration-before、integration-premerge 与 plan.primaryBefore 完全相同。独立重读 primary 当前 HEAD/status、tracked/staged diff hash、四个 untracked 文件 bytes / SHA，仍与快照相同；owned HEAD 和 main 都为冻结 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。plan 的 0 external commits / paths 与此时状态一致。原有 deletion 与未跟踪内容未被本复核改动。

本次复核元数据错误的首响应转录：最初只读 Python collector 已完成 index/global source/worker source/artifact checks，进入 receipt raw 字段后在 `<stdin>` line 25 得到 `KeyError: 'rawSha256'`、exit 1。原因是 reviewer 错把所有 receipt 当成同一 schema，Root 的原始 exit 收据确无该字段。随后只读真实四个 receipt schema，并继续尚未完成的 raw/count/classification/link/snapshot 核对；全部通过。这不是 Bun、产品或依赖失败，没有补造字段、修改原材料或恢复任何失败产品方向。

本文件是 root 已知的最终索引新增项；新增后必须重新生成并核对完整 index。此处只审查合并计划及当前 dirty preservation，**尚未证明 staged set/blob、whitespace gate、commit blob、最终 primary fast-forward 与合并后 preservation 已完成**。root 必须在集成步骤重新核它们，并把结果留在最终外部 receipt；既有 root-qc 中这些最终 gate 的描述不替代实际完成证据。没有 push、共享依赖/dist 重建或全仓完成声明。
