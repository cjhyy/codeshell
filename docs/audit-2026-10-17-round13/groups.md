# Desktop 消息分组与文件摘要纯数据审查

冻结源码：`7927a7c8b80b4aec710dee1f6d831ad1982bb466`。本子任务 **0 正式发现、2 静态候选、1 旧家族关联**。仅写本报告及 `evidence/groups-*`，没有改产品、Git、依赖或共享构建产物。

## 范围与证据等级

阅读 `packages/desktop/src/renderer/messages/streamGroups.ts` 的核心分组/时间/签名路径，完整阅读 `agentGroup.ts`、`fileChangeAggregator.ts`、`time.ts` 及其三份现有基线、时间测试；选择性阅读 `turnTiming.test.ts`、`MessageStream.tsx:416` 的实际折叠管线、`types.ts:1224` 工具消息 producer、`:1335` 结果终态 producer、`:1897` 文件摘要消费，以及 `FilesChangedCard.tsx:30` 的摘要卡合同。另静态核对 Coding `tools/apply-patch/parser.ts` / `types.ts` / `index.ts:25` 中本地 V4A 合同。大消费者文件只核对指定相关片段，没有声称通读或端到端验收。

只执行了一份现有纯逻辑基线：真实 `aggregateFileChangeSummary` / `countLines` / `summarizeAgentGroup` / `foldAgentGroups`，以及已有测试调用的 `parseUnifiedDiff`。33 tests / 66 expect / 0 fail / 0 skip，guarded runner 完整 Completed。`streamGroups` / `time` / `turnTiming` 没有动态验证；没有运行 React、Electron、DOM、原生工具、真实补丁、Git 产品调用、模型、网络或用户数据。

随后聚焦摘要实验的首次导入失败，整个聚焦方向按约定跳过。见 [跳过说明](evidence/groups-skip-note.md)、[首跑失败日志](evidence/groups-patch-summary.first.raw.log) 与 [exit 收据](evidence/groups-patch-summary.first.exit.json)。失败 fixture 中的断言是预定观察，不是实际观察；七个测试体均未执行。以下两个候选只能由静态源码支持，不计正式 bug。

## GROUPS-R13-C1：合法 Delete 补丁可能不生成文件摘要

- 正常输入合同：`packages/coding/src/tools/apply-patch/index.ts:29` 明确支持删除；`:42` 描述的 `*** Delete File: obsolete.ts` 是仅有 header 的合法操作，`parser.ts:127` 产生 delete hunk，不要求 `-` 行。模型经普通 ApplyPatch 执行成功后会有常规 succeeded ToolMessage；`types.ts:1345` 以无 error/isError 的工具结果赋该状态。这段 producer 与合法操作来源均为静态接线，没有实际执行 ApplyPatch。
- 可疑分支：`fileChangeAggregator.ts:118` 识别 Delete header，但 `:126` / `:127` 初始化的行数为 0；`:95` 的 flush 仅在增加/删除行数非零时才推入条目。因此源码显示正常 header-only delete 的摘要条目会被丢弃；只有该操作时 `:158` / `:422` 会导向 null，和支持的普通 Add/Update 不同。
- 潜在影响：Files Changed 文件名/计数摘要缺少删除文件；`types.ts:1897` 只在非空 summary 时创建卡。工具消息和原始 patch 仍保留。没有实测卡片、实际删除、Undo/Redo、Review 或磁盘状态，不声称文件丢失或撤销失效。删除内容不在参数里，确切删除行数可能本来不可知；候选只要求不遗漏受影响文件名，并不要求凭空计算内容。
- 拟定混合 Add/Update、嵌套子代理对照未执行。现有 Add/Update 基线通过只能说明它已有范围有效，不能验证此候选。
- 全历史检索未找到相同 Desktop header-only delete 摘要项。旧 ApplyPatch undo 新文件问题属于真实文件快照路线，不是这里的展示摘要。

## GROUPS-R13-C2：合法 V4A 内容行可能被当成 unified diff header 排除

- 正常输入：把 JavaScript `--counter;` 改成 `++counter;`，V4A 内容会写成 `---counter;` 与 `+++counter;`。本仓 `apply-patch/parser.ts:14` 的 change_line 合同是一个正负 marker 加任意内容；这份本地语法将 marker 后全部文本视为内容。没有外部格式推断或实际文件操作。
- 可疑分支：Desktop `fileChangeAggregator.ts:137` / `:140` 无条件排除以 `+++` / `---` 开头的行，套用了另一种 diff 的文件 header 规则。源码上，两条内容都被排除会让 `:95` 的条目门槛不成立；只排除一侧则可能产生错误单侧计数与合成 diff。
- 潜在影响限于该摘要/会话合成 diff；原始参数与工具结果没有由本函数改写，不声称真正源码变更错误。普通无该前缀的 Add/Update 是已有通过基线；聚焦符号前缀对照因加载失败未运行，故仍是候选。
- 全历史关键词加结构化 JSON 叶子检索未找到同项。旧 `countLines` trailing newline 项（`docs/archive/review-2026-05-30/round2_section.md:25`）已由当前源码与通过基线覆盖；本候选是标记分类分支，非尾换行计数复报。此前 Round12 Desktop unified diff 解析候选属于另一个格式和函数，不借其结果替代这里的失败实验。

## GROUPS-R13-R1：Move 分支与旧外部重命名家族关联，不增正式/候选计数

`fileChangeAggregator.ts:132` 对任意 `*** ` 行 flush，所以合法 `*** Move to: new.ts` 会结束当前 Update 的收集；`apply-patch/parser.ts:139` 与工具合同 `index.ts:36` 明确支持该可选行。这是不同 Desktop 摘要 parser 的静态可疑支线。旧 [R2-08](../audit-2026-10-17/root.md#r2-08-p3-codex-apply_patch-重命名的变更文件列表遗漏新路径) 已记录外部 Codex changedFiles 提取漏 destination；为避免把同一用户可见重命名家族拆成数量，保留关联，不新增正式或候选。该支线也包含在已跳过的聚焦 fixture 内，没有运行或修复。

## 其余阅读结论与未覆盖

- `agentGroup.ts` 的成功/失败/运行数、并行 wallMs、单 agent 保持、相邻与嵌套折叠在既有基线中通过。普通 agent_start/agent_end 对 done 和时间的生产写入仅静态核对。没有从畸形手工对象推出“正常子代理失败被计成功”等结论。
- `streamGroups.ts` 的透明 thinking、硬边界、bookkeeping 尾锚点、steer、生命周期 timing 和不可变消息 identity reconciliation 只做源码/既有测试阅读。多 thinking lookahead 的性能可能性缺少本轮普通 producer 与动态证据，不新增项；没有假称全分组路径通过。
- `time.ts:86` 的固定 24 小时算昨天与 `:66` 的固定毫秒回推周一在夏令时日历下需要进一步核对；本轮没有设置实际时区、验证相邻 DST 日或运行时间/i18n 入口，不登记正式/候选，也不把旧 recorder midnight 失败路线恢复为新证据。未来跨日时间归类与超出 Date 可表示范围同样缺少正常 producer 合同，未新增项。
- 没有通过原生应用、真实浏览器、React mount 或重建 workspace dist 来增加覆盖。

## 查重与执行收据

[全历史 corpus](evidence/groups-dedup.json) 扫描所有 `docs/` 与 `bugs/` 下 MD/JSON（递归含 `archive` / `_archive`，排除本轮）：1075 MD + 641 JSON = 1716 文件，240534 JSON 叶子，0 解析错误，记录每个文件哈希及 216 个名称/概念命中。再用 [补丁语义补充](evidence/groups-patch-dedup.json) 搜索 Delete / Move / 符号前缀相关概念，51 个命中；核对上述 R2-08、May 30 countLines、undo 和 Round12 patch/parser 相关旧记录。关键词与所读上下文仍不等于语义穷举。

[验证清单](evidence/groups-validation.json) 与 [冻结源码清单](evidence/groups-source-manifest.json) 分开记录：1 clean 首跑 shard（33 tests、66 expect）+ 1 failed 首跑 shard（加载阶段 0 pass、1 fail、1 error），0 重跑。只有 clean shard 计入成功测试总数。[artifact 收据](evidence/groups-artifact-receipt.json) 仅校验自有文件字节，不是产品测试；没有安装外部依赖。
