# 第十六批：普通粘贴任务的噪声分类

冻结源码 `ac314bf73e99399b72ec0aa7c8ce9d5c3ab4bc2f`。**0 项新增正式 bug，2 项候选，0 项旧问题关联计数。** 实际只运行依赖为空的 `detectPastedNoise` 纯函数；Engine、终端渲染和剪贴板均仅静态阅读。

首次 guarded shard **17 pass / 27 expect / 0 fail / 0 skipped**，全部为本次新增的 characterization，包含对当前有疑点行为的断言，不能称为修复或回归通过。[fixture](evidence/tasknoise-pure.test.ts)、[首次完整合并 raw 输出](evidence/tasknoise-pure.first.raw.log)、[首次退出收据](evidence/tasknoise-pure.first.exit.json) 已先保存再检查。没有重跑、修复测试或替代验证。

## TASKNOISE-R16-C1：项目定义的 dashed 框线仍全部被当作 signal

[task-sanitizer.ts:2](../../packages/core/src/utils/task-sanitizer.ts#L2) 的 BOX_RE 包含 `─` / `│`，但没有本项目 [render-border.ts:17](../../packages/tui/src/render/render-border.ts#L17) 定义的 dashed 边框 `╌` / `╎`。真实 helper 对 140 个 `─` / `│` 的两个对照均返回 `isNoise=true`；对 140 个 `╌` / `╎` 均返回 false，横向 dashed 的 `cleaned` 完整保留。不是 Unicode surrogate 或显示宽度问题，而是允许清单差异。

归为候选：存档 [utils 说明](../../docs/archive/core-modules/utils.md#L18) 只概括为识别 ANSI/box-drawing-heavy 粘贴输入，没有承诺穷尽所有框线。已证明当前 renderer **定义并支持**这些样式，未找到实际 UI 中选择该 dashed 样式的普通调用；未运行 renderer，也未证明其输出通过哪条剪贴板/Host 输入链到达 Engine。不能把手工构造的重字符 fixture 作为真实用户误启动任务的证明。

## TASKNOISE-R16-C2：colon SGR 和 OSC 不参与噪声剥离

[task-sanitizer.ts:1](../../packages/core/src/utils/task-sanitizer.ts#L1) 只匹配 `ESC[` 后的数字、分号、问号与字母末尾。真实 helper 对重复的基础 `ESC[31m` / reset 和分号 RGB `ESC[38;2;1;2;3m` 仅控制串返回 noise；相同类别的冒号 RGB `ESC[38:2::1:2:3m` 仅控制串，以及 OSC8 开启/关闭 hyperlink 的仅控制串，均完整保留并返回 `isNoise=false`。

本项目 [SGR parser 头部](../../packages/tui/src/render/termio/sgr.ts#L1) 明确支持分号和冒号；[OSC link producer](../../packages/tui/src/render/termio/osc.ts#L408) 实际生成该类 OSC 序列。这是独立静态合同背景；测试没有导入 SGR/OSC 模块，没有调用 clipboard/native helper。OSC URL 使用 `example.invalid` 仅作内存字符串，没有网络请求。

归为候选：未证明普通输入传输会保留这些原始控制序列，也没有要求噪声 heuristic 支持全部 terminal 协议的严格合同。TUI [TextInput 的普通粘贴分支](../../packages/tui/src/ui/components/TextInput.tsx#L205) 会扫除 ESC 等控制字节，因此不能把直接 helper fixture 宣称为实际 TUI 路径复现，更不能声称终端控制执行、会话创建或模型请求发生。

## CR/LF、cleaned 消费与阈值控制

真实 helper 的 [CR 替换](../../packages/core/src/utils/task-sanitizer.ts#L17) 将 CRLF 变成双 LF；CR-only 变成单 LF，测试保留原字符串不变。但 [Engine:1684](../../packages/core/src/engine/engine.ts#L1684) 只用 `isNoise` 拒绝任务，在拒绝提示中截取 `cleaned`；正常分支 [1725 行](../../packages/core/src/engine/engine.ts#L1725) 继续向消息构造传入原有 `taskText`。因此本轮不把 helper cleaned 的 CRLF/ANSI/框线投影变化报告成正常用户任务被篡改。`run-image-input.ts` 的提取/附件链只静态读，没有调用真实文件读取或图片处理。

`original < 10` 的短输入 bypass、原长 100 与 101、30% 和低于 30%、普通 prose/已识别 ANSI 包装、solid 框线对照均按当前源码通过。包含明确“请解释以下终端输出”的少量文字加 140 个 solid 框线，helper 仍触发低 signal heuristic；这是可重复的策略边界，但在缺乏明确误判判据时没有另增候选或 formal。

## 查重、范围与限制

递归 prior `docs` / `bugs` 全部 MD/JSON，含 archive/_archive、排除本批：**1119 Markdown + 763 parsed JSON = 1882 文件，222452 JSON 字符串叶、309912 scalar 叶，0 解析错误**。[查重记录](evidence/tasknoise-dedup.json) 中 keyword 计数是 helper 36、paste/ANSI 8、CRLF 25，摘录各最多 12 条；计数不是摘录条数，也不是语义穷尽证明。进一步人工对照第十二批 TUI event/parser-width 和第十四批 Slice column/reset 记录，均为不同根因，本轮不恢复旧 Slice 首次失败动态方向。

[源码 manifest](evidence/tasknoise-source-manifest.json) pin 14 个源码/合同/runner 文件，区分 full/selected static、唯一实际 helper 执行以及 runner 仅执行。manifest 相等仅表示选定冻结字节相同。没有 Core barrel、Engine、React/Ink、真实终端/PTY、剪贴板、native process、网络、模型、用户 home/data、权限/安全流程、构建/typecheck/lint 或完整套件验证。

两次只读 metadata 错误（查询 regex 转义；猜错未使用的 Core entry 路径）保留为 [首个工具响应转录](evidence/tasknoise-navigation-skip.md)，对应猜测引用 SKIP；不是 Bun/产品失败。测试使用首次前 [已核验绝对源码 import](evidence/tasknoise-preflight.json)，无 resolver 或猜测根 node_modules 预检。

机器记录：[findings](evidence/tasknoise-findings.json)、[candidates](evidence/tasknoise-candidates.json)、[validation](evidence/tasknoise-validation.json)、[材料 SHA 收据](evidence/tasknoise-artifact-receipt.json)。
