# 独立交叉复核：Review prompt 分区

复核冻结点 `5f5cf69df8526470700712a4dc2d5ae6bd2da132`；只读作者材料、选定产品源码与历史记录，另写本复核文档。没有新增或重跑测试，没有运行 CLI、Git 产品命令、model/client、renderer、网络或原生应用；Git 仅用于只读 blob 元数据核对。

结论：接受 **1 项 P3（REVIEWPROMPT-R19-01）/ 0 候选 / 2 related**。普通 usage 明示 `security,perf`；实际 TUI handler 将该值直接交给 parser，而生产叶函数只识别 `performance`。focused 前两项直接调用实际 parser/builder，观察混合输入丢失性能、单独 `perf` 回退全部维度，完整名称对照正确。证据支持提示与 parser 的矛盾，不外推模型实际漏报、CLI 已执行或完整 TUI 已验证。

普通提示静态链独立核对了 `git-commands.ts:136,149,170`、`registry.ts:190-199`、App 的 commandDefs/commands props、`TuiControlSurface.tsx:364-368`、`CommandInput.tsx:24-28,188-196,238`。首次作者报告省略了中间 TuiControlSurface 源码 pin；我提出补充，作者已补选读、报告链接及 manifest，receipt 随后刷新。该调整仅补 metadata/静态消费证据，raw/fixture 保持原字节，无产品重跑。没有将不显示 usage 的 registry helpText 方法当作显示证据。

首次 guarded shard 的命令、exit 与 raw 一致：**15 pass / 44 expect / 0 fail / 0 skipped / Completed / exit 0**。分解为 **9 existing / 20 expect + 6 focused / 24 expect**，没有复制 parser 或手工镜像 CLI recipe。前两项 characterization 断言当前缺陷，测试通过不表示产品已修复。raw/exit 声明先落盘后检查；复核只读取其已保存文件。

已核作者 receipt 中 **13 个 artifact SHA/bytes**，以及 source manifest **15 项冻结 Git blob、当前 SHA/bytes/行数**，全部一致。报告 **26 个本地链接**存在且引用行不越界。source SHA 是文件字节 pin，选读范围及 runtime/source-only 区别保留，不视为整份大组件已审查。

全历史 dedup 的 2,050 文件、260,970 string leaves / 363,859 scalar leaves 与本 lane 独立库存相符，0 解析错误。exact builder/parser 与旧 archive 的正确 `security,performance` 示例未记录同一用法矛盾；关键词和有限上下文仍有语义限制。R2-03 固定三反引号与 DESKTOP-R12-01 UTF-16 边界作为旧机制的新静态上下文归 related，未重复计新增 finding/candidate，也未重跑旧 Markdown/Unicode 动态方向。围栏的模型解释、Unicode编码/UI影响均未验证；旧 Desktop 修复没有被推定覆盖此 builder。

没有需要阻塞集成的问题；本复核的产品执行与重试均为 0。
