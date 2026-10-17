# TUI tab expansion：第十六批

冻结：`ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f`。新增正式缺陷 **0**，候选 **2**，新增旧问题关联计数 **0**。只记录，没有修改产品代码。

首次 guarded shard **9 pass / 27 expect / 0 fail / 0 skip**，全部为本次 focused 刻画及对照，其中 7 项常规对照、2 项候选刻画。通过包含当前不一致行为的断言，不表示已经修复。[fixture](evidence/tabstops-pure.test.ts)、[首次原始 combined stdout/stderr](evidence/tabstops-pure.first.raw.log)、[首次退出收据](evidence/tabstops-pure.first.exit.json)、[验证范围](evidence/tabstops-validation.json)。原始输出与 exit 收据落盘后才读取；无重跑。

## TAB-R16-C1：测量列起点与屏幕制表位起点不同，存在低估边界

实际 [expandTabs:22](../../packages/tui/src/render/tabstops.ts#L22) 从 `column = 0` 累积相对文本列，[31](../../packages/tui/src/render/tabstops.ts#L31) 将 tab 展开到下一个 8 列边界。实际纯函数对 `aaaaaaa\tX` 得到 `aaaaaaa X`，真实 Bun `stringWidth` 测得 **9**。

普通消费者 [dom.ts:345](../../packages/tui/src/render/dom.ts#L345) 获取节点文本，[350](../../packages/tui/src/render/dom.ts#L350) 用此展开串测量；该文件注释称作 worst case，但实际不是每个 tab 一律 8 个空格。屏幕输出路径 [output.ts:670](../../packages/tui/src/render/output.ts#L670) 从绝对 `x` 起步，[683](../../packages/tui/src/render/output.ts#L683) 根据 `offsetX % 8` 展开。**这里只静态读了输出代码**：若同一文本从屏幕列 5 开始，则 7 字母后位于列 12，tab 加 4 空格，尾部 `X` 后相对宽度为 **12**。首次 fixture 中的 12 是这段静态算式的独立整数计算，没有调用真实 writer。

[CodeBlock.tsx:29](../../packages/tui/src/ui/components/CodeBlock.tsx#L29) 具有左 margin，[41](../../packages/tui/src/ui/components/CodeBlock.tsx#L41) 在代码文本前放置前缀，[42](../../packages/tui/src/ui/components/CodeBlock.tsx#L42) 保留代码行本身，因而存在普通 tab 文本和非零起点的静态生产路径；本次没有运行 cli-highlight、React、Yoga、DOM、屏幕 buffer 或真实终端，未证实最终布局是否裁剪、溢出或被其他约束纠正。保留候选，无严重性评级。

对照覆盖起点 0 的默认 tab、整 8 列边界、相邻 tab、换行复位和正数自定义间隔。唯一现有 `expandTabs` 产品调用使用默认间隔；不把手传 0/NaN/负数等无普通调用证据的输入算作缺陷。

## TAB-R16-C2：SGR 切开 ZWJ 字素时，逐 token 列宽加和改变 tab 空格数

[tabstops.ts:24](../../packages/tui/src/render/tabstops.ts#L24) 遍历 tokenizer 输出，[25](../../packages/tui/src/render/tabstops.ts#L25) 保留 escape sequence 而不加列宽，[39](../../packages/tui/src/render/tabstops.ts#L39) 单独测每段文本。手造合法完整 SGR `👩 + red + ZWJ💻 + reset + tab + Z` 时，两个文本片段各被真实 Bun 测为 2，累计为 4，所以 tab 加 **4** 空格；无 SGR 的 `👩‍💻 + tab + Z` 将整个字素测为 2，tab 加 **6** 空格。真实 Bun 对完整带 SGR 的 emoji 前缀仍测为 **2**，因此带样式展开行的实际显示宽度为 **7**，无样式展开行为 9。

动态证据限于真实 `expandTabs`、其真实 tokenizer、真实 Bun `stringWidth`。没有执行普通 markdown/语法高亮 producer 来证明会在同一个 ZWJ 字素内部放置 SGR，也没有执行终端来判断该边界是否仍呈现为同一合成 glyph，故保留候选。对照中的 ASCII SGR 边界、完整 OSC 8 hyperlink、无样式中文和分解重音 tab 均正常；本次未执行 JS fallback。

与 round12 的 ANSI Parser 组合重音 `width` metadata 候选区分：本项实际调用 `expandTabs/stringWidth`，没有调用 Parser，也没有借用该旧候选证明本项消费者影响。round14 已失败的 `sliceAnsi` 方向保持跳过，本次不导入、不验证。

## 范围、查重与证据边界

首次 fixture 在产品 import 前将 `@cjhyy/code-shell-core/internal` barrel 隔离，仅暴露真实 [utils/intl.ts:13](../../packages/core/src/utils/intl.ts#L13) 的 `getGraphemeSegmenter`；Core barrel 自身、Engine、用户配置均未加载。`stringWidth` 的真实 Bun 快路 [stringWidth.ts:221](../../packages/tui/src/render/stringWidth.ts#L221) 保持不变。本次未替换产品宽度函数。OSC 8 URL 只是内存字符串，没有网络请求或打开链接。没有 native/TTY/真实账号、模型、付费调用、安装、重建 dist、广域测试或 UI 集成声明。

[历史查重脚本](evidence/tabstops-dedup.py) 扫描所有先前 `docs/bugs` 的 Markdown 和递归解析的 JSON，含 archive/_archive，排除本批：**1119 MD + 763 JSON = 1882 文件，222452 JSON 字符串叶子，309912 全标量叶子，0 解析错误**。匹配 direct sources 6、tab/测量边界 5、ANSI/字素 14；最多每类保存 180 段上下文，计数与上下文上限区分。读取相关上下文后，没有发现同一 tab 起点/逐 token ZWJ 机制的旧 bug；这不是全语义无重复证明。[完整索引与上下文](evidence/tabstops-dedup.json)。

两次元数据导航错误（不存在的 Core intl 猜测路径、未展开的 Markdown shell glob）保留首响应并跳过，详见 [navigation skip](evidence/tabstops-navigation-skip.md)。它们没有执行产品，不是 Bun/import 失败，实际库存文件随后独立读取。另一次 metadata collector 在创建自身 receipt 前检查到该链接不存在，首失败保留在同一 note；仅纠正收据生成顺序。本次动态方向无失败。

实际库存文件及 frozen Git/current SHA 和逐项覆盖见 [源码清单](evidence/tabstops-source-manifest.json)。纯函数源码完整读取并执行；DOM、输出和 producer 仅精确选段静态读取。预先只核对实际文件与冻结 Git bytes，见 [metadata preflight](evidence/tabstops-preflight.json)，没有猜测 node_modules 或运行依赖 resolver。候选及机器收据见 [candidates](evidence/tabstops-candidates.json)、[findings](evidence/tabstops-findings.json)、[artifact receipt](evidence/tabstops-artifact-receipt.json)。
