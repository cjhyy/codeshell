# 第二十二批 terminal-ui 静态提案复核

冻结点 `ab258c3f534b19014b2ed85da3111649f166ab86`。本方向 **0 新正式问题、0 新候选、0 新关联**；另保留 **1 条未分类静态线索**。产品运行、模块 import、构造函数、输出捕获、TTY、timer 和测试执行均为 0。下述 Python/subprocess 操作只采集审查元数据，不是产品 stdout 或产品行为实验。

[前批提案原件副本](evidence/terminal-prep-proposal.json) 起始于 `615e4e4`，完成时 HEAD 已为 `ab258c3`；其历史库存是当时的工作树读数。此次重新查验 [五份源码 pin](evidence/terminal-sources.json)，冻结 Git blob、当前字节、前批 hash 全部相等。全文静态读取 terminal-ui 的 235 行、renderer 的 163 行；run.ts 只读 1–27、225–280 行。前批两份 Core 类型文件此次只核对 hash，**不计为本批源码阅读覆盖**。

## 动态方向排除

[terminal-ui.ts:5](../../packages/tui/src/cli/output/terminal-ui.ts#L5) 有六个运行时依赖；模块顶层在 17–19 行修改 chalk.level，21–22 行构造 Marked 并安装 markedTerminal。createSpinner 在 63–69 行构造并启动 ora；printBanner 会调用 Core getCurrentVersion 和 console.log。对当前审查约束而言，直接 import 已会触发初始化，不能把其中的字符串逻辑视作零依赖纯叶子。本方向没有抽取函数、替换依赖或构造假消费者来强行执行。

[首次普通名称检索](evidence/terminal-navigation.json) 只命中该文件本身。[补充全部导出名称检索](evidence/terminal-exports-navigation.json) 另见 MessageContent 的同名本地 renderer 和测试 helper、Desktop 测试本地函数、harness 的 renderMarkdownReport；这些命中没有导入 terminal-ui。当前检索范围为 packages/scripts/tests 下 TS/TSX/JS/MJS/JSON 的字面名称，不能排除生成、计算或仓库外的消费者。

已核对的真实 headless 接线是 [run.ts:26](../../packages/tui/src/cli/commands/run.ts#L26) 从 renderer.ts 导入 createRenderer，233 行构造 renderer，236 行转交 envelope.event，242–245 行提交结果。renderer.ts 全文没有导入 terminal-ui。这是 selected caller 的静态证据，不是 CLI、Engine、transport、TextRenderer 或真实终端执行。

## 未分类静态线索：banner 内宽算式多出四列

[printBanner:94](../../packages/tui/src/cli/output/terminal-ui.ts#L94) 的横边和空白行使用 width=56。标题、信息行、帮助行在 106、113、121 行采用 `width - stripAnsi(line).length + 4` 补位。对于未超过 width、只含短 ASCII 正文的行，从源算式可推导两竖边之间是 60 列，而横边/空白行内部是 56 列。这只是代码算式推导，没有调用函数、记录屏幕、捕获 console、实测列宽或运行版本查询。

源码注释只说“Print a styled banner box”，尚未建立普通生产消费者及其展示合同，因此保留为未分类 frontier，不给候选编号、严重性或新 bug 计数。旧 CodeBlock 边框记录是另一份文件的 40/44 算式；[历史原条目摘录](evidence/terminal-prep-provenance.json) 仅支持排除混淆，不证明本线索新颖、可达或已修复。

## 历史排除与检索边界

[新历史扫描](evidence/terminal-history.json) 排除本批，读取 docs/bugs 全部递归 Markdown 与 parsed JSON 标量（含 archive/_archive），库存 **2,232 文件 = 1,202 MD + 1,030 JSON**，JSON 为 **309,994 个 string leaves / 436,035 个 scalar leaves**，0 parse errors。target 模式 37 次命中全部保留；较窄 banner 模式为 0；known_overlap 模式 1,860 次命中只保留前 80，且 `A12` 会误中 SHA 字符串。[宽泛 banner 补查](evidence/terminal-banner-history.json) 使用同一库存，74 次命中全部保存，含无关的“边界”文字。以上是匹配次数，不是问题数量或语义穷尽证明。

已实际选读 [A12](../audit-2026-10-16/root.md#L99) 的父子 delta/空 final fallback；全文读 [round7 TUI](../audit-2026-10-17-round7/tui.md)、[round12 Desktop](../audit-2026-10-17-round12/desktop.md)、[round14 utils](../audit-2026-10-17-round14/utils.md) 和 [round21 JSON 输出](../audit-2026-10-17-round21/json-output.md)。同文件 formatToolArgs 重复实现已在 May30 findings 的第 161 项登记。Unicode 截断、显示列宽、UTF16 字节标签、A12 和流撤销/重试关联不新增计数；旧 TUI Diff、sliceAnsi、JSON summary、i18n 失败方向均没有恢复。没有把历史候选重新定级，也没有执行旧实验或声明修复通过。

只写入本方向报告和 evidence/terminal-*；没有产品/Git 写、共享依赖或 dist 改动、模型/账户/用户资料/网络业务调用、权限/security/custody/PTY/native 操作、完整 build/lint/typecheck/suite。可继续从别的独立低风险叶子选择后续范围，本文件不构成全仓审查完成结论。

[采集命令](evidence/terminal-commands.json)、[元数据首次 raw/exit](evidence/terminal-collector-exit.json)、[补查首次 raw/exit](evidence/terminal-banner-collector-exit.json)、[方向汇总](evidence/terminal-summary.json) 与 [材料收据](evidence/terminal-artifact-receipt.json) 保留重建入口和证据界限。
