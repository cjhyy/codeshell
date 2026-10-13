# Round 22 native 第三次失败：provider / Browser 工具发现链只读诊断

这份文档保留launch前或调试时的历史审计，文中未验证/等待收据指当时状态；当前正式R81/P2及两基线Completed证据见[最终专项报告](browser-stop-round22.md)。本静态审计新增执行仍为0。

时间：2026-10-12 07:17–07:23 Asia/Singapore。只读冻结 `a66f4ef291f304ee4df9da8095a90671d9a8f140` 源码和 `/tmp/codeshell-review-20261012-browser-stop-round22/third-native-failed/` 归档。没有执行 native、转译器、测试、模型、CLI、网络或修改任何 fixture / 产品。本笔记是支架失败诊断，不是 finding。

## 确定根因：以 browser_act schema 是否已加载判断主/辅请求不成立

归档 `owned-main-template.mjs:83–88` 将 `!options.tools?.some(tool => tool.name === "browser_act")` 直接归为 auxiliary，返回无工具调用的 `text:"owned auxiliary", stopReason:"stop"`。这不是正式请求分类规则。

Core general preset 的 `packages/core/src/preset/index.ts:42–59` initialToolNames 包含 ToolSearch / complete_goal，但不含 browser_observe、browser_act、browser_navigate；`:176–184` routing managed names 也未把 Browser 纳入自动初始路由。因此 Goal fixture 的 complete_goal 一直可见不能推导 Browser 初始可见。

fixture 的 `enabledBuiltinTools:["browser_observe","browser_act"]`（归档 Main:166）是**追加 registry eligibility**，不是将工具载入初始模型 surface。生产 `Engine` 在 `engine.ts:726–745` 将 enabled 名称传给 resolveToolNamesForPreset；该函数 `preset/index.ts:308–318` 只修改 builtin tool 名称集合。后续 `engine.ts:3185–3213` 仍使用 preset.initialToolNames 初始化 RunToolSurface（除非显式 toolAllowlist/profile allowlist），没有把 enabledBuiltinTools 注入 selectedNames。

`RunToolSurface.updateCatalog()` 的 `tool-system/run-tool-surface.ts:23–32` 只选 initial names 和 ToolSearch；只有 catalog 无 ToolSearch 时才 eager-load 全部 eligible 工具。fixture 未禁用 ToolSearch，Core general preset 含它，因此初次主请求缺少 browser_act 是正常设计。

第三归档 `native-failure-observations.json` 的完整 frames 有 11 条，含：

1. `agent/runAccepted` at 1791760539960。
2. `session_started` at 1791760540068。
3. `stream_request_start` at 1791760540097。
4. `assistant_message` at 1791760540124，文本恰是 fixture 的 **owned auxiliary**。
5. `turn_complete` at 1791760540188，reason=completed、text=owned auxiliary。
6. `session_title` at 1791760540204，title=owned auxiliary。

这直接排除“尚未到模型阶段”与“完全无 stream frames”的解释。`modelCalls:0/auxiliaryCalls:2` 是 fixture 的计数口径，不是 Core 没发过主请求：第一个主请求被 fixture :85 错分；第二个与真实 title 请求一致。`engine/session-title.ts:39–45` 的 title 请求 tools=[]、requestVisible=false、usagePurpose="title"，最终 frame 也显示该 title 已生成。主请求被返回文本完成，当然没有 browserRequests / Browser loopback pending / readiness waits；这是当前确定的、足够解释未到 Browser Stop 前置状态的原因。

## 合法内存 provider 应走的正式链

正式主请求由 `CreateMessageOptions.requestBoundaryId` 区分：`llm/types.ts:9–10` 明确 main-facade token，auxiliary 故意不带。`engine/model-facade.ts:115–120`（stream）与 `:221–228`（non-stream）都将 reqId 传入 createMessage。辅助 title 使用上述 requestVisible=false / usagePurpose=title。不能以某个 deferred schema 缺失代替该分类。

建议 owned provider 对每次调用只记录 requestBoundaryId、requestVisible、usagePurpose、tools.name[] 和计划步骤，避免记录 prompt/凭据。存在主请求 token 时走 owned plan；只有正式辅助路径才回辅助文本。主请求缺少两个 Browser schema 时：

1. 验证 ToolSearch 实际在该次 options.tools 中。
2. 返回 **仅 ToolSearch** 的 tool call，`args:{query:"select:browser_observe,browser_act"}`，本次不消费 snapshot/click 步骤。
3. Core 实际 `tool-system/builtin/tool-search.ts:93–114` 调用 runToolSurface.select(names)，返回 selected/unavailable receipt。
4. 下一次主请求必须验证两个 Browser schema 已在 immutable tools snapshot 中，再执行计划中的 snapshot。
5. 读取正式 Browser snapshot 产生的 ref 后，后续主请求才发 browser_act(click)。

`tool-system/executor.ts:187–200` 明确同一 batch 的 ToolSearch selection 只影响 **下一个模型 step**；不能同时返回 ToolSearch+browser_act 来跳过发现门禁。ToolSearch keyword 查询仅返回 metadata（tool-search.ts:133），不会载入 schema，因此应使用精确 select。若下一个 step 返回 unavailable / 仍缺 schema，应将 setup 明确失败并保留 receipt，不能循环重试或放宽 visibility。

RunToolSurface 是每个 Engine run 的局部状态；后续正常恢复 control run 也须按实际 options.tools 决定是否需要 select，不能因前一 run 搜过便省略。现有 maxTurns=4 足够 select→snapshot→click→completion 这四次主请求；Stop 发生于 click 尚 pending 时，最后完成步骤不会执行。不要改 preset.initialToolNames、直接改 toolAllowlist 或删除 ToolSearch 使 fixture 变为 eager host，那将改变待审生产路径。

## production builtinToolHost 与 Browser eligibility

Desktop 正式 worker factory 是 `packages/core/src/cli/agent-server-stdio.ts:264`，`:290` new Engine，`:304` origin="desktop"，`:305` builtinToolHost="desktop"。fixture new Engine 未传该字段；补上可恢复正式配置的一致性。

但缺失 host **不是已证明的 Browser schema 根因**。`engine/run-tooling.ts:404–417` 分开传 host (:411) 和 `hasBrowserAutomation: toolCtx.browser !== undefined` (:412)；Browser exposure guards `tool-system/builtin/index.ts:977,992` 仅判断后者。该文件 `:1060` 的 desktop-host gate 属其他工具。Core server 正式 `protocol/server.ts:1024–1032` 为非 headless session 设置 BrowserBridge，Engine `:1070–1073` 存入 config，`:4891` 注入 toolCtx。现有 `run-tooling.browser.test.ts:70–80` 覆盖 bridge 加上则 eligible、移除则隐藏的规则，不能据测试中 host="desktop" 就推断只补 Host 会让 deferred Browser 首步加载。

## busy=true / native evaluate 错误的证据界限

归档实际失败是 `electronApplication.evaluate: Execution context was destroyed, most likely because of a navigation.`，栈位于 runner `browser-stop-native.mjs:99` 的 readiness polling，而不是“actual driver readiness wait not reached”的本地 15s timeout 错误。不要将两者写成同一个已证实失败。

snapshot 中 run wrapper settled=false、ChatSession busy=true 证明当次 snapshot 外层 Promise 尚未完成，但与已存在 turn_complete 不矛盾：`engine/run-finalize.ts:343–349` 先发 completion，后返回 EngineResult；Engine `engine.ts:1429–1453` 最后仍 await scope.dispose/releaseMcpRun，再清 runInProgress；ChatSession `protocol/chat-session.ts:514,563–570` 要等 engine.run 结算后才清 active。title 是 fire-and-forget（run-finalize.ts:254–275），可以早于外层 Promise 结算发出。

当前 artifacts 没有记录 cleanup/final promise 的边界，不能确定 busy 的具体悬停 await，也没有证据表明 provider 真在等待 preflight。应先修复上面确定的主请求错分，并记录调用/工具发现 receipts；若仍有 turn_complete 后持久 busy，再以仅观察方式记录 Core Promise entry/settled/rejected、scope/MCP release 或相邻阶段，而不是任意加 await、扩大 timeout 或将 busy 忽略。此处不声称源码已证明了持续 busy 根因，也不将支架 context-destroyed 错误算为 CodeShell 产品问题。

主审执行后补记：原文“maxTurns=4足够”仅为调试时建议；第六次真实运行证明第四预算回合返回max_turns，最终正常对照使用合法maxTurns=8并Completed，四个受控provider步骤未增加。最终收据与原始失败分账见上述正式报告。
