# Core 普通工具函数审查（第十四批）

冻结源码：`badc2262a90966f6f903977b849adf1f22b55e9f`。**0 项新增正式 bug，2 项静态候选，1 项旧问题关联。** 本轮只审查普通字符串、显示格式和内存缓存语义；产品文件未改。

## 首次验证与跳过

现有 [format.test.ts](../../packages/core/src/utils/format.test.ts) 独立首跑 **6 pass / 6 expect / 0 fail / 0 skipped**，guarded runner 完整通过。[原始日志](evidence/utils-format-existing.first.raw.log)、[退出与 SHA 收据](evidence/utils-format-existing.first.exit.json)。它只验证现有 0–1500ms 的 sub-second duration 案例，不代表全部格式器或全仓通过。

Slice fixture **首次加载失败：0 pass / 1 fail / 1 error，exit 1**。我把 fixture 的相对 import 多写了一层，Bun 找不到目标路径，生产 Slice 模块和任何测试体都未加载/执行。[原始日志](evidence/utils-slice-columns.first.raw.log)、[退出收据](evidence/utils-slice-columns.first.exit.json) 保留首次字节，整个 Slice 动态方向立即 SKIP，没有修 fixture、重跑、换入口或替代验证。[停止说明](evidence/utils-skip-note.md) 区分审查错误和产品问题。

另一份 [cache/semver/toolDisplay fixture](evidence/utils-cache-format-controls.test.ts) 从未执行，保留了同样的错误相对 import，既未修正也未运行；不能把其中断言或预期当成观察结果。两份自写 fixture 都不是回归通过证据。

## UTIL-R14-C1 — display-column 合同和 UTF-16 索引不一致（候选）

[Slice 头部](../../packages/core/src/utils/sliceAnsi.ts#L2) 说按显示列截取；[25 行](../../packages/core/src/utils/sliceAnsi.ts#L25) 无 ANSI 分支却直接 `text.slice(start, end)`，[37 行](../../packages/core/src/utils/sliceAnsi.ts#L37) 有 ANSI 分支也按单个 UTF-16 code unit 增加 `visIdx`。

普通调用方 [wrap-text.ts:23](../../packages/tui/src/render/wrap-text.ts#L23) 先用 `stringWidth` 计算总显示宽度，truncate-start/middle 的起止位置来自列数；[output.ts:431](../../packages/tui/src/render/output.ts#L431) 水平裁剪同样按 x/显示宽度传入边界。这是源码追踪，未加载 TUI。对普通字符串 `中文XYZ`，按两汉字占四列的调用合同应在 `[4, 7)` 保留 `XYZ`；依据源码静态推演，直接 slice 只保留 `Z`。调用方的“结果太宽则收紧 end 一列”不会修正这个被偏移的 start。

**不定级、不列正式。** 首次测试未加载生产模块，以上为静态推演；头部还明确承认 wide characters 的 full fidelity 有限，不能把这一描述省略为完整保证。没有屏幕、实际裁剪/截断输出或终端行为证据。fixture 内的 `Bun.stringWidth` 断言从未执行。

## UTIL-R14-C2 — 最后可见字符后立即 break，尾部 reset 不进入结果（候选）

[67 行](../../packages/core/src/utils/sliceAnsi.ts#L67) 在 `visIdx >= finalEnd` 时退出整个循环，因此即便 `start=0`、省略 end、输入为普通基础 SGR `ESC[31mXYZESC[39m`，静态推演的结果也没有末尾 `ESC[39m`。这里不是复杂未知 ANSI 序列；自己的 regex 已识别该样式，helper 说明还称保留 escape sequences。

**不定级、不列正式。** 同一首次 fixture 加载失败使测试体没有运行；未证明实际跨节点/终端样式泄漏，消费者的 parser 实例边界可能约束影响。不能从源码尾部 reset 缺失直接升级为全局 UI 污染。

## 旧问题关联与不新增的方向

- `UTIL-R14-R1`：Core [toolDisplay.ts:114](../../packages/core/src/utils/toolDisplay.ts#L114) 的摘要仍按 UTF-16 `.slice(0, max - 1)` 截断，机制与已登记 `DESKTOP-R12-01` 相同。正常 60/88 上限可用于 Unicode 命令/描述/文件名，但本轮对应 fixture 未执行，仅记静态关联，不重复增加 formal；当前 Desktop 的独立修复不能证明这个 Core helper 已修复。
- Read compact summary 用 `content.length` 配 `B/KB` 单位，与旧 Desktop 字节标签候选相近；没有新实际调用输出或计量合同，不重复新增候选。
- `formatDuration` 的旧 [1,1000)ms→`0s` 案例已经有修复和现有测试，本轮基线再次通过，不重复登记。`formatResetTime(showTime=false)` 的短时间分支及 relative-time style 边界没有找到当前普通消费者，未以孤立 API 输入增加问题。
- `semver` 只是 maintained dependency 的 gt/gte/lt 薄封装；`memoize` 在当前同步 scanOnce 调用形状下用 `Map.has` 正确区分 undefined 命中，并且 `.cache.clear()` 有真实静态消费者。未验证真实扫描或用户目录，没有制造无实际消费者的 `this`、rejected Promise、替换 `.cache` 等合同。

## 去重和覆盖限制

全历史扫描 **1088 个 MD + 680 个 JSON = 1768 文件**（`docs` 与 `bugs` 的全部递归库存，含 `archive/_archive`，排除本批），解析 **260285 个 JSON 叶子，0 解析错误**；文件字节/SHA 与命中叶子保存在 [utils-dedup.json](evidence/utils-dedup.json)。进一步比对 [Slice/ANSI](evidence/utils-slice-dedup.json) 和 [列宽/裁剪](evidence/utils-width-dedup.json)。旧 `render-border` 确认项是直接 substring 分割 ANSI codes；当前调用已用 Slice，和这里的 helper UTF-16 索引/尾 reset 推演不是同一代码根因。查重没有把只有文件库存的命中误当旧 bug。

静态阅读了五个目标 helper、format/intl、两个同步缓存消费者及 TUI 中相关普通显示接线；没有完整执行它们。实际动态只执行现有 formatDuration 基线；intl 仅静态阅读/依赖范围，不独立验证。自写 Slice 首次加载失败，其他自写 fixture 未执行。无 Core barrel、Ink/TTY/PTY、应用、模型、网络、真实工具调用、权限流程、用户 home、插件扫描、磁盘 patch 或 native process 测试；没有恢复历史失败方向。

[源码 SHA 清单](evidence/utils-source-manifest.json)、[验证汇总](evidence/utils-validation.json)、[材料收据](evidence/utils-artifact-receipt.json) 给出实际/静态边界。源码清单 SHA 来自冻结 Git blob，当前相等仅是选定文件核对，不代表全仓动态审查通过。
