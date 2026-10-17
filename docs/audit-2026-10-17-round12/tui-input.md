# 第十二批：TUI 纯输入与文本数据

冻结源码 `d5fae44358b3a92d4d02fd5fcc4ac21c56b2a08a`。本方向 **2 项 P3 正式发现，1 项候选**。两个首次 guarded shard 均完成：**14 pass / 286 expect / 0 fail / 0 skip**。这些是特征化断言（包括断言当前错误行为），没有修改产品或修复 bug。

## TUI-R12-01 / P3：modifyOtherKeys 将非 Ctrl 大写文本降为小写

- 根因：[parse-keypress.ts:539](../../packages/tui/src/render/parse-keypress.ts#L539) 将所有可打印 ASCII 码转换为小写名称；[InputEvent:133](../../packages/tui/src/render/events/input-event.ts#L133) 的 modifyOtherKeys 分支直接将这个名称作为文本。
- 正常输入：`ESC[27;2;65~` 是带 Shift 的字符码 65（`A`），真实 `parseMultipleKeypresses → InputEvent` 输出 `input="a"`，`shift=true`、`ctrl=false`。独立例 `ESC[27;4;81~` 输出 `q` 且 Shift/Alt 位正确。
- 预期依据：[xterm 官方协议](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) 定义该格式的第三项为字符码，level 2 编码修饰键；[官方说明](https://invisible-island.net/xterm/modified-keys.html) 解释字符的十进制值。这里采用 xterm 的字符码语义，**没有把 Kitty 的 unshifted key code 误当成大写文本**。[use-input.ts:20](../../packages/tui/src/render/hooks/use-input.ts#L20) 约定交付输入字符，[TextInput.tsx:205](../../packages/tui/src/ui/components/TextInput.tsx#L205) 会插入非 Ctrl/Alt input，因此首例常规输入的数据已经被改变。
- 控制：raw `A`/`a`、编码小写、`/`、空格均保留；现有 `tests/render-input.test.ts:76` 是 Ctrl+Shift 大写转小写快捷键名称的合同，不能作为非 Ctrl 文本转小写的依据。本次只静态读既有测试，未执行 Ink fixture。
- 证据：[纯 constructor fixture](evidence/tui-key-events.test.ts)、[首次原始输出](evidence/tui-key-events.first.log)、[首次退出记录](evidence/tui-key-events.first-exit.json)。实际到达 InputEvent；useInput/TextInput 插入链仅静态追踪，没有声称实际界面输入或所有终端都会发送该格式。App 在 `supportsExtendedKeys()` 为 true 时写出 level 2 模式，见 [App.tsx:246](../../packages/tui/src/render/components/App.tsx#L246)；该 predicate 的终端名单见 `terminal.ts:155`，本次没有运行或更改终端环境。

## TUI-R12-02 / P3：KeyboardEvent 没有将编码 printable key 还原为字面字符

- 根因：[keyboard-event.ts:50](../../packages/tui/src/render/events/keyboard-event.ts#L50) 对非单字符 sequence 返回 `name || seq`。其 [第 7–10 行](../../packages/tui/src/render/events/keyboard-event.ts#L7) 明确要求可打印键为字面字符，且可用 `key.length === 1` 判断。
- 正常输入：Alt+Space 的 `ESC[27;3;32~` 和 `ESC[32;3u` 分别经真实解析器构造 KeyboardEvent，都返回 `key="space"`（长度 5）而非 U+0020。传统 ESC 前缀 Alt+z 返回 `key="ESCz"`。修饰位仍正常，对应 InputEvent 已返回正确的字面空格和 `z`。
- 预期依据同一源文件的明确合同；xterm 官方协议支持 ESC 前缀 Alt 及 modifyOtherKeys 字符编码，[Kitty 官方协议](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 定义 CSI-u codepoint 与独立 modifier。[App.tsx:514](../../packages/tui/src/render/components/App.tsx#L514) 静态交付 ParsedKey 给 DOM 键盘分派；[Button.tsx:96](../../packages/tui/src/render/components/Button.tsx#L96) 接受 `key === " "`。这里只确认 event 数据错误，Button 分支影响是静态推导，没有运行 dispatcher/Button。
- 控制：raw 空格、`z`、`3`、`/`、arrow、return、Ctrl+C 的 key/flags 正常。与第一项根因分离：本项编码空格的 InputEvent 对照已正确，错误发生在 KeyboardEvent 的 fallback。
- 证据共用上述 **7 pass / 121 expect** 的首次 shard，不重复累计。

## TUI-R12-C1：ANSI Parser 的组合重音宽度 metadata 不一致

[parser.ts:64](../../packages/tui/src/render/termio/parser.ts#L64) 将多个 codepoint 的 grapheme 一律计 2 列。实际 Parser 对 `e + U+0301` 给出一个 `width=2` grapheme，而真实 `stringWidth` 为 1；NFC `é` 的 Parser width=1。ASCII/CJK/emoji 对照一致。[types.ts:220](../../packages/tui/src/render/termio/types.ts#L220) 明确 width 表示显示列数。

保留候选：唯一生产 Parser 消费者 [Ansi.tsx:134](../../packages/tui/src/render/Ansi.tsx#L134) 仅拼 `grapheme.value`，没有读 width。本次未证明产品布局或渲染受影响，未运行 ANSI/Ink 渲染。[fixture](evidence/tui-text-data.test.ts)、[首次输出](evidence/tui-text-data.first.log)、[退出记录](evidence/tui-text-data.first-exit.json) 为 **7 pass / 165 expect**。

第二 shard 在首次测试前使用 `mock.module` 隔离 Core barrel：仅把 `getGraphemeSegmenter` 绑定到真实冻结的 `core/src/utils/intl.ts`，固定未使用的终端类型字段，将无关 OSC `execFileNoThrow` 绑定为抛错 stub。每个相关测试均断言调用计数为 0。**这不是无 mock 测试，也不验证 Core 整体或真实 OSC 操作。** Tokenizer 的 CSI/SS3/OSC/DCS 序列每个两块切点、SGR 跨块、cache 重复/驱逐和 content-width 算术也仅验证纯数据控制。

## 去重、范围与限制

初始按 audit/review/archive 路径名过滤了 1,234 个文件，保留于 [初始去重记录](evidence/tui-dedup.initial.json)；随后补全整个 `docs/` 与 `bugs/` 的 **1,725 个 MD/JSON/TXT**（当前 round12 排除），包含 archive/_archive 和嵌入 JSON，命中 95 处，完整清单、hash 与命中摘录见 [最终去重](evidence/tui-dedup.json)。旧 `splitNumericParams` 空参数记录在现行源码已映射为 0，本次未重复计入；旧 Ink meta/escape 兼容迁移 TODO 也没有被当作新 bug。

32 个源码/合同/runner 路径已冻结 pin，见 [source manifest](evidence/tui-source-manifest.json)；manifest 不是全文件执行覆盖声明。已有 render-input 测试只静态读取，未执行 TTY/PTY、React/Ink、App、真实键入、剪贴板、原生进程、网络、模型、用户文件、build/typecheck/lint 或完整套件。没有进入已失败的 Diff、Questions batched 或 i18n preflight 方向。

一个历史 metadata 示例文件的猜测路径不存在，首次可见 tool 诊断单独保留为 [带标签转录](evidence/tui-metadata-read-diagnostic.json)；wrapper 没有保留其退出码，因此不虚构 exit。这不是 Bun 测试失败，该引用方向跳过，未重跑或另找替代示例。本方向两个产品数据 shard 均仅运行一次。

机器汇总：[findings](evidence/tui-findings.json)、[candidates](evidence/tui-candidates.json)、[validation](evidence/tui-validation.json)、[协议来源](evidence/tui-official-sources.json)。
