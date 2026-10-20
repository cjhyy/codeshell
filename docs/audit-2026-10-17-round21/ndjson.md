# 第21批 — TUI NDJSON reader leaf

冻结点：`615e4e4dd3a61b1ad132ab4f3683985a0d582386`。本方向 **0 新确认、0 新候选、0 新关联**，只记录，没有产品修改。

完整读取 [ndjson-reader.ts](../../packages/tui/src/cli/input/ndjson-reader.ts#L1)（79 行）与 [原测试](../../packages/tui/src/cli/input/ndjson-reader.test.ts#L1)（36 行）。真实 leaf 只 runtime-import `node:readline`；本次通过绝对路径导入并使用 Node 内存流，没有 mock。每个 constructor 都显式传入自有 `PassThrough` 或 `Readable.from`，没有触碰默认 `process.stdin`。

## 首次验证

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-17-round21/evidence/ndjson-focused.test.ts
```

[首次 combined raw](evidence/ndjson-first.raw.log) 与 [exit 收据](evidence/ndjson-first.exit.json) 均在检查前保存。exit 0，guard Completed：**15 pass / 30 expect / 0 fail / 0 skip**，一次尝试，零重跑。15 个都是本次 [focused fixture](evidence/ndjson-focused.test.ts)；原测试中的 `tick()` 使用 `setTimeout(5)`，因本分区排除 timer，没有执行原文件或把它的两个测试计入通过数。

其中 7 个 `start()` grammar 控制、5 个 `messages()` iterator 控制、3 个 lifecycle 控制。真实 leaf 对普通 message/ping 保持顺序；跳过空白与 malformed JSON；保留 content 的空白、转义换行和空字符串；支持 JSON syntax 分块、跨块 CRLF、逐字节 UTF-8 的中文/emoji/组合字符，以及 EOF 前没有最后换行的消息。生命周期控制复核 stop-before-start、重复 start 的幂等性、EOF 关闭一次，以及 stop 后忽略后续行/再次 stop 不重复关闭。`abort` handler 在 fixture 中仅用作 readline 的关闭通知，没有输入 abort 命令或启动任何实际取消动作。

这些是小型自有数据的 leaf 行为证据，不证明 native stdin、所有 stream/resource 路径或完整 CLI 的表现。生命周期中的两项也与原测试和旧修复控制重叠，未称为新缺陷复现。

## 调用链与历史范围

[literal 引用导航](evidence/ndjson-navigation.json) 搜索 packages/scripts/tests 下 TS/TSX/JS/MJS/JSON 的 `NdjsonReader|ndjson-reader`，只找到 leaf 与原测试。selected 静态读取 [main.ts](../../packages/tui/src/cli/main.ts#L87) 的 imports、common/run 选项及 resolveOpts，以及 [run.ts](../../packages/tui/src/cli/commands/run.ts#L38) 的 imports/RunOptions/header（范围见 [source manifest](evidence/ndjson-source-manifest.json)）。main 的普通 run task 来自 `resolveTaskFromArgOrStdin`，输出选项也没有构成这个 reader 的普通输入消费链。没有导入或执行这两个 CLI 模块；literal 搜索不排除 computed/generated/exported SDK 的外部消费者。

[全历史扫描](evidence/ndjson-dedup.json) 包含 prior docs/bugs，含 archive、排除本批：**2,169 文件 = 1,189 MD + 980 JSON；288,528 string leaves / 404,370 scalar leaves；0 parse errors**。35 条精确匹配和 53 条机制匹配均保留有限上下文，string 与全部 scalar 计数分开；关键词不是语义穷尽证明。很多历史 JSON 是复制同一旧记录的上下文，不能算独立问题。库存是这次读取时点，不承诺最终 main 的历史文档内容不会改变。

[May30 原记录](../archive/review-2026-05-30/round2_section.md#L34) 已记 `start()` readline 未保留/关闭的旧 leak；[选出的完整 JSON 记录](evidence/ndjson-history-selected.json) 中 `backlog_confirmed.json $[27]` 已指出未找到调用方。当前 source 的 `rl`、start guard、stop 及原 regression tests 都显示该实现已经变化，本次只补小型内存流控制，没有再记新项或宣称所有资源问题已修复。[10/12 报告](../review-remaining-2026-10-12/coding-tui-chat.md#L217) 也已有此 reader 的静态覆盖，本次如实承认。详见 [去重决定](evidence/ndjson-dedup-decisions.json)。

没有动态探测 schema/type、handler throw、多 handler、restart、混用 callback/iterator 或压力方向；未建立普通 producer/consumer 时不将自造条件上升为缺陷或候选。approval/auth/security、实际 abort 命令，以及旧失败 CLI data/read-stdin 等方向继续跳过。无 CLI/PTY/native/model/account/network/用户输入文件/实际应用 timer/watchdog；无完整 build/typecheck/lint/suite/E2E。

初始历史 `rg` 误包含巨型单行 JSON，工具显示被截断；后续保存的递归 scalar 库存和有限上下文才用于历史判断。另有两个 prior receipt 文件名猜测未命中，以及准备消息的 start/iterator 分组计数纠正（最终 7/5/3）。这些是 metadata 调整，没有修改 fixture/raw 或重跑产品，见 [validation](evidence/ndjson-validation.json)。
