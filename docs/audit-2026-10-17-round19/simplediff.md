# Core simple diff：撤销前预览的文本不变量

冻结源码：`5f5cf69df8526470700712a4dc2d5ae6bd2da132`。本方向 **0 项新增确认缺陷、0 项新增候选、0 项旧问题关联**。首次 guarded Bun 分组通过 **17 个测试、57 次断言、0 失败、0 跳过**，包括现有 7 个测试和新增 10 个聚焦测试。这只覆盖下述叶函数，不代表 `/undo` 完整流程已验证。

## 范围与普通合同

实际运行 [`simple-diff.ts`](../../packages/core/src/session/simple-diff.ts:19) 的 `diffLines`、[`renderDiffPreview`](../../packages/core/src/session/simple-diff.ts:61)。模块没有 runtime imports，fixture 直接用经预检的绝对路径导入；没有加载 Core barrel 或 mock 产品依赖。全部输入是少量自有字符串，其中一项投影用例使用 12 个文本对；单份现有用例最多 30 行，没有性能、压力、内存或大输入实验。

源码 [说明](../../packages/core/src/session/simple-diff.ts:1) 明确是给人看的当前文本 → 恢复目标文本预览，不是 patch generator。合同包含 [CRLF → LF](../../packages/core/src/session/simple-diff.ts:20) 的刻意归一化、保留行标记、[相同内容返回空字符串](../../packages/core/src/session/simple-diff.ts:63) 和 [省略远处未变上下文](../../packages/core/src/session/simple-diff.ts:65)。本批没有要求 hunk headers、行号、no-newline 标记或可供 patch 应用的字节精确表示。

普通 TUI consumer 仅静态选读 [`utility-commands.ts:41-159`](../../packages/tui/src/cli/commands/builtin/utility-commands.ts:41)：[整会话预览](../../packages/tui/src/cli/commands/builtin/utility-commands.ts:86)、[最近一轮预览](../../packages/tui/src/cli/commands/builtin/utility-commands.ts:131) 均把当前文本作为 `from`、backup 作为 `to`，省略 `context` 使用默认 3。首次源码读取也显示该文件其他 utility 命令，但没有审查或执行它们。没有运行命令、FileHistory、文件读写、undo、patch applier、Markdown/终端 renderer 或原生 Git。

## 首次验证

[聚焦 fixture](evidence/simplediff-focused.test.ts)、[原始 combined stdout/stderr](evidence/simplediff-normal.first.raw.log) 和 [退出回执](evidence/simplediff-normal.first.exit.json) 保留首次字节与退出结果；raw 和 exit 均先落盘，再检查内容。只有一次执行，没有失败后修复、重试或替代验证。

```text
node scripts/run-bun-test-shard.mjs --timeout 30000 packages/core/src/session/simple-diff.test.ts docs/audit-2026-10-17-round19/evidence/simplediff-focused.test.ts
```

| 实际覆盖 | 观察与限度 |
| --- | --- |
| 现有 7 个叶测试 | 相同文本、增删改和 context 省略；13 次断言。现有 30 行用例只是固定小样本，不是压力结果。 |
| 12 个普通文本对 | 从实际 diff rows 分别保留非 `+` / 非 `-` 行，重组为归一化后的 from / to；含重复行、换序、Unicode、空文本、空行及尾换行；24 次断言。此投影检查不把输出作为 patch 执行。 |
| CRLF 与普通换行 | 两个方向的纯换行风格差异均产生空预览；含实际文本变更时上下文和 `-/+` 标记归一化后正确；5 次断言。 |
| 空内容、尾换行、内部空行 | 空内容保持空预览；非空与空内容互换、单个尾换行增删、内部空行增删均有显式 split-token 行标记；8 次断言。 |
| context 0 / 1 / 默认 3 | 保留每个变更，只省略未变行；两个变更的 context 1 分开、context 2 合并，不重复行；5 次断言。这些有限整数参数只在叶函数调用中验证，实际 TUI 使用默认值。 |
| 字面 `⋯` | 内容中的该字符仍带 ` ` 或 `-` 行标记，与单独 gap marker 区分；2 次断言。 |

首次输出为 `17 pass / 0 fail / 57 expect() calls`，并有 `Completed Bun shard: 17 tests, 0 skipped; 0 failures.`。其中 **10 个聚焦测试 / 44 次断言**，加上 **7 个现有测试 / 13 次断言**。没有运行完整 suite、build、typecheck 或 lint。

空字符串 `.split("\n")` 和尾换行产生空 token，预览会显示 `-` / `+` 空行标记。这是本批明确记录的表示方式；在其 human-preview 合同下，没有据此建立普通用户触发的独立错误。CRLF-only 差异被隐藏也是明确源码合同。没有把这些现象包装为 bug。无普通 producer 的负数、小数、NaN 或无限 `context` 没有测试，也没有列候选。

## 历史去重与排除

[去重脚本](evidence/simplediff-dedup.py) 从真实 `rg --files` 库存读取此前全部 `docs` / `bugs` Markdown 与递归解析 JSON 值，包含 archive/_archive，排除本批：**2,050 文件 = 1,161 Markdown + 889 JSON；260,970 string leaves / 363,859 scalar leaves；0 读取或解析错误**。[去重结果](evidence/simplediff-dedup.json) 保留完整计数、命中文件和每 pattern 最多 20 条上下文；上下文上限不限制计数。

exact path/name 共 50 命中，主要是架构、历史模块库存、既有 static read 和历史 native-observation 加载列表。已核对 [第四批](../audit-2026-10-17-round4/root.md:26) 与 [旧线索表](../audit-2026-10-17-round4/candidates-and-skips.md:16)：`O(n*m)` LCS 成本先前仅静态观察，本批整条方向排除，没有重复验证或新增计数。空行/尾换行和围栏 pattern 分别为 8 / 15 命中，多为其他 preview、ApplyPatch 或旧 Markdown export 记录；它们不作为当前 leaf 的动态证据。没有运行 Markdown renderer 来建立或重复围栏问题。关键词索引不是全历史语义完备证明。

预提案基于前一冻结点，本批已针对当前冻结 SHA 重新核对 simple-diff source、现有 test、普通 TUI consumer 的三项 pin；见 [预检](evidence/simplediff-preflight.json)。全部 6 个选定文件（含 instructions/runner 的元数据 pin）当前字节均等于冻结 Git blob，详见 [source manifest](evidence/simplediff-source-manifest.json)。文件 pin 不等于整个 utility 文件或传递依赖已审查。

计数与排除见 [validation](evidence/simplediff-validation.json)。没有导航、依赖或 fixture 失败；没有恢复旧 TUI Diff、recorder 或其他已跳过方向。只写本报告与 `evidence/simplediff-*`，未修改产品、依赖或 dist，未执行 Git 写操作。
