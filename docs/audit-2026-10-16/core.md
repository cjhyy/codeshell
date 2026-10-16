# Core / Host / Pet 从零审查

基线：`66ee7737a7d6203319834e601c84afe6757f801e`。审查源码来自本任务 worktree；没有修改产品代码。以下编号为此分报告本地编号，主报告可另行映射。

## 已确认

### C01 — P2：OpenAI 流提前正常 EOF 被当作完整回答，TurnLoop 发布 completed

- 位置：`packages/core/src/llm/providers/openai.ts:959`；下游 `packages/core/src/engine/turn-loop.ts:1417`、`:1618`。
- 触发：OpenAI 兼容端点发出一个或多个文本 SSE chunk，随后 HTTP body 正常结束，但没有任何 `finish_reason`、`[DONE]`。例如代理重启或上游流转发不完整，连接以正常 EOF 收束。
- 预期：没有终止证据的回答应进入流不完整/模型错误处理，不应发布自然完成。
- 实际：真实 OpenAI SDK 正常结束 async iterator；CodeShell 用 `finishReason ?? "stop"` 人为补足正常 stop。真实 ModelFacade + TurnLoop 只请求一次，返回 `reason=completed`、半截报告 `The report contains these three issues: 1.`，没有 error stream event。
- 影响：半截答案会作为已完成轮次持久化和展示；调用者无法分辨上游不完整流与模型自然收尾。完整工具 JSON 若已抵达也没有完整模型响应终止证明，本次证据没有执行该分支，不扩大到重复工具执行。
- 验证：离线真实 SDK parser、真实 provider/ModelFacade/TurnLoop/内存 Transcript。对照流带 `finish_reason=stop` 和 `[DONE]` 正常完成；异常流缺两者也同样完成。见 [fixture](evidence/core-providers-policy.test.ts)、[原始日志](evidence/core-providers-policy.log)。使用注入 fetch 返回内存 Response，零真实网络/模型调用。
- 查重：自行从当前 provider 发现后，对 `docs/review-*` 的 finish_reason/EOF/stream truncation 相关记录检索，未发现同根因已登记项。

### C02 — P2：pre_tool_use 改写参数后未重复 Plan/MCP 参数权限门禁（旧报告已知，仍存在）

- 位置：`packages/core/src/tool-system/executor.ts:338`（MCPTool 参数策略），`:383`（Plan Bash 分类），`:414`（hook），`:432`（updatedInput 替换）。
- 触发一：Plan 模式原始参数是 `ls -la`；受信任的 pre_tool_use hook 将它改写成 `echo x > result.txt`。
- 触发二：当前 MCP server 的 `delete_all` 被 disabledTools 禁用；原始调用是允许的 `list`，hook 将其改成同 server 的 `delete_all`。
- 预期：应对最终执行参数重新检查 Plan 只读承诺与 MCP per-tool 禁用策略。
- 实际：原参数通过 gate 后才改写，改写只重跑 schema/path/普通 permission，未重跑上述 gate。两者均进入 fake recorder handler；直接提交相同 write/disabled tool 的对照调用均被拒绝。
- 影响和边界：这是受信任 hook 与权限策略组合的正确性缺陷；hook 本身是用户配置可执行代码，不声称隔离恶意 hook。MCPManager `callToolResult` 仍对连接/run scope 绑定，因此本条限定同一个已授权 server 的 disabled tool；没有声称跨项目 server 身份绕过。生产 Bash 不再执行 Plan 分类，MCPManager 不再重复 mcpToolPolicies。实际 shell/MCP 外部动作没有执行。
- 验证：与 C01 同一 guarded fixture，测试使用 default 权限模式加该工具显式 allow rule，未靠 bypassPermissions 绕过 Plan；只注册内存 recorder handler。
- 查重：当前代码独立发现后核对到旧 `docs/review-remaining-2026-10-12/core.md` 的 C1。不能计为本轮首次新发现。

### C03 — P2：Bash 的只读分类接受可执行程序/安装修改的 rg、npm 选项，Plan 模式直接放行

- 位置：`packages/core/src/tool-system/permission.ts:837`、`:839`；`packages/core/src/tool-system/executor.ts:383`。
- 触发：Plan 模式调用 `rg --pre ./workspace-preprocessor pattern README.md`，或 `npm audit fix`；不需要任何 hook 改写。
- 预期：只读 Bash gate 应识别 rg 的外部预处理器与 npm audit 的写入子命令，进入非只读分支并拒绝 Plan 执行。
- 实际：safe-read regex 只匹配 rg 命令名和包管理器 audit 前缀；两个纯 classifier 调用均返回 `safe-read`，真实 ToolExecutor 的 Plan 检查将两条参数均传至 fake Bash recorder。没有运行 rg 预处理器、npm 或 shell 写命令。
- 影响：用户启用 Plan 只读模式后，模型仍能绕过该承诺运行工作区程序或修改依赖。普通 auto/default 模式中 safe-read 还会自动 allow。sandbox 另有独立权限，不能把本条扩大为 OS sandbox 逃逸。
- 语义证据：当前安装 ripgrep 的 `rg --help` 明确说明 `--pre=COMMAND` 会对被检索文件无条件 spawn 进程；仅运行了只读 help。npm audit fix 的实际安装/生命周期脚本行为本轮未执行。C03 动态证据限于 classifier 和最终 gate，不宣称发生真实外部副作用。
- 验证：第二轮 fixture 新增一个测试含两个参数变体，正常 Plan gate 与 C02 共用真实 executor。5 tests / 20 expect 全过，零网络 attempt。
- 查重：旧 remaining-review 曾提到 rg/package-manager 静态想法，明确标为 unexecuted/unfiled；未发现已正式登记同根因项。本轮补全纯 classifier/Plan gate 证据，保留这个历史线索，不宣称创意首次出现。

### C04 — P2：相对 Write/Edit 路径的备份按进程 cwd 定位，撤销成功却没有撤销实际修改

- 位置：`packages/core/src/engine/file-history-hook.ts:25-30`；`packages/core/src/session/file-history.ts:138-147`（resolve 位于 140）；实际 Write 定位 `packages/core/src/tool-system/builtin/write.ts:40-41`，Edit 同样按 ctx.cwd（`edit.ts:61-62`）。
- 触发：Host 进程 cwd 与本轮工作区 cwd 不同，模型调用 Write/Edit 时给出相对 file_path。虽然 schema 文案提示 absolute，运行时 schema 没有 absolute 约束，Write/Edit handler 明确支持相对路径，path-policy 也按本轮 cwd 验证并允许。
- 预期：备份、创建标记、实际写入和 undo 应定位同一绝对路径。
- 实际：file-history hook 忽略其 options.cwd，将原始相对参数给 FileHistory；FileHistory 内部 `resolve(filePath)` 按进程 cwd 定位。实际 Write 按 ctx.cwd 写另一个文件。
- 影响：工作区原内容没有被正确备份，用户 `/undo` 得到成功却仍保留 AI 修改；如果进程 cwd 恰有同名文件，历史与撤销指向那个无关文件。后者之后有新编辑时还可能被旧 backup 覆盖，本轮没有人为制造这项额外丢失场景。
- 验证：真实 ToolExecutor + Core Write builtin + registerFileHistoryHook + FileHistory，全部 IO 限自有临时目录。Host/report.txt 与 workspace/report.txt 各有不同原内容；相对 Write 修改 workspace 文件；undo plan 只有 host 文件，真实 undo 返回 `{ok:true}`，workspace 内容仍是 after。fixture 第六项，[round3 原始日志](evidence/core-providers-policy-round3.log)。临时文件/进程 cwd 均 finally 恢复。
- 查重：对当前相关源码独立发现后检索旧 review 的 FileHistory/undo/relative/cwd，未找到同触发项。与 ApplyPatch 的 move/rollback 不同，ApplyPatch contribution 反而明确使用 options.cwd。

## 执行证据

命令：`node scripts/run-bun-test-shard.mjs --timeout 30000 docs/audit-2026-10-16/evidence/core-providers-policy.test.ts`。首轮 4 tests / 15 expect，4 pass、0 fail、0 skipped；补充 C03 后第二轮 5 tests / 20 expect，5 pass、0 fail、0 skipped，日志 [round2](evidence/core-providers-policy-round2.log)；补充 C04 后第三轮 6 tests / 25 expect，6 pass、0 fail、0 skipped，[round3](evidence/core-providers-policy-round3.log)。维护 runner 确认完整 JUnit 完成并隔离 HOME。导入均为本 worktree 的相对源码；第三方依赖来自软链 node_modules，不构成 clean build 验证。fixture 在 Core import 前阻断 global fetch、HTTP(S)、net.Socket.connect、dgram.send；provider 使用显式注入内存 fetch，并验证 synthetic origin，所有网络 attempt 为 0。重复测试不能相加为独立测试；当前 fixture 六项为两项真实 provider/parser 的内存流、三项真实 executor 配 fake recorder、以及一项自有临时文件的真实 Write/undo。

既有 baseline shard：`node scripts/run-bun-test-shard.mjs --timeout 30000 packages/host/src/runtime.test.ts packages/host/src/ask-user-unavailable.test.ts packages/core/src/composition/lifetime.test.ts packages/core/src/composition/activation.test.ts packages/core/src/engine/run-finalize.test.ts packages/core/src/engine/run-setup.test.ts packages/core/src/engine/turn-loop-continuation.test.ts packages/core/src/engine/turn-loop-max-turns.test.ts packages/core/src/session/usage.test.ts packages/pet/src/session-index.test.ts packages/pet/src/pending-decision-index.test.ts packages/pet/src/conversation-session-route.test.ts packages/pet/src/session-visit-receipt.test.ts packages/pet/src/registered-follow-ups.test.ts`。14 files / 135 tests / 464 expect，135 pass、0 fail、0 skipped，见 [原始日志](evidence/core-host-pet-baseline.log)。这些是 Host rollback、Core composition/finalize/continuation/usage、Pet 纯投影/route/receipt/validator 的既有回归测试，不代表 C01/C02/C03/C04 已被既有测试覆盖。

## 未确认候选与平台中止边界

- 未计入确认问题：`packages/core/src/engine/auxiliary-pipeline.ts:25` 的 `sameLlmIdentity` 忽略 apiKey/httpHeaders/authCommand/modelKey，`:142` 之前的相同身份 fast path 会复用 primary client。两个用户配置连接有相同 provider/model/baseUrl、不同凭据或 header 时，auxText 所选连接是否因此没有得到尊重，仍需核实配置解析/消费者契约。已只读查看函数和既有测试；既有测试明确要求忽略 credentials，故不能只凭它计确认。本轮没有新增此候选 fixture，没有执行 aux 请求，也没有完成真实 defaults.auxText 消费链复核。
- 主审随后通知平台内容检查中止，并要求停止所有进一步动态实验、不重试 aux 或权限相关工作。本分审遵从：此后仅完成报告文字，没有再执行测试、shell 命令或网络操作。C01—C04 的上述证据均在这条通知前完成，保留三轮原始日志；不把停止后的未完成调查补写成确认结论。

## 覆盖与剩余边界

已进行四轮静态审查：run session open/finalize/accounting、goal resolve/termination、ToolExecutor/permission/controller/run-tooling、OpenAI/Anthropic provider 的流收尾与重试、SessionManager run CAS/fork/state merge、HostRuntime 请求分发/rollback、Pet follow-up 校验/manager tools/session projection/IM route/visit receipt、Core composition activation/lifetime、FileHistory hook/undo/redo、Core Cron scheduler/parser/runner、AuxiliaryPipeline。动态覆盖为六个聚焦测试与上述 135 个既有 baseline 测试，不能视为所有 Core/Host/Pet 测试已过。

仍未逐行覆盖：Core operations/browser/link/plugins/sandbox/MCP 全量连接恢复、全部 session journal repair 分支、所有 builtin 工具及平台原生进程；Pet desktop 持久 store/实际 IM 通道由对应 Host 审查覆盖，本文不声称端到端验证。
