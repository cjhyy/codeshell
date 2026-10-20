# Round7 TUI 普通文本与消息数据

冻结源码 `1b04838474bcd57212f80f791d0e268a00d347e3`。本分支只增加审查材料，**新增确认 0 项，保留候选 2 项**。

## 首跑结果与跳过

[diff fixture](evidence/tui-diff-display.test.tsx) 的第一条 guarded 命令在测试导入前失败：从本目录下 `evidence/` 到仓库根的相对路径多了一层，无法找到 `DiffLine.js`。原始 [stdout/stderr](evidence/tui-diff-display.first.log) 与 [argv/exit](evidence/tui-diff-display.first.exit.json) 已保留：exit 1、0 pass、1 fail、1 error，没有 Completed 收据。该失败来自本次 fixture，不是产品缺陷。未修路径、未重跑、未换方法验证 Diff 展示；以下两项均没有动态证据，不能计入确认总数。

独立的消息 store / 失败流撤销 / slice anchor / memo comparator 既有 baseline 使用实际源文件完成：5 files、27 pass、264 expect、0 fail、0 skip、Completed。见 [raw log](evidence/tui-store-anchor-baseline.first.log) 与 [argv/exit](evidence/tui-store-anchor-baseline.first.exit.json)。这些是现有测试，不是 27 个新复现；它们不验证下面两个 Diff 候选，也不证明真实终端交互或整个虚拟滚动算法无缺陷。

## 候选 TUI-C1：原生 unified diff 普通正文行未被识别为增删行

- 源码：[DiffLine.tsx:100](../../packages/tui/src/ui/components/DiffLine.tsx#L100)，正则在 102、105 行只接受 `+` / `-` 后接空白。`+const value = 2;`、`-const value = 1;`、单独 `+` / `-` 因此从 111 行走 context 分支；源码中有缩进的 `+  const …` 则符合正则。普通 unified diff 的标记后可以直接跟第一列源码，候选期望是在已知 diff 正文上下文中保留这类行的增删样式。
- 普通显示链路：[ToolCall.tsx:389](../../packages/tui/src/ui/components/ToolCall.tsx#L389) 在工具输出逐行调用同一分类器，context 分支保留文字而不使用红绿 DiffLine。该组件文件注释明确包含 `git diff` 输出；`app-helpers.tsx` 的 `renderEntry` 实际把 tool_result 传给 `ToolCallResult`。[DiffView.tsx:43](../../packages/tui/src/ui/components/DiffView.tsx#L43) 也使用该函数，不过本轮没有证实当前主界面直接挂载 DiffView，不将它单独算入口。
- 预期影响仅为增删行的视觉分类不一致，文字仍保留；未运行 Bash / git diff / CLI / 完整组件渲染。`+x` 作为普通输出时应保持原样的意图已在源码注释写明，真实修复需区分 compact Edit 格式、普通输出和 unified hunk 上下文，不能简单全局放宽正则。
- 与上一轮 Desktop `parseUnifiedDiff` 的 hunk 状态和 quoted-path 缺陷属于不同实现、不同映射边界。未找到同根因旧确认项；当前仍是 fixture 失败后跳过的 source-only 候选。

## 候选 TUI-C2：Diff 颜色带按 UTF-16 长度补空格，中文会超出列宽

- 源码：[DiffLine.tsx:45](../../packages/tui/src/ui/components/DiffLine.tsx#L45)，48–49 行使用 `s.length` 而非终端显示宽度计算补位；54 行 gutter 也使用 `.length`。候选触发条件是增删行含 CJK 宽字符，实际文字本来能放进指定列数，但按字符数补位后宽度超过列数。
- 仅作静态算例：列数 80、无 gutter、正文 20 个 `中` 时，标记与正文的 UTF-16 长度是 22，算法补 58 个空格；按 CJK 两列计算总宽度会是 100 列。ASCII 20 字符的同类算例会正好 80 列。这里是从源码计算出的预期结果，**没有运行成功的宽度测量或 renderer 输出**。
- [ToolCall.tsx:391](../../packages/tui/src/ui/components/ToolCall.tsx#L391) 把带 gutter 的增删行传给该组件；StructuredDiff 和 PermissionPrompt 的直接增删行也使用它。未运行审批流程。候选影响是颜色带或文本额外换行、占用比正文所需更多的显示行；不声称丢失正文、实际屏幕损坏、性能回归或安全影响。
- 历史 CodeBlock 边框宽度问题和 render-border ANSI 截断问题不是本候选的同一根因；未找到 DiffLine CJK 补位旧确认项。本方向按首跑失败规则跳过。

## 阅读与去重边界

完整阅读了 DiffLine、DiffView、StructuredDiff、CodeBlock、ToolCall、MessageRow、ChatStore、slice-anchor、ui/truncate、render/wrap-text、render/measure-text、app-helpers、model-display、AgentBlock、AgentDock、useSessionUsage、useCostSummary，以及本次运行的五份既有测试。VirtualMessageList 阅读至 240 行，useVirtualScroll、render/stringWidth 和 render/index 的输出有截断，只按选择性阅读记录；没有把截断输出记成完整阅读。MessageContent 本轮只读既有测试，已确认的 fenced-table / escaped-pipe 问题不重复计数。

去重扫描语法解析了 398 份 JSON、按行扫描 993 份 Markdown，JSON 解析失败 0；范围为仓库 docs / reviews / archive / _archive 路径，含历史嵌套目录。扫描只支持查重，不等于逐份历史报告全文审查。函数名/路径匹配收据见 [tui-dedup-scan.json](evidence/tui-dedup-scan.json)，Diff 语义补充检索见 [tui-dedup-diff-semantic.json](evidence/tui-dedup-diff-semantic.json)。后者扫描时包含前者这一份新收据，已在命中中原样标明，未把自命中当历史问题。

已知已修项（MessageContent 的宽度缓存、VirtualMessageList 的 scroll-away 通知、tool_result 的 compact 透传、store listener 隔离）保持去重。未执行真实 PTY / 终端 / CLI / 模型 / 原生应用 / 进程或剪贴板操作，没有读取操作人的会话数据，没有构建 dist 或依赖。一般的 memo / slice / store baseline 通过不能外推全部渲染器、Unicode 或滚动交互覆盖。
