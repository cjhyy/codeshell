# Provider 数据与流事件审查

冻结源码：`1b04838474bcd57212f80f791d0e268a00d347e3`。本方向新增确认 **1 项 P3**，另留 **2 个候选**。没有修改产品代码。

## PROV-R7-01 — P3：Anthropic 流把后一工具的参数挂到前一工具，首工具参数没有实时送出

**普通触发条件：** 一个成功 Anthropic message 顺序包含两个 SDK 格式正常的 `tool_use` block，每个 block 都按 start → input JSON delta → stop 完成。fixture 借用 Read/Write 名称携带合成的 `path/content` 参数记录；请求的 `tools=[]`，没有声明、验证或执行实际内建 Read/Write（当前内建 schema 使用 `file_path`）。验证的是独立于工具名/参数字段的 SDK 事件路由；真实已声明工具经过同一逻辑的传播是源码推断。无需异常、重试、并发工具块或网络乱序。

**根因与合同：** [anthropic.ts:347](../../packages/core/src/llm/providers/anthropic.ts#L347)–355 到 SDK `contentBlock` 时才设置 `currentToolId/currentToolName` 并发出 `tool_use_start`；[358](../../packages/core/src/llm/providers/anthropic.ts#L358)–367 的 `inputJson` 却沿用该状态。安装的 `@anthropic-ai/sdk@0.39.0` 在 `content_block_delta` 发 `inputJson`，直到 `content_block_stop` 才发 `contentBlock`（SDK `src/lib/MessageStream.ts:433`–435、461–462；对应源码与运行时哈希见 [依赖回执](evidence/providers-dependency-receipt.json)）。因此事件顺序使当前 id 始终落后一个工具，而非 SDK block 完成后再补发该 block 参数。[ModelFacade:128](../../packages/core/src/engine/model-facade.ts#L128)–143 的合同是开始事件让 UI 在参数仍流入时显示进度，并按 call id 转发参数事件。

**已验证行为：** [首次 fixture](evidence/providers-stream-contract.test.ts) 用安装 SDK 的 `MessageStream.fromReadableStream()` 解析自有内存 JSON 行流，假 `messages.stream` 仅返回这个 parser。实际路径为 SDK parser → `AnthropicClient.createMessage` → `ModelFacade.call` → Web `reduceStream`：

- 独立 SDK 对照确认 `inputJson` 先于 `contentBlock`，finalMessage 的 input 正确。
- 首工具 JSON 全部到达后仍无任何进度事件；到 block stop 才出现 args 为 `{}` 的 start，且没有首工具的 args delta。
- 第二工具 JSON 在第一工具 id `call-one` 上发出。实际 reducer 的第一张 Read 卡得到第二个 Write 的 path/content，第二张 Write 卡 args 为 `{}`。
- 最终 response 与实际内存 Transcript 都保留两个正确的工具参数，排除了“工具实际执行参数被互换”的结论。完整身份的 OpenAI 假流对照能正确创建卡片并更新参数。

**影响边界：** 确认的是实时工具进度与卡片参数错误。Web [303](../../packages/web/src/lib/streamReducer.ts#L303)–319 按错误 id 合并参数；正常 `tool_result` 分支只更新结果/完成态（322–355）。TurnLoop [2122](../../packages/core/src/engine/turn-loop.ts#L2122)–2123 记住已发 start 的 id，并在最终 response [1654](../../packages/core/src/engine/turn-loop.ts#L1654)–1656 跳过这些工具的补发，因此源码未显示在该处用正确最终 args 修正卡片的路径。这段 TurnLoop 及 Desktop reducer 只做了静态追踪，没有运行完整 Engine、工具执行、Desktop/TUI UI 或真实 Anthropic 请求；历史重放/快照可以恢复正确参数，不声称永久损坏。

**去重：** 与旧 N02 的失败流透明重试/前缀保留、N12 的 SDK auth 缓存、C01 的 OpenAI 提前 EOF 不同。本复现使用一次成功、完整、无重试的 Anthropic 流。历史 7 月 provider 流路径说明没有识别 `contentBlock` 的 stop 语义；针对 `inputJson/currentToolId` 与参数错配的检索未发现同项。回执见 [providers-dedup-corpus.json](evidence/providers-dedup-corpus.json) 与 [providers-targeted-dedup.json](evidence/providers-targeted-dedup.json)；这是文本/结构检索和命中人工复核，不声称所有历史语义已穷尽。

## 不计新增确认的候选

### PROV-R7-C1：OpenAI 首 delta 无身份时，后来身份补齐仍不会发 start

[openai.ts:831](../../packages/core/src/llm/providers/openai.ts#L831)–843 只在新 Map 项的分支尝试发 start；845–847 收到后续 id/name 时不再尝试。第四个 stream fixture 证明：假流首 delta 只有 `index/type/function:{}`，次 delta 才给完整 id/name/args 时，ModelFacade 只发 args delta，Web 流阶段没有工具卡；完整身份首 delta 对照正常，最终 response 仍正确。TurnLoop 对没有 streamed id 的工具会在最终 response 补 start，所以也不能称永久缺卡或执行丢失。

**降级理由：** 这里尚无真实兼容端点正常 producer 或公开协议合同证明这种首 delta 身份缺失是支持的普通流。源码注释的“some providers stream them across deltas”与 SDK 可选字段不足以证明可达。使用 OpenAI Docs skill 做了官方搜索和 fetch；实际 fetch 的 [Function calling streaming](https://developers.openai.com/api/docs/guides/function-calling#streaming) 返回当前 Responses 默认变体，没有提供该 Chat Completions 顺序的正面依据。检索片段也不单独当作已读合同证据。保留为 **行为候选**，不计 P3 确认。

### PROV-R7-C2：Anthropic thinking 工具续轮丢掉应回传的 thinking blocks — 首次 fixture 失败后跳过

静态链：[anthropic.ts:385](../../packages/core/src/llm/providers/anthropic.ts#L385)–407 只抽取 text/tool_use；[ModelFacade:281](../../packages/core/src/engine/model-facade.ts#L281)–321 重建通用 assistant blocks；TurnLoop 1642–1653 同样只重建 text/tool_use。provider 的历史消息转换也没有 thinking/redacted_thinking 分支。官方 [Thinking in tool and multi-turn workflows](https://platform.claude.com/docs/en/build-with-claude/thinking-tool-workflows) 要求工具续轮完整回传 assistant 的 thinking blocks，并将过滤 redacted_thinking 描述为请求错误；[Extended thinking](https://platform.claude.com/docs/en/build-with-claude/extended-thinking#turn-structure-in-manual-mode) 还说明 manual thinking 对最后 assistant turn 的 thinking 开头要求。两个官方页面都首次读取成功，没有真实模型调用。

[独立首次 fixture](evidence/providers-thinking-roundtrip.test.ts) 使用内存 JSON SDK 适配器、实际 ModelFacade、Transcript 和次请求 body capture，thinking-on 分支的丢块断言已执行；但最后一个完整 tool_result 形状断言漏计自动 `cache_control:{type:"ephemeral"}`，因此 **整个 shard 失败**：1 pass / 1 fail / 13 expectations，没有 `Completed Bun shard`。thinking-off 控制通过不使这个失败 gate 变绿。按本次审查规则保留 [首次 raw log](evidence/providers-thinking-roundtrip.first.log) 和 [exit 1](evidence/providers-thinking-roundtrip.first.exit.txt)，**不修 fixture、不重跑、不做替代执行，方向跳过**。这项不计新增确认，也没有声称已实测真实 API 返回 400 或对 opaque 字段进行任何验证。

## 验证与范围

| 首次执行 | 结果 | 证据 |
| --- | --- | --- |
| `providers-stream-contract.test.ts` | 4 pass / 19 expect / 0 fail / 0 skipped；完整 guarded shard | [raw](evidence/providers-stream-contract.first.log)、[exit](evidence/providers-stream-contract.first.exit.txt) |
| 6 个既有普通 provider 测试文件 | 26 pass / 46 expect / 0 fail / 0 skipped；完整 guarded shard | [raw](evidence/providers-normalization-baseline.first.log)、[exit](evidence/providers-normalization-baseline.first.exit.txt) |
| `providers-thinking-roundtrip.test.ts` | 1 pass / 1 fail / 13 expect；失败后跳过 | [raw](evidence/providers-thinking-roundtrip.first.log)、[exit](evidence/providers-thinking-roundtrip.first.exit.txt) |

绿色 shard 合计 **30 tests / 65 expectations**；失败 shard 的数字单列。4 个新增聚焦测试包含 SDK 顺序对照、两个 Anthropic 触发和一个 OpenAI 控制/候选；26 个为既有 baseline，不能称 30 个新增 bug 测试。完整命令和计数见 [validation](evidence/providers-validation.json)。

审查了两 provider 的普通请求组装、流/非流结果抽取、工具结果文本/图片转换、usage/stop 读取与相关直接消费者；baseline 覆盖已有 thinking 请求字段、Anthropic usage、vision tool-result/error 转换与 OpenAI output clamp。没有全面运行所有 provider 或 Core 测试；未做清洁 build/typecheck/lint。Core client 中的 SDK `_client` 都被自有内存适配器替换；SDK MessageStream 仅解析本地内存行，没有创建 SDK 网络客户端、fetch/socket、真实 provider/模型、付费 API、用户数据、外部消息、native 程序或 auth/security/custody/watchdog 实验。保留现有依赖，没有重建共享 dist 或依赖。

来源快照与范围见 [source manifest](evidence/providers-source-manifest.json)、[primary sources](evidence/providers-primary-sources.json)；本方向产物哈希见 [artifact receipt](evidence/providers-artifact-receipt.json)。
