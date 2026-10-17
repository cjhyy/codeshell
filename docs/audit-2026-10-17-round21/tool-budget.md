# Core 工具输出预算 leaf 审查

冻结源码 `615e4e4dd3a61b1ad132ab4f3683985a0d582386`。本 lane 新增正式发现 **0**、新候选 **0**，补充 **1 处旧预算 floor concern 关联**。只记录，没有产品修改。

实际导入和执行 [`tool-output-budget.ts`](../../packages/core/src/context/tool-output-budget.ts#L1) 及其唯一 runtime dependency [`token-counter.ts`](../../packages/core/src/context/token-counter.ts#L33)；仅调用后者的 `estimateStringTokens`，不能扩大为全部 token-counter 函数覆盖。类型导入擦除，没有 mock、源码提取、真实 tokenizer、模型、网络、文件存储或 native 操作。`ContextManager`、`compaction`、`tool-result-storage`、Engine 和工具执行器只读清单列出的必要段落，没有导入执行。

## BUDGET-R21-R1：旧预算 floor concern 的 structured slots 边界

第四批已记录“many individually short outputs cannot shrink 导致 aggregate budget 仍超限”的 [source concern](../audit-2026-10-17-round4/context.md#L41)，当时没有正式项、候选 ID 或动态证据。本批保守关联到这个预算 floor 边界，不新增正式问题或候选；具体观察是**单个 structured result 内的空 text slots 分隔符下限**。

- [`createToolTextReplacement:78–106`](../../packages/core/src/context/tool-output-budget.ts#L78) 先预留每两个 text slots 间的 `\n\n`。当分隔符已超过预算，正文分配归零；`:106` 因 `availableChars === 0` 返回，即使 joined text 仍超预算。
- 实际生产调用的正预算可静态确认：[`compaction.ts:773–776`](../../packages/core/src/context/compaction.ts#L773) 的 aggregate backstop 传 `maxChars: 600, maxTokens: 200`。这条 caller 仅在整个 message 超 aggregate gate 后执行；本批没有导入该模块或触发 gate。
- 用这组真实正预算调用实际 leaf，自有 **302 个 `text: "x"` slots** 的 joined 原文仅 **904 字符**。结果保留 302 个空 text slots，joined separators 为 **602 字符 / 151 heuristic tokens**，`exceedsToolOutputBudget` 为 true。**301 slots** 对照为 **600 字符 / 150 heuristic tokens**，正好满足预算。替换后每个 slot 的位置保留，输入仍全是 `x`。这是当前行为刻画，不是修复测试。
- 证据限制：302-slot 数组是手工合法 DTO，没有证明普通工具会产生这个 slot 数量，也没有证明默认 `ContextManager` 的 aggregate gate 普通可达。默认单结果预算静态为 [30,000 chars / 10,000 estimated tokens](../../packages/core/src/context/manager.ts#L83)，不能把本例的 600 上限说成默认单结果上限。没有运行实际工具、MCP、provider、消息总预算或 UI，也没有证明真实上下文窗口超限、拒绝或丢失。没有使用 0、负数或 NaN 预算。

May 30 的 [旧 magic-200 预算记账问题](../archive/review-2026-05-30/findings.json)（索引 28）是估计 replacement 长度错误；本批静态 caller 已按实际 `replaced.text.length` 记账。这与单个 structured result 的 separator floor 不同；没有重跑旧 aggregate 回归或宣称修复验证。旧 CTX-1 pairing、CTX-2 structured summary text omission、JSON summary repair 失败路线以及 Unicode 问题均未恢复。

## 普通边界与首跑证据

首个且唯一 guarded shard **18 pass / 94 expect / 0 fail / 0 skipped，Completed，退出 0**：**8 个 existing tests + 10 个 focused tests**。Focused 包括 9 个控制用例（其中 301-slot 是手工 floor 边界对照）和 1 个上述手工关联用例。所有 focused 断言均调用实际 leaf，没有手工镜像 Manager 配方。

普通控制检查文本 slots 提取/顺序、空 slot、inclusive 字符/heuristic token 上限、小正预算不添加超大 notice、ASCII head/tail 确定性、短 slot 保留与长 slot 分配、非文本块顺序和对象身份、输入不变、under-budget 原块身份和错误 replacement slot 数拒绝。媒体仅是 `{type:"image"}` 标记对象，不含真实图像 bytes。Existing suite 自带固定默认 30k-cap 附近的 CJK 样本及 Unicode 回归，只作为已有控制运行，没有另开 Unicode、性能或大输入压力方向。字符长度与 heuristic tokens 都明确不是 provider 精确 tokenizer 合同。

[Focused fixture](evidence/toolbudget-focused.test.ts)、[首跑合并原文](evidence/toolbudget-first.raw.log)、[退出收据](evidence/toolbudget-first.exit.json) 可核对。Raw stdout/stderr 与退出 JSON 在首次查看日志前保存，从未覆盖；没有失败 shard、产品修复、重试或替代验证。只读导航误猜目录/旧报告拼写、辅助静态输出截断和 preflight range 标签修正已单独 [转录](evidence/toolbudget-metadata-notes.json)，不是产品失败；产品 fixture 在 preflight 后保持原 hash。

## 范围与查重

[源码清单](evidence/toolbudget-source-manifest.json) pin **11 个实际文件**，区分全读/执行、全读但不执行和选段静态。只有两个纯 runtime 文件的相关函数执行；没有 broad build、typecheck、lint、完整 suite、实际模型/工具、用户文件、网络、权限、security 或 custody 实验。

[全历史查重](evidence/toolbudget-dedup.json) 读取 `docs/`、`bugs/` 全部 Markdown 与递归 JSON scalar 值，含 archive / _archive，排除本批：**2,169 文件（1,189 MD / 980 JSON），288,528 string leaves / 404,370 scalar leaves，0 parse error**。Exact budget 39、separator/floor 39、aggregate 41、Unicode 179、structured 92 次总命中；每类上下文最多 25，全部命中定位及只读时文件 hash 保留。关键词命中不是全仓语义穷尽证明。[人工去重判断](evidence/toolbudget-dedup-decisions.json) 保留旧 source concern、旧记账问题及排除路线的定位。

[Preflight](evidence/toolbudget-preflight.json)、[验证范围](evidence/toolbudget-validation.json)、[正式项](evidence/toolbudget-findings.json)、[候选](evidence/toolbudget-candidates.json)、[关联项](evidence/toolbudget-related.json) 和 [材料 hash 收据](evidence/toolbudget-artifact-receipt.json) 可独立检查。全历史 inventory 是冻结读取时刻的语料，不能当作最终 main 语料的 hash 声明。
