# Review prompt：1 个 P3，2 个旧缺陷族相关项

冻结源码为 `5f5cf69df8526470700712a4dc2d5ae6bd2da132`。完整阅读 Coding 的纯 builder 和既有 9 个 tests；TUI `/review`、命令列表与输入提示只读必要消费片段。实际运行仅导入生产 `review-prompt.ts` 的 guarded shard，未执行 `/review`、Git 产品命令、client、模型或 TUI/React。

## REVIEWPROMPT-R19-01 [P3] `/review` 的用法提示给出不被 parser 识别的 `perf`

- 普通入口及合同：[git-commands.ts:136](../../packages/tui/src/cli/commands/builtin/git-commands.ts#L136) 的 usage 为 `/review [file] [--json] [--dimensions=security,perf,...] [--staged]`。同一 handler 在 [149](../../packages/tui/src/cli/commands/builtin/git-commands.ts#L149) 把 flag 值直接交给 `parseDimensions`，在 [170](../../packages/tui/src/cli/commands/builtin/git-commands.ts#L170) 把结果传给 builder。这里的预期是提示所列维度能选中性能，而非要求所有未知名字都获支持。
- 根因：生产 [parseDimensions:49](../../packages/coding/src/review/review-prompt.ts#L49) 只按 `ALL_DIMENSIONS` 的完整名匹配；[类型与列表:11](../../packages/coding/src/review/review-prompt.ts#L11) 只有 `performance`。未知项被丢弃，没有 `perf` 映射。
- 实际纯函数观测：`parseDimensions("security,perf")` 返回 `["security"]`，相应 prompt 有安全维度、没有性能维度。`parseDimensions("perf")` 则返回全部四个维度，JSON prompt 的 dimension 选项也变成全部四项。正常对照 `security,performance` 保留安全和性能；`performance` 单独输入只保留性能。
- 影响与边界：照用法提示输入 `security,perf` 会漏掉请求的性能维度；只输入 `perf` 会意外扩为全部维度。已验证 parser 和 builder 的字符串结果，未验证模型是否实际漏报性能问题。usage 的普通 UI 路径只读核对：[registry.listCommands:196](../../packages/tui/src/cli/commands/registry.ts#L196) 保留 usage，[App:2114](../../packages/tui/src/ui/App.tsx#L2114) 获取列表并在 [2267](../../packages/tui/src/ui/App.tsx#L2267) 传给 TuiControlSurface，后者在 [368](../../packages/tui/src/ui/components/TuiControlSurface.tsx#L368) 转交 CommandInput；[CommandInput:195](../../packages/tui/src/ui/components/CommandInput.tsx#L195) 从 usage 提取参数提示，[238](../../packages/tui/src/ui/components/CommandInput.tsx#L238) 传给 TextInput。没有挂载 UI 或执行真实命令。
- 证据：[focused fixture](evidence/reviewprompt-focused.test.ts) 前两个 characterization tests 断言当前错误表现及完整名称对照；[首次组合 raw](evidence/reviewprompt-first.raw.log)、[exit](evidence/reviewprompt-first.exit.json)。这些是记录现状的测试，产品未修复。
- 查重：全历史 [dedup](evidence/reviewprompt-dedup.json) 与 [语义决策](evidence/reviewprompt-dedup-decisions.json)。旧 archive 的 [review 文档:49](../archive/core-modules/review.md#L49) 使用正确的 `security,performance`，并明确未知名称回退策略；它不是当前 usage 的 `perf` 矛盾记录。未找到同项已登记 finding；关键词索引不能证明语义穷尽。
- 修复方向：把 usage 示例改为 `performance`，或明确支持并测试 `perf` 别名，使提示和 parser 保持一致。

## 旧缺陷族的相关静态上下文：不增加新 finding

**REVIEWPROMPT-R19-R1 → 旧 R2-03，固定三反引号围栏。** [builder:86](../../packages/coding/src/review/review-prompt.ts#L86) 与 [103](../../packages/coding/src/review/review-prompt.ts#L103) 将正文直接置于固定三反引号之间。普通完整 Markdown 源码或包含 closing fence 的 diff context 可以含同样围栏。这与旧 [R2-03](../audit-2026-10-17/root.md#L26) 的无转义固定围栏机制相同。本方向只读源码；未重新运行旧 Markdown lexer、模型、render/export 或任何提示注入实验，因此不把模型误读或安全影响列为确认。

**REVIEWPROMPT-R19-R2 → 旧 DESKTOP-R12-01，UTF-16 截断边界。** [builder:63](../../packages/coding/src/review/review-prompt.ts#L63) 在 `maxChars` 中点直接 `slice`；正常源码文字在默认 12000 code-unit 边界处也可能拆开代理对。机制与旧 [DESKTOP-R12-01](../audit-2026-10-17-round12/desktop.md#L7) 相同。这里仅记录新的 builder 静态上下文；本批没有执行 Unicode 截断、编码替换、UI 字形或模型实验，也不声称旧 Desktop 修复覆盖此 builder。

## 验证与排除

首次 guarded command 同时运行既有 `packages/coding/src/review/review-prompt.test.ts` 和 owned focused fixture：**15 pass / 44 expect / 0 fail / 0 skipped / Completed / exit 0**。其中 **9 existing tests / 20 expect**、**6 focused tests / 24 expect**；全部是实际 leaf 调用，没有复制 parser/builder 或手工镜像 CLI recipe。focused 后四项覆盖大小写/分隔符/去重、caller-owned options 不变、默认 12000 边界、空维度列表、普通 full-file/JSON labels。已有测试覆盖正常 fence/JSON schema 文案与自定义正限额。

先保存组合 stdout/stderr 原始字节及 exit，再读取输出；没有失败、重试或替代路线。首跑前 [preflight](evidence/reviewprompt-preflight.json) 只核验实际源文件/Git blob 与绝对 leaf 路径，没有猜测 root dependency 路径。完整 [validation](evidence/reviewprompt-validation.json)、[source manifest](evidence/reviewprompt-source-manifest.json)、[artifact receipt](evidence/reviewprompt-artifact-receipt.json) 保留范围和哈希。

`maxChars` 的 NaN/负数/Infinity、非法 dimension 类型与外部 mutation of exported arrays 没有建立普通 producer，未据此列 bug。大 diff 截断是现有明确策略，未额外声称性能或完整 review 保证。已有失败方向没有恢复；未运行 broad suite、build、typecheck、真实环境命令、模型、网络或原生应用。只读 Git blob/hash 是审查 metadata，未进行 Git 写入。
