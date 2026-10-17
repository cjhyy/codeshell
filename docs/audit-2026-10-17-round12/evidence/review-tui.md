# 第十二批 TUI 只读交叉复核

结论：保留 **TUI-R12-01 / P3**、**TUI-R12-02 / P3**，保留 **TUI-R12-C1 候选**。没有发现需要新增产品实验或升级端到端结论的依据。本复核新增测试 **0**、重跑 **0**、产品/Git 修改 **0**；只写本复核文件。

读取的报告是 `tui-input.md`（并非预先提到的 tui.md），已核对两组 fixture、raw combined log、first-exit JSON、findings/candidates/validation/source-manifest/dedup/official-sources 记录，以及实际 parse-keypress、InputEvent、KeyboardEvent、use-input、TextInput、App、Ink dispatcher、Button、termio Parser/OSC、stringWidth、layout 常量和 Core intl 纯 utility 的相关源码。

## 大写文本合同与普通消费

`parse-keypress.ts:539` 将传入的 ASCII 字符码转为小写名称；InputEvent 的 modifyOtherKeys 分支把 name 用作 input。首次 fixture 中合法 `ESC[27;2;65~` 实际到达 `input=a, shift=true, ctrl=false`，raw A 对照保留 A；Alt+Shift 的独立输入也保留 modifier 但丢大小写。TextInput:205 的普通字符分支仅排除 ctrl/meta，不排除 shift；use-input 的回调直接交付 event.input。因此 Shift+A 这一例有正常文本消费链，Alt+Shift 例只作为独立转换观测，不冒充常规插入。

只读浏览重新核对官方合同：[xterm modified-keys 的 How It Works](https://invisible-island.net/xterm/modified-keys.html) 说明 Shift 的 case conversion 发生在 XKB/LookupString 层，modifyOtherKeys 使用其返回 keysym；[xterm Control Sequences 的 Alt and Meta Keys](https://invisible-island.net/xterm/ctlseqs/ctlseqs.html) 定义字符码字段及 level 2 modifier 编码。这足以支持 fixture 的 xterm 字符编码语义；实际终端发送覆盖仍未验证。

[Kitty keyboard protocol](https://sw.kovidgoyal.net/kitty/keyboard-protocol/) 明确其主键码是 unshifted 版本，报告已排除从 Kitty Shift+小写主码直接推断大写文本缺陷。不能用只读协议文档或本纯函数 fixture 声称实际 Kitty/WezTerm/tmux/Windows Terminal 都发生同一输入现象。现有 Ctrl+Shift 快捷键名称归一化合同亦不能取消非 Ctrl 的字符合同。

## KeyboardEvent 字面 key 与下游边界

keyboard-event.ts:7–10 直接声明 printable key 应为字面字符，且单字符检查适用。构造器 fallback 返回 `name || sequence`。首次 fixture 验证两种编码 Alt+Space 返回五字符 name，传统 ESC 前缀 Alt+z 返回含 ESC 的 sequence；对应 InputEvent 正常对照已还原空格和 z。它和上一项的大写名称转换是不同错误分支。

实际源码 App:514 把同一 ParsedKey 交给 keyboard dispatcher，Ink:1519 由其构造 KeyboardEvent，Button:96 的条件读取字面空格。报告仅将 Button 影响写为静态推导，未声称已执行 Button 激活、dispatcher、focus、Ink 或真实按键。纯 constructor 结果已直接违反 event 自身合同，所以维持限定 P3 合理。

## 宽度候选与首跑前隔离

第二 fixture 在 dynamic import Parser/stringWidth/lineWidth **之前** 注册 Core barrel mock。静态预先导入的 Core intl.ts 是无外部 import 的实际 utility；tokenizer 和 getMaxWidth 的静态路径不会提前引入 Core barrel，getMaxWidth 的 layout/node.ts 是常量/类型适配层。Parser 的 OSC import 走已注册 mock：real getGraphemeSegmenter、固定 env 和 throwing execFileNoThrow stub。七个相关测试都检查 nativeCalls 为零，原始日志无失败。该计数直接证明这个 OSC exec boundary 未调用，不能扩大成无 mock 或 Core 整包验证。

Parser 输出分解重音 width=2、stringWidth=1 和 NFC 正常对照都来自真实纯函数；唯一现有生产 Parser 消费处 Ansi.tsx:134 只拼 value，不读取 width。未建立产品布局影响时保留候选合适，不应提升正式 finding。

## 材料与计数

两个 first-exit JSON 的完整命令均为 guarded runner，exitCode=0。raw log 分别有 7 pass / 121 expect 和 7 pass / 165 expect，并各有 `Completed Bun shard: 7 tests, 0 skipped; 0 failures.`。合计 **14 pass / 286 expect / 0 fail / 0 skip**，共享第一组的两项 finding 不重复累计。

metadata 校验核对 source manifest 的 32 个路径：冻结 Git blob SHA-256 与记录相符，当前字节也与冻结 blob 相同。该校验只读 Git 对象，不运行产品。最终 dedup 清单包含 1725 个 docs/bugs MD/JSON/TXT，hits 带 nested JSON location，含 archive/_archive；初始范围不足已披露并扩展。关键词查重不能证明语义穷尽，但当前公开记录未见本次两个实现分支的同根因历史项。

## 本复核的导航诊断

本复核一次组合静态读取中，前面的报告/源码读取正常；我误猜 `packages/tui/src/render/parse-keypress.test.ts` 的测试路径，rg 首次响应如下（**tool-response transcription**，不是 raw subprocess log）：

```text
rg: packages/tui/src/render/parse-keypress.test.ts: IO error for operation on packages/tui/src/render/parse-keypress.test.ts: No such file or directory (os error 2)
```

该工具整体 exit=1；随后 inventory 的 test 名过滤也没有匹配。这个猜测路径方向跳过，没有运行该路径、修复 fixture 或另找替代测试恢复验证。上述审查只依赖实际 fixture/log、源码和正式协议，不把缺失文件当作产品失败。没有新增或重跑 Bun 实验。

## 所读首次材料 SHA-256

- `tui-key-events.test.ts`: `9222c2f41ffe17dd439b170fa06a7f286a12e6b87d86f5e2aff7b057248206fd`
- `tui-key-events.first.log`: `267089e86d88b08d4ce85f426cf1a6185484ff9f5fd895fede9862ed306d92c1`
- `tui-key-events.first-exit.json`: `a42bc8cbee915acc707e46c49b2138725aa8bcac6ac3657e26e034e51e09167c`
- `tui-text-data.test.ts`: `b9b217c23c3609c5f9d8f2eaea82d878006f4dd5f98fb7e0fbedefdf49dd1f60`
- `tui-text-data.first.log`: `5769d685e360e7b434d684b268c8ec24d337b183f360606750faf644a066ab95`
- `tui-text-data.first-exit.json`: `e5883013d5d3a78de9302c2209ab2acd3203cc339d8deebf895a674d6199bf4f`
