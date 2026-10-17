# 第21批 JSON output 独立复核

复核人：`tool_output_budget_round21`。冻结源码 `615e4e4dd3a61b1ad132ab4f3683985a0d582386`。只读审查作者材料、生产源码选段及只读 `git show` 冻结 bytes；没有产品或 Git 写、没有调用任何新测试、没有修改作者 fixture/report/raw/exit。

结论：接受 **0 正式 / 0 候选 / 0 关联**。首个唯一 guarded shard 的 raw 为 **16 pass / 52 expect / 0 fail / 0 skipped，Completed**，exit 为 0；与 validation 一致。独立核对 **15 个 artifact hash/bytes、12 个 source frozen/current Git+文件 hash、19 处报告本地链接及行号** 全部匹配。Fixture SHA 与 preflight 一致，raw 1,498 bytes 的 SHA 与 exit 收据一致，没有证据指向测试后修改或重跑。

实际 `renderer.ts` runtime import 只有 chalk、Core internal helpers、truncate；Core 类型 import 擦除。Fixture 保留 chalk 的真实 import，并在 actual renderer 导入前按实际 specifier / 绝对 truncate 路径 stub Text-only exports；这些 stub 被调用就递增并抛错，每次 stdout capture 后断言计数为 0。Actual Json/Jsonl/StreamJson class 和 factory 的 JSON 分支保留。作者明确没有运行 TextRenderer、compactSummary、Core barrel、真实截断、旧 TUI Diff/i18n 或混合 existing test，范围陈述准确。

`capture` 在同步 action 前临时替换隔离子进程的 `process.stdout.write`，用 finally 恢复原函数；即使 action 抛错也会恢复。Fixture 没有并发 test、真实进程/PTY/网络/文件/模型调用。创建 renderer 是 actual factory 调用；JSONL 的 event passthrough 和 final envelope 均从 actual class stdout bytes 解析断言。Normal owned metadata 只有 sessionId/turnCount，没有手工碰撞 reserved keys。对空 final 的 JsonRenderer 用例没有先喂 child delta，旧 A12 机制未被恢复。

独立阅读 `run.ts:230–275` 证实 renderer 在一次 invocation 内创建、stream event 转发且 final meta 只传 sessionId/turnCount；这支持作者剔除“实例复用”和 arbitrary meta key collision。旧 archive `backlog_verdicts.json` 第 107 项实际为 false_positive；当前无需推翻该结论。旧 `audit-2026-10-16/root.md:99–107` 已完整描述 A12 child text/空 final fallback，本批去重排除准确。

Core types、run-finalize、protocol server 的可选 completionKind 来源可静态确认，CLI final meta 少该字段也可确认。作者没有将这点升级 bug：没有明确 CLI final schema 完整 RunResult 合同或普通 headless async/goal 可达动态证据。Actual JSONL/stream-json 原始 terminal event 控制保留该字段，只能证明 class passthrough；报告保持这个边界，没有扩大成 Engine/CLI 验证。

Dedup script 遍历 docs/bugs 的全部 MD 与递归 JSON value scalar leaves，排除本批，包含 archive；其133/488/148是命中的 Markdown 行/值叶数量，报告没有误写为正则出现次数。上下文100/组、1,200字符上限和读时 inventory 限制均披露。辅助导航缺失、截断和 source range metadata 修正已记录，不能当作产品失败；没有因此恢复先前失败方向。无需要作者修正的阻塞问题。
