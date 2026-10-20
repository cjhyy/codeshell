# Round8：Questions lane 只读交叉复核

审查冻结源 `ec0e16bf0068a458abcbaa28225a4c764c24f4de`。检查 Plugins 三项 P3 与 Root Git 一项 P3 的报告、实际生产源码、fixture、首次原始日志和 receipt；没有新增、修复或重跑测试，也没有调用产品 Git、插件 add/install、原生 UI、模型或网络。

结论：**保留四项 P3，未发现需要降为候选或重复删除的实质问题**。以下证据边界已在报告中限定，应在总报告中保留。

- **PLUGIN-R8-01 保留**：实际 tokenizer 在 `pluginCommandsLoader.ts:230` 丢弃 current 为空的 token，虽然前面已消费完整的引号对。`"" next last` 和 `left '' right` 两例都由真实 expander 得到位置左移；非空引号、命名空值和原始 `$ARGUMENTS` 是有意义的控制。现有 `pluginCommandsLoader.expand.test.ts` 要求 quoted positional/named expansion，模块也明确 `$1`…`$9` 语法；将显式空引号解释成一个位置参数是该支持语法的合理推断，报告已标为推断，没有声称验证了上游 Codex 实现。Converter 证据只覆盖自有目录的真实复制→展开，不等于完整安装/宿主调用。
- **PLUGIN-R8-02 保留**：placeholder regex 的 `$ARGUMENTS` 分支在完整命名 token 之前且没有边界，直接解释了 `$ARGUMENTS_FILE` / `$ARGUMENTS_UNKNOWN` 两个结果。命名赋值和命名占位都接受大写加下划线，现有测试要求未知 token 保留，故不需额外外部兼容合同。已合并成单一根因，没有把已知名与未知名各计一项。
- **PLUGIN-R8-03 保留**：parser 显式接受 drive-prefixed slash/backslash 路径；deriver 按 `/` 与 `:` 切分，实际 name 包含反斜杠。fixture 调用实际同名 guard，且 `marketplaceDir` 确实第一步调用它；TUI/Desktop caller 静态上未覆盖 name。Forward slash/POSIX/GitHub/HTTPS 是正常控制。结论限于纯字符串链上的确定拒绝，没有运行 Windows 文件系统或真正 addMarketplace/clone。
- **GIT-R8-01 保留**：`getWorktreeDiff` 公开合同要求 unique files changed，实际 union 将 committed 的外层引号路径和 dirty 的去引号路径当成不同身份。内存 `gitOutput` 只提供输入，未绕开 union/解析；ASCII 同文件为 1、引用路径同文件为 2、两个普通文件为 2 的控制可以区分正常合并计数与本缺陷。4 项测试 / 12 assertions、Completed、exit0 与原始日志一致；child_process throwing guard 的调用计数均为 0。Git 格式依据来自报告所列官方文档，本交叉复核没有另行抓取真实 Git 输出。影响仅限摘要多计，不能扩大为已验证的 Desktop UI、删除判断或原生 worktree 行为。

去重复核：A03 是另一 Git status parser 首行 trim 的路径截断；A04 是 log subject 竖线分字段。R2-08 是外部 CLI changedFiles collection，R2-11 是 Desktop Review `parseUnifiedDiff` 路径定位。这些独立消费者的旧修复不会统一本 `getWorktreeDiff` 两个集合的身份空间；本项可以单独记录。本次未重复运行任何旧 fixture。

源码核对的七个核心文件字节均与冻结 Git blob 相等：command loader、marketplace parser、installer paths、marketplace manager、Codex command converter、worktree diff 与 query。Plugins 两个首次 raw log 和 fixture 的 SHA256 与 `plugins-validation.json` 相符，6+5 pass / 13+27 assertions / 0 fail / Completed；Root 首次 raw log 为 4 pass / 12 assertions / 0 fail / Completed。未验证全包 suite/build/typecheck/lint。

本 lane 的两个失败 UI fixture 保持 SKIP：Mobile 的 additive hints 合同允许宿主忽略字段、且其首次运行在 React DOM 导入即失败；TUI 的 flushed control 也失败，无法证明 batch 特异性。它们没有因本次交叉复核被升格确认，也没有被变相补跑。
