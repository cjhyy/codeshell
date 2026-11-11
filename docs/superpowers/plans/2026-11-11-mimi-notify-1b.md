# Mimi 提醒 1b：外部运行时 + 子代理 NotifyMe 实现计划

> 设计稿：`docs/superpowers/specs/2026-11-09-mimi-dispatch-notify-proactivity-design.md` §6.3、§13（1b）、§15（子代理）。
> 基线：main `e0152845d`（0.10.1）。分支 `claude/pet/mimi-notify-1b-20261111`。

**目标**：Codex / Claude Code 会话（桌面主进程里的外部运行时）和原生会话的子代理里，"做完微信告诉我"与卡住时的回码都和原生顶层会话一样工作。

**不变量**（1c 定下的，不能破）：

- 会话事件只由 `session-outcome.ts` 的 `SessionOutcomeDeriver` 解释一次；协调器和规则观察器都吃它的结果。
- "告诉谁"只由 `pet-delivery-plan.ts` 决定；新推送路径一律过 `router.submit*`。
- 决定提示的生命周期在 ledger 记录的 `prompt` 字段里；IM 回码由 `PetImDecisions.reply()` 解析。
- 行数上限（`tests/architecture-budgets.test.ts`）：`external-runtime-service.ts` 2341/2500、`index.ts` 4645/5000、`agent-bridge.ts` 2880/3000。新逻辑放新模块，不要提上限。
- 新的 desktop pet-notice 测试要登记到 `.github/workflows/ci.yml` 里 pet-notice 那个单独 Bun 进程。

## 现状缺口（调研结论）

1. 外部会话没有任何 Mimi 工具：`external-tool-exposure.reviewed.json` 不含 pet 工具；就算暴露，pet 执行器靠 `ProtocolObserverHost`，主进程里没有。
2. 外部事件到不了 outcome tap：`index.ts:2056-2069` 只订阅 worker 的 `bridge.subscribeOutbound`；外部事件走 `externalBridge.ingestOwnedExternalEvent` → `publishOwnedExternalEvent`（`agent-bridge.ts:2812`），只有有 owner 窗口时才触发 `ownedExternalTaps`。
3. 资格判断排除外部会话：`pet-notice-projection.ts:27-38` 的 `isEligibleSession` / `sessionTitle` / `isSessionBusy` 只看 worker 投影。
4. 外部审批/提问不进 `PetImDecisions`：它只读 worker 的 `agent/approvalRequest`。
5. 外部 `session_started` 不带 `trigger`，deriver 回退逻辑会把每次外部运行当成后台唤醒（"好的，做完告诉你"那一轮也会算 done）；`turn_complete` 不带 `outcome`、没有最终文本；Goal 预算暂停只发 `not_met`，deriver 不产出 blocked。
6. 子代理的 ToolContext 没有父会话 id；子会话不是 ChatSession，`requestHostAction(childSid)` 抛 `session not live`。

## 任务

### T1 子代理里的 NotifyMe（core + pet）

- core：`EngineConfig.parentSessionId?`（`engine/types.ts`）；`subagent-spawner.ts` 建子配置时写入可信的父 id（不要读 `state.json` 的 `parentSessionId`——子代理能改它）。`ToolContext` 与 `ToolVisibilityContext` 加 `rootSessionId?`：顶层会话 = 自己的 sessionId；子代理 = `config.parentSessionId`（层级是平的，父即根）。经 `run-tooling.ts` / `tool-visibility.ts` 传给可见性。
- pet `notify-me.ts`：可见性在子代理里改为要求 `isReportableSessionId(ctx.rootSessionId)` 且与自身 id 不同；执行时目标 = `ctx.isSubAgent ? ctx.rootSessionId : ctx.sessionId`，用于 `upsert.sessionId`、`requestHostAction` 第一个参数、`hasActiveGoal`（读根会话的 Goal）。`capability.ts` 的 `ruleRequesterFor` 按根 id 路由；单宿主回退不能拿子 id 路由。
- 描述/回执文字在子代理里说明"主会话这一轮/Goal 结束时通知"。
- Mimi 会话的子代理：desktop `isEligibleSession` 已挡；pet 侧若能知道根是 Mimi 就隐藏。
- 测试：`notify-me.test.ts`（子代理指向根、根 Goal 决定默认 scope、无根时失败关闭）、`subagent-spawner.test.ts`（子配置带父 id）、engine 子绑定测试（子 ToolContext 的 rootSessionId）。
- desktop 不改。

### T2 外部会话进入提醒资格与在场信息（desktop）

- 新模块（例如 `pet/pet-external-sessions.ts`）：由 `ExternalRuntimeService`（或其状态/会话存储）提供桌面外部运行时会话的目录：sessionId、标题、是否正在运行/忙、运行时种类（codex/claude-code）、是否已结束。
- `pet-notice-projection.ts` 的 `isEligibleSession`、`sessionTitle`、`isSessionBusy`（以及 `pet-notice-wiring.ts:192-197` 用到的）在 worker 投影找不到时查这个目录。注意 `DesktopPetSession.external` 指的是独立 CLI 尾随会话，不是这个，不要混。
- worker 丢失时 `sessionOutcomeDeriver.reset()` 不能清掉外部会话的状态：改成只清 worker 会话（例如 `reset(predicate)` 或按来源分开两个 deriver 实例——选简单的）。
- 测试覆盖：外部会话可被资格判断接受、标题来自外部目录、worker 丢失不影响外部会话的 deriver 状态。

### T3 外部事件流喂给 outcome tap（desktop + 外部运行时记录器）

- `agent-bridge.ts`：加一个不依赖 owner 窗口的外部事件订阅（或放宽 `subscribeOwnedExternalStream`），在 `index.ts` 把它接到同一个 `observeSessionOutcome`（`createSessionOutcomeTap`）。注意 `index.ts` 余量，接线代码尽量放进现有 pet 接线模块。
- `external-runtime-state.ts` 记录器：`session_started` 带 `trigger`（用户提交 = `"user"`；宿主转发/Mimi 派活 = `"host_message"`；Goal 续跑/后台唤醒按实际语义）；`turn_complete` 带 core 的 `outcome`（优先复用 `core/src/engine/turn-outcome.ts` 的 `createTurnOutcomeTracker` 或其纯函数；`bookkeeping` 工具 NotifyMe/ReportToMimi 等不算工作）以及最终文本（若 core 的 `turn_complete` 类型已有 `text` 字段就用它，否则只在 outcome/回复文本需要的地方带）。
- Goal：外部 Goal 预算暂停（`external-runtime-goals.ts:425-442`）要让 deriver 能得出 blocked（例如同时带 `waitingForUser` 或 outcome 里 `goal: "paused"`，和原生语义一致——先读原生 core 在同一情形发什么，照抄）。
- 长任务协调器按 `clientMessageId`/`previousRunId` 绑运行，外部 start 事件要带上可用的那个（Mimi 派到外部会话时）。
- 测试：用 `external-runtime-service.test.ts` 的 `fakeSession` 推事件，断言：只回"好的"的一轮不触发 done；干活的一轮触发；Goal 暂停 → blocked；`cancel_goal` → 规则取消；事件不论有无 owner 窗口都到 tap。

### T4 外部会话暴露 NotifyMe（core 暴露清单 + desktop 执行器）

- `ExternalToolCompatibility.requires` 扩一个值（例如 `"mimi-notice"`），`deriveExternalToolExposure` 加对应选项；`external-tool-exposure.reviewed.json` 加 `NotifyMe`（status exposed、kind host-loopback、requires mimi-notice）。`FIRST_PHASE_EXPOSURE` 与精确列表测试保持不变；更新指纹与暴露评审测试（`external-runtime-exposure-review.test.ts` 的 catalog 要包含新工具定义）。
- desktop 新模块 `external-runtime-mimi-tools.ts`（照 `external-runtime-goal-tools.ts`）：在 `startExclusive` 里像 Goal 工具那样注册 NotifyMe 的桌面执行器，复用 pet 的 `notifyMeTool(args, ctx, requester)`，requester 直接调用桌面进程内的规则 host action 处理器（`createNoticeRuleAction`，`pet-notice-host-action.ts`），不要走 worker。默认 scope 读外部 Goal 状态（`ExternalRuntimeGoals.read(sessionId)`）。
- 预置 allow 规则（D5 免审批），开发者说明里加一句 NotifyMe 的用法提示。
- `ReportToMimi`：查原生桌面侧怎么处理它的 `notify`；如果处理器能在主进程内直接调用，就同样暴露（Mimi 派给外部会话的活需要回报）；否则在计划里记为后续，不硬做。
- 测试：暴露清单（有选项才出现）、执行器写规则并返回实际效果说明、规则失败时如实报错、默认 scope 跟随外部 Goal。

### T5 外部审批/提问进入 IM 决定提示（desktop）

- `external-runtime-approvals.ts`：记录请求时间，提供主进程用的 `pendingAll()`；`onPendingChange` 增加一个 Mimi 观察者（`index.ts:585-589` 现在只给 mobile）。
- 新模块（例如 `pet/pet-external-decisions.ts`）把外部待决项转成 `ImDecision`：码种子与原生区分（例如 `["external", sessionId, requestId]`），`expiresAt = createdAt + 10 分钟`，Codex 原生审批的 `params` 映射成描述/参数，`__ask_user__` 映射成问题+选项。`PetImDecisions` 的读入合并原生与外部两路。
- 回码：`approve`/`keepWaiting` 按来源分派，外部的走 `approvals.settle(requestId, {approved, answer, reason})`（不带窗口 id）；超时映射为拒绝。
- 生命周期：外部 `requested`/`resolved` 触发 `scanNow()`；`resolved` 撤销路由器里的提示（`router.revokeDecision`）；`decisionStatus`/`projectionLive`/`workerGone` 对外部 id 给出正确答案（在 pending 里 = 等待；否则已解决；外部会话结束 = 走掉），不能被 worker 状态误判。
- 测试：外部审批出现 → 提示带码进路由器；IM 回 `回答 码 1` → settle 被调、提示结束；桌面先回答 → 提示撤销；外部提问多选；worker 丢失不影响外部提示。

### T6 收尾

- 设计稿 §13 / §15 更新 1b 与子代理的实现状态（只写设计稿，不写参考来源）。
- 新测试登记 CI；跑：受影响包测试（先重建 core/coding dist）、`bun test ./tests/mimi-chat-replay.test.ts`、全仓契约/预算测试（`tests/architecture-budgets.test.ts`、index.exports、ipc-contract）、`bun run typecheck`（或各包 tsc）。
