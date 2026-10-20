# Tabstops 范围只读复核

复核者：`bidi_round16`。只读报告、实际库存的 fixture/raw/exit/validation/candidates/source/artifact receipts 及精确源码片段；本次复核没有产品 import、测试、终端、平台 gate、依赖 resolver、Git 写入或新增 runtime。

结论：接受当前 **0 formal、2 candidate、0 related** 和 **1 clean shard / 9 pass / 27 expect / 0 fail / 0 skip / 0 rerun**。无必改项。

- 首次 raw 从 exit receipt 的 `rawLog` 读取，存在 `Completed Bun shard: 9 tests, 0 skipped; 0 failures.`；原始 bytes/SHA 与 exit receipt 一致。验证汇总与原始计数一致，全部 9 项是 focused（7 常规控制、2 候选刻画）。通过断言包含当前不一致行为，没有被解释成修复。
- fixture 在 import 前只将 Core internal barrel 替换成实际 `utils/intl.ts` 的 `getGraphemeSegmenter`。实际 `expandTabs`、真实 tokenizer、真实 `stringWidth` 模块被导入，当前执行走真实 Bun `stringWidth`；未把整个 Core barrel、JS fallback 或 UI 当成已执行范围。
- TAB-R16-C1 的 9 来自实际纯函数，12 来自明确标出的独立整数算式。报告已区分相对起点 0 与静态 `output.ts` 绝对起点；已查看 `dom.ts` 测量调用、`output.ts` cell 起点和 `CodeBlock.tsx` 的 margin/prefix 片段。未执行 DOM/Yoga/writer/组件/终端，因此最终裁剪、溢出或纠正仍未证明，保留 candidate 合理。
- TAB-R16-C2 的 raw 确认 whole prefix 宽度 2、两 token 各 2、tab 空格 6 与 4、带样式展开结果宽度 7。SGR 在 ZWJ 内部的输入确为手造，当前普通 producer 不曾执行；报告没有外推到实际合成 glyph、正常 markdown 或终端显示。ASCII SGR、OSC 8、中文及分解重音对照已明确。
- 旧 ANSI Parser width metadata 候选只作查重区别，没有借旧证据升级本次影响；已失败 `sliceAnsi` 方向未恢复执行。导航 2 次错误、collector 1 次元数据顺序错误与 Bun 失败分开，首响应已留存。
- 17 项 source pins 的冻结 Git blob SHA 均匹配，当前源码 bytes 均与冻结一致；12 项 artifact 的 bytes/SHA 均匹配 receipt。该清单证明所列文件身份，未当作全部源码或所有消费者已测试。历史查重分别列出 222,452 string leaves 与 309,912 scalar leaves，没有混淆统计口径。

只读检查未发现材料之间的计数、证据边界或收据冲突。候选保留现有不确定性，不能用本次复核代替完整 UI/终端验证。
