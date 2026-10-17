# Core 工具摘要 leaf 审查

冻结源码 `d40dd06987a2e0c20c377e243cf5c4e4b549c9ec`。本 lane 新增正式发现 **0**、新候选 **0**、旧机制关联 **1**。只记录，没有产品修改。

实际执行 [`generateToolUseSummary`](../../packages/core/src/engine/tool-summary.ts#L27)；其唯一 runtime import `logger` 在导入前按精确绝对模块路径替换成内存 `warn` spy。生产 leaf 的其余逻辑保留，类型 import 擦除。没有导入真实 logger、Engine、TurnLoop、provider、工具执行器或现有耦合 TurnLoop 测试，没有读写真实日志、用户文件或调用模型。

## TOOLSUMMARY-R20-R1：旧的非 Error 捕获机制在工具摘要处仍有弱触发边界

- 位置：[`tool-summary.ts:47–49`](../../packages/core/src/engine/tool-summary.ts#L47) 捕获后直接读取 `(err as Error).message`；函数注释称失败返回 `null`。
- 实际观察：对自有普通 `ToolCall` / `ToolResult`，手工 fake async callback 抛出 `null` 或 `undefined` 时，实际 leaf 拒绝为 `TypeError`，没有到达 warn spy。对照 callback 抛普通 `Error` 时返回 `null`，恰好写入一条内存 warn；手工字符串拒绝仍返回 `null`，warn 的 `error` 是 `undefined`。这是现状刻画测试，不是修复验证。
- 查重结论：May 30 的 [`findings.json`](../archive/review-2026-05-30/findings.json) 索引 36（`openrouter-sync`）和 119（旧 Arena 工具）已记录“将任意捕获值直接当 Error 读取 `.message`”机制，故本处只作为不同位置的旧机制关联，不新增正式问题或候选。
- 证据限制：这里的 `null` / `undefined` 拒绝是手工回调输入，没有证明普通 provider/aux client 会产生它。只静态读取 [`run-accounting.ts:145–170`](../../packages/core/src/engine/run-accounting.ts#L145) 的 callback 生产者，未运行 client 或 provider。普通生产路径还有 [`TurnLoop:1695–1728`](../../packages/core/src/engine/turn-loop.ts#L1695) 的尾部 catch；本实验没有运行该链，不能声称主模型调用失败、进程崩溃、未处理拒绝或 UI 丢失。

## 已检查的普通边界

首个且唯一 guarded shard **14 pass / 42 expect / 0 fail / 0 skipped，Completed，退出 0**。其中 11 个普通控制用例、3 个上述手工拒绝关联用例；全是实际 leaf 调用，只有 callback 和 logger 是内存替身。合并 stdout/stderr 的 [原始日志](evidence/toolsummary-first.raw.log) 及 [退出收据](evidence/toolsummary-first.exit.json) 都在查看日志前保存；没有失败 shard、修复或重跑。

普通控制覆盖：空 batch 不调用 callback；按顺序的两工具名称/JSON 参数/输出；空成功结果；只有 `error` 的正常失败结果；ASCII 参数前 200 和输出前 300 的当前裁剪；signal 原样透传；已取消 signal 的普通 Error 拒绝；摘要两端 trim、全空白返回 null；普通 Error 失败返回 null；输入对象不变。没有由 bounded ASCII 输入推断 Unicode、字节、超大对象性能或真实模型行为。

只读接线表明 [`StreamingToolQueue.drain`](../../packages/core/src/engine/streaming-tool-queue.ts#L105) 依原始调用顺序生成结果，TurnLoop 将 display 结果数组传入摘要；[`registry.ts:251–269`](../../packages/core/src/tool-system/registry.ts#L251) 正常失败对象只含 `error`，成功对象补 `result`。因此没有构造数组错位、缺项或“空 result 同时含 error”来报告正常产品缺陷。May 30 旧 tool-summary 数组长度问题的 backlog verdict 已是 false positive，本批不恢复该路线。

系统 prompt 的 `under 40 chars` / `ONLY the summary text` 是给 callback/model 的要求，当前 leaf 只有 trim。本批没有普通模型多行/超长输出证据，没有把手工违背 prompt 的 callback 返回值当新产品 bug。旧 JSON summary repair 失败路线完整排除，未导入旧 JSON parser、memory orchestrator 或其 fixture。

## 范围、查重和收据

[源码清单](evidence/toolsummary-source-manifest.json) pin 了 10 个实际文件：leaf 全读并执行；`streaming-tool-queue`、`tool-result-redaction` 和现有 `turn-loop-tool-summary.test` 全读但不执行；`types`、logger、TurnLoop、run-accounting、model-facade、registry 仅清单所列段落静态阅读，不能扩大为这些模块/子系统全覆盖。

[全历史查重](evidence/toolsummary-dedup.json) 遍历 `docs/`、`bugs/` 的 Markdown 与递归 JSON scalar 值，包含 archive / _archive，排除本批：**2,109 文件（1,176 MD / 933 JSON），267,491 string leaves / 373,239 scalar leaves，0 parse error**。总命中分别为 exact summary 81、summary/error 155、format 11、old JSON summary 465、non-Error 281；每类展示上下文最多 30，全部命中定位和只读时文件 hash 均保留。关键词不是语义穷尽证明；[人工选读与判断](evidence/toolsummary-dedup-decisions.json) 记录旧数组 false positive、旧非 Error 捕获机制、旧 batch 路由和被跳过的 JSON summary。

[preflight](evidence/toolsummary-preflight.json) 先核对真实源码路径、冻结 Git bytes、绝对 leaf 导入和精确 logger mock，没有猜 root node_modules 路径。最初辅助 `rg` 误猜不存在的 `packages/core/src/types` / `tools` 目录，退出 2；这是只读导航错误，实际文件由独立 `rg --files` 发现为 `types.ts` / `tool-system`，不是依赖或产品失败。第一次 dedup 展示输出超出预算而截断；完整 JSON 当次已写盘，随后只读取已保存定位和实际旧记录，未重跑产品。两项均在 [元数据转录](evidence/toolsummary-metadata-notes.json) 保留，未作为 bug 证据。

[验证范围](evidence/toolsummary-validation.json)、[正式项](evidence/toolsummary-findings.json)、[候选](evidence/toolsummary-candidates.json)、[关联项](evidence/toolsummary-related.json) 与 [材料 hash 收据](evidence/toolsummary-artifact-receipt.json) 可独立核对。没有运行大 build、typecheck、lint、完整 suite、真实计时器、网络、真实工具、native、权限或 custody 实验。
