# 问题工具与待答数据审查

冻结源：`ec0e16bf0068a458abcbaa28225a4c764c24f4de`。本方向 **0 项新确认，2 个未确认候选**。产品和 Git 未修改。审查覆盖 Core 问题工具参数/结果、协议 question 元数据转发的选定片段、TUI 待答队列及 prompt、Desktop 问题卡、Web→Mobile 普通问题投影；不代表整套交互、协议生命周期或真实客户端验收。

## 已完成证据

- [Core 离线控制](evidence/questions-core-options.test.ts) 首次 guarded shard：4 pass，8 assertions，0 fail。实际 `askUserTool` / `askUserAsyncTool` 调用内存 handler，验证同步选项元数据与回答、无选项自由回答、异步 receipt，以及缺少异步 handler 时不转成阻塞调用。
- 现有 `packages/tui/src/ui/pending-questions.test.ts` 首次 guarded shard：6 pass，22 assertions，0 fail。覆盖可选问题排队与轮转、必答问题优先、按源 session resolve、按源 session 回答、草稿复制、提交中禁止 defer。它没有加载 `AskUserPrompt` 或 Mobile 组件。
- 两个失败 fixture 均保留首次原始合并 stdout/stderr、退出码与 receipt，随后停止对应方向。失败 shard 里的断言不计入通过验证。

所有执行均由 `node scripts/run-bun-test-shard.mjs --timeout 30000 FILE` 启动。没有运行真实模型、网络、原生 UI/终端、真实用户回答或用户数据；没有修改依赖或 `dist`。组件 fixture 使用仓库维护的内存 mini-DOM / `PassThrough` renderer，TUI fixture 在动态导入 renderer 前拒绝 fetch。

## Q-R8-C1：Mobile 普通问题投影不携带 multiSelect（候选，未计 bug）

正常候选场景：Core `AskUserQuestion` / `AskUserQuestionAsync` 传入两个普通模块选项及 `multiSelect: true`，用户在手机上作答。Core 工具的描述和 `AskUserOptions.multiSelect` 允许多选；同步协议转发位于 `packages/core/src/protocol/server.ts:4123`，异步转发位于 `:4056`。新 Core 控制只证明 callback 收到该元数据。

源代码显示，`packages/web/src/lib/messageMappers.ts:129–140` 仅返回 labels 与 optionsOnly；`useRemoteApp.ts:1275–1286` 和 `PendingApproval`（`:65–70`）也没有 multiSelect。`packages/desktop/src/mobile/components/ApprovalCard.tsx:115` 的每个选项回调立即发送单一 label，未见累积选择控件。普通自由输入（`:127–148`）从静态代码看可手写组合回答；没有验证该恢复。

**合同限制**：`context.ts:68–69` 允许宿主忽略附加展示字段，`:91–93` 保留不支持选项的 host 自由输入降级。Mobile 的组件注释声称 desktop parity（`ApprovalCard.tsx:23–25`），但 2026-06-10 Mobile 能力清单 D6 只明确“选项按钮 / 自由输入”，没有明确多选验收条目；本次没有发现向工具声明只支持单选的客户端能力分支，也未运行全调用路径。这不足以单凭字段缺失确认产品 bug。

[首次 fixture](evidence/questions-mobile-multiselect.test.tsx) 在 `react-dom/client` 导入即失败：0 pass、1 fail、1 unhandled error，未进入任何测试或产品函数。见 [原始日志](evidence/questions-mobile-multiselect.first.log)、[退出码](evidence/questions-mobile-multiselect.first.exit.txt)。不修复路径、不重跑、不改用纯 helper 来补证本方向。

## Q-R8-C2：TUI 合批按键可能使用旧 cursor（候选，未计 bug）

正常候选场景：多选问题中 Down 和 Space 到达同一终端 input chunk。`packages/tui/src/render/components/App.tsx:319–325` 明确在单个 discreteUpdates 中处理全部 keys；`AskUserPrompt.tsx:210–214` 用当前 draft 更新 cursor，`:223–228` 的 Space toggle 却读取上次 render 的闭包 cursor，而非 update 回调的 `current.cursor`。`draftRef` 本来在 `:80–85` 同步更新，所以这是一个可调查的数据一致性边界。

[首次 pipe-render fixture](evidence/questions-tui-batched-choice.test.tsx) 没有建立所需控制：合批 case 在断言进入 review 时仍为 pick；把按键拆开、每步仅一个 `flush()` 的控制仍选中 index 0，而非预期 index 1。该 shard 0 pass、2 fail、6 assertions。未测到预期的合批/非合批差异，可能存在 fixture 调度不足，不能据此声称真实终端提交了错误答案。见 [原始日志](evidence/questions-tui-batched-choice.first.log)、[退出码](evidence/questions-tui-batched-choice.first.exit.txt)。不调整等待、不重跑、不用事件回调提取等替代方式复现。

## 去重与边界

[通用去重](evidence/questions-dedup-inventory.json) 和 [按键候选定向去重](evidence/questions-batched-dedup.json) 遍历所有既有 `docs/`、`bugs/` 的 Markdown 与 JSON，包含 `archive` / `_archive`，排除当前 round8。JSON 递归解析而非搜索压缩整行：1,006 Markdown、427 JSON、319,782 个文本值/行；0 JSON 解析失败。搜索结果只是去重线索，不是新颖性或正确性的证明。

- 旧 R12 / S2（`docs/review-2026-10-12/server-round1.md`）是 CC `questions[]` 被截成首题；本方向候选是 Core 单题的 `multiSelect` 投影，不复现旧问题。
- 旧 R13 / D6（`desktop-round1.md`）是跨 request 的 sticky card 状态复用；本方向按键候选限定同一 TUI request，不复现旧问题。
- 2026-05-30 的 AskUserPrompt selected filter 重复属于简化建议；Mutable Set initializer 记录未提供当前合法交互失效证据，本次没有另计。
- Desktop 的自定义回答前缀和选择顺序仅阅读，未证明用户可见损失，未升格候选；RunAskUser 适配器的自由文本降级符合兼容注释，未当作缺陷。

[验证汇总](evidence/questions-validation.json)、[候选结构数据](evidence/questions-candidates.json)、[冻结源清单](evidence/questions-source-manifest.json) 与 [文件 receipt](evidence/questions-artifact-receipt.json) 记录详细范围。初期文件检索有不存在的路径与 zsh glob 诊断；它们不属于测试、没有被记成产品缺陷。元数据搜索曾生成过长 excerpt，随后只缩短展示片段；没有变更匹配集合或重跑 fixture。
