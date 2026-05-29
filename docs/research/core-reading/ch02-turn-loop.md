# 第 2 章 · Turn Loop(代理循环)

> 覆盖:`engine/turn-loop.ts`(828)、`streaming-tool-queue.ts`、`token-budget.ts`、`model-facade.ts`、`tool-summary.ts`
> `TurnLoop` 是真正的代理状态机:`pre_check → model_call → post_check → tool_exec → context_mgmt → hook_notify → next turn`(仿 Claude Code `po_()`)。

---

## 1. 职责

`Engine.run()` 装配完毕后把消息数组交给 `TurnLoop.run(messages)`,它循环到终止条件(`maxTurns` / 无 tool_call / budget / abort / context 不可恢复),返回 `{ text, reason, messages }`。
四个配角:
- `ModelFacade`:把 `LLMClientBase.createMessage` 包一层 —— 记录 transcript / session-recorder 日志 / 全局 usage 统计 / 把 stream chunk 翻成 StreamEvent。
- `StreamingToolQueue`:并发安全的工具流式调度。
- `token-budget.ts`:纯函数,决定 continue/nudge/stop。
- `tool-summary.ts`:fire-and-forget 生成一行工具进度摘要。

## 2. 关键类型 / 入口

- `TurnLoopConfig`(31):`maxTurns / maxToolCallsPerTurn / tokenBudget / onStream / signal / onTurnBoundary / goal / maxStopBlocks(默认 8)`。
- `TurnLoopDeps`(65):`model(ModelFacade) / toolExecutor / contextManager / hooks / transcript / systemPrompt / tools / ctxOverheadStore / sessionId / isSubAgent / consumePendingCompactInfo`。
- `TurnLoop.run(initialMessages)`(229):主循环。
- `ModelFacade.call` / `callWithoutStreaming`(model-facade.ts 29/124)。
- `checkTokenBudget(turnOutputTokens, budget, tracker)`(token-budget.ts 28)。

## 3. 逻辑主线

### 3.1 一个 turn 的流程(`run` while 循环, 234-622)

```
turnCount++  → turnId + child logger(每行日志带 turn/turnId)
 ├─ stream_request_start + on_turn_start hook(可注入 messages)
 ├─ turnsRemaining==2 → 注入"还剩 2 turn"提醒;==0 → 注入"最后一 turn,只许总结"
 ├─ pre_check: contextManager.manageAsync(messages)(可能触发 LLM 摘要压缩)
 ├─ consumePendingCompactInfo:非 micro 压缩 → post_compact hook 注入提醒
 ├─ streamedToolIds.clear() + new StreamingToolQueue
 ├─ callModelWithFallback(messages)            ← 见 3.2
 │     catch ContextLimitError → dropOldestRounds 渐进恢复(最多 3 次)
 │        恢复失败 → patchOrphanedToolUses + return prompt_too_long
 │     catch 其它 → patchOrphanedToolUses + return model_error
 ├─ emitCtxFromUsage(真实 promptTokens)+ contextManager.recordActualUsage
 ├─ max_tokens 截断且无 tool_call → 续写循环(最多 3 次,拼接 combinedText)
 ├─ signal.aborted → return aborted_streaming
 ├─ finalText = response.text
 ├─ ── POST-CHECK: toolCalls.length === 0(模型想停)──
 │     emit assistant_message + on_turn_end + push assistant
 │     on_stop hook(goal 模式可 continueSession 阻止停止)
 │        continueSession && stopBlockCount<max → 注入 guidance/通用 nudge → continue
 │        达 maxStopBlocks 上限 → 打印"已达上限先停" → break out
 │     stopBlockCount=0; return completed
 ├─ ── 有 tool_call ──
 │     toolCalls = slice(0, maxToolCallsPerTurn)
 │     拼 assistant 的 tool_use blocks(未在流式中 emit 过才补 tool_use_start)
 │        + transcript.appendToolUse;push assistant message
 │     streamingQueue.enqueue(每个) → drain() → results
 │     拼 tool_result blocks + transcript.appendToolResult + emit tool_result
 │     fire-and-forget generateToolUseSummary → emit tool_summary
 │     push user(resultBlocks)+ emitCtxFromMessages
 │     checkTokenBudget → stop:return completed / nudge:注入提醒
 │     InvestigationGuard.turnEnded → 可能注入"沉默 turn"提醒
 │     TaskGuard.turnEnded → 可能注入"陈旧 task"提醒
 │     on_turn_end hook + transcript.appendTurnBoundary + onTurnBoundary(flush state)
 └─ (loop)

while 退出(maxTurns 用尽):manage → 注入"只许总结" → 无工具调一次 model → return max_turns
```

### 3.2 流式回退(`callModelWithFallback`, 670)

- 包 onStream:记 `streamedToolIds`(去重 tool_use_start)、累加 `text_delta` 估算 token、每 2000 token 探一次 `shouldReactiveCompact`(仅警告,真压缩在 turn 之间)。
- `model.call`(流式)抛错:`ContextLimitError` 直接上抛(交给 run 的渐进恢复);其它 → emit `tombstone`(撤销可能已部分发出的流)→ `callWithoutStreaming` 非流式重试。

### 3.3 ctx-bar 双轨估算

- `emitCtxFromMessages`(185):`estimateTokens(messages) + overhead`。overhead = system+tools 的缓存值。tool_result 落地后调,避免 bar 掉到 ~1k。
- `emitCtxFromUsage`(207):拿到 provider 权威 `promptTokens` 后,**反推** overhead = `promptTokens - msgsEstimate` 写回 store,校准下一次估算。两者都用 `lastCtxEmit` 去重 no-op。

### 3.4 StreamingToolQueue(并发调度)

- `enqueue`:`isConcurrencySafe` → 立即 `executeSingle` 起跑(存 pending);否则进 `unsafeQueue`。
- `drain`:unsafe 串行(一个个 await)→ 再 await 全部 pending → 按 `callOrder` 原序返回。
- 注意:**run() 实际走的是 StreamingToolQueue**(512);类里那个 `executeToolsOverlapped`(732)是另一套 overlap 实现,**run 里没调用**。

### 3.5 ModelFacade

- `call`(流式)/ `callWithoutStreaming`:都 `recordLLMRequest/Response/Error`(用 `sanitizeMessages` 剥图片 base64)、`recordUsage`(写 `state.ts` 全局计数)、`recordResponse`(写 transcript;`reasoning` 块放最前,DeepSeek V4 thinking 回显用)。
- `summarize` / `getOutputTokens` 是可选字段,由 Engine 注入(engine.ts 1236/1245)。

### 3.6 token-budget(纯函数)

- `pct = output/budget`。`pct>=0.9` 且已 nudge 过 → stop;首次 `pct>=0.9` → nudge(continuationCount++);"递减收益"(≥3 次续写 + 连续两次 delta<500)→ stop。`budget=Infinity` → 永 continue。

## 4. 逻辑理顺问题

- ⚠️ **`executeToolsOverlapped`(732)是死代码**:`run()` 用的是 `StreamingToolQueue`(509-512),没有任何地方调 `executeToolsOverlapped`。两套并发逻辑(一套 safe 全并行+unsafe 串行、queue 那套 unsafe 串行但起跑时机不同)并存,易混淆。**应删或注明保留原因。**

- ⚠️ **`StreamingToolQueue.drain` 的"unsafe 串行"其实是顺序起跑+逐个 await,但 safe 工具的 promise 已在 enqueue 时起跑** —— 所以 safe 与 unsafe **确实并发**。但 unsafe 之间是串行 await 起跑(52-55:`set(...executeSingle); await`),意味着 unsafe[1] 要等 unsafe[0] 完全跑完才 `executeSingle`。这是预期(写操作串行)。但 ❓:若某个 unsafe 工具 hang,后续 unsafe 全卡,且 safe 的结果也要等到 drain 末尾才一起返回 —— 没有单工具超时在这一层(超时应在 executor 层,见第 4 章核对)。

- ❓ **max_tokens 续写把 `assistant: combinedText` 当成新消息塞进临时 `contMessages`**(371),但**没有把前一轮的 assistant 回复先 push**。即 contMessages = `[...messages, assistant(combinedText), user(继续提示)]`,而此时 `messages` 里还没有这轮 assistant。逻辑上是"假装模型已说了 combinedText,请继续"。OK,但续写成功后 `response = {...contResponse, text: combinedText}`,最终在 416 分支才把单条 assistant(合并文本)push 进真 messages。**确认:中间这些续写轮次的 token 用量是否被 `recordUsage` 计入?** —— `model.call` 每次都 recordUsage,所以会计入,符合预期。

- ❓ **续写循环里用 `this.deps.model.call`(381)而非 `callModelWithFallback`** —— 续写不享受流式回退;若续写时流式失败,直接 `catch { break }` 吞掉,返回已合并文本。可接受(续写是 best-effort),但与主调用的健壮性不一致,记录。

- ❓ **on_stop 续跑的 guidance 注入与 GoalStopHook 的判定耦合在 hook 返回值**(439)。`stopBlockCount` 只在"未被 block 的 completed"时清零(478);但 budget-stop(570)/ aborted(407)/ max_tokens 路径 return 时**不清零** `stopBlockCount` —— 因为是实例字段且 run 只跑一次,无害。但若将来复用 TurnLoop 实例会脏。记录。

- ❓ **`maxTurns` 警告注入用 `turnsRemaining === 2`(精确等于)**(264)。若某 turn 跳过(理论上不会,turnCount 每轮 +1),或 maxTurns < 2,则永远不会注入"还剩 2"提醒(maxTurns=1 时直接进 `===0`?不:turn 1 时 remaining=0,命中最后一 turn 提醒)。边界:maxTurns=1 时第 1 turn 就被强制"只许总结",可能过早。记录为边界行为。

- ❓ **`recordResponse` 在 ModelFacade 内写 transcript(244),而 TurnLoop 也写 transcript**(`appendToolUse`/`appendToolResult`/`appendMessage`?)。具体说:assistant 消息由 **ModelFacade.recordResponse** 写一次(含 tool_use blocks),而 TurnLoop 又 `transcript.appendToolUse`(503)单独记 tool_use。**两处都往 transcript 写 assistant 侧的 tool_use** —— 是否重复记录?需在第 6 章读 Transcript 时确认 `appendMessage(assistant, [...tool_use])` 与 `appendToolUse` 是否产生重复事件 / 重复 message。**这是潜在的 transcript 双写疑点,标记跨章核对。**

- ❓ **reactive compaction 只在 `streamingResponseTokens % 2000 === 0` 时探测**(684)。`text_delta` 的 `length/4` 累加几乎不可能恰好命中 2000 的整数倍,所以这个 warning **基本永不触发**。疑似无效条件(本意应是 `>= 下一个 2000 阈值`)。

- ❓ **`patchOrphanedToolUses`(787)与 `patch-orphaned-tools.ts` / engine resume 时的 `patchOrphanedToolUses`(engine.ts 924)是两套实现**。TurnLoop 内是 push 一条 user(error blocks)到末尾;engine/独立模块版处理 resume 的中间空洞。功能相近、实现分离,第 1 章已记 dream-loop 重复,这里是 orphan-patch 重复。需第 4/6 章核对是否能合并。

- ❓ **budget-stop 与 completed 都 return `reason: "completed"`**(570 vs 479)。budget 触顶被当成正常完成,UI 无法区分"自然答完"与"预算截断"。`max_turns` 有独立 reason,budget 没有。记录。
