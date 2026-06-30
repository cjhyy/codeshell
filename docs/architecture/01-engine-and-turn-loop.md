# 01 · Engine & Turn Loop

> The heart of CodeShell. Everything else — tools, sessions, models, presets — exists to feed or be driven by the turn loop. Source-mapped against the current tree under `packages/core/src/engine/` and `packages/core/src/context/`.

## 1. What this layer is

The engine layer is the **orchestration facade** that wires the LLM client, the tool executor, context management, hooks, sessions, and lifecycle events into a single multi-turn agent loop. It is deliberately domain-agnostic: it knows how to *run an agent*, not how to *write code* (that is a preset — see [05](05-presets-prompt-hooks-skills.md)).

Two files carry almost all the weight:

| File | Role | ~LOC |
|------|------|------|
| `engine/engine.ts` | The `Engine` facade — session lifecycle, run setup, image policy, permission modes, goal entry, hook coordination, sub-agent spawning | ~3,300 |
| `engine/turn-loop.ts` | The `TurnLoop` state machine — model streaming, tool execution, context management, goal arbitration, termination | ~1,200 |

Supporting modules:

| File | Role |
|------|------|
| `engine/model-facade.ts` | Wraps the LLM client: request logging, streaming relay, transcript recording, token accounting |
| `engine/query.ts` | Async-generator query API (an alternate, event-queue-drain entry point) |
| `engine/turn-state.ts` | The turn phase enum + per-turn state bag (`turnId` correlation) |
| `engine/runtime.ts` | `EngineRuntime` — worker-level shared resources (`ModelPool`, `ToolRegistry`, `MCPManager`, sandbox cache) |
| `engine/goal.ts` | Persistent-goal budget structure, turn/stop-block ceilings, tracker |
| `engine/steer-queue.ts` | Step-gap steering queue (non-interrupting user-message insertion) |
| `engine/streaming-tool-queue.ts` | Concurrent vs. sequential tool execution during streaming |
| `engine/token-budget.ts` | Per-turn output-token decision (continue / nudge / stop) |
| `engine/reactive-threshold.ts` | Per-2000-token-bucket gate for mid-stream reactive compaction |
| `engine/resolve-llm-config.ts` | Settings + tag → `LLMConfig` (text); image/video resolve independently |
| `engine/patch-orphaned-tools.ts` | Resume repair: synthesize `tool_result` for orphaned `tool_use` blocks |
| `engine/image-policy.ts` | Per-turn image gate (size/count caps, drop-oversized) |
| `engine/parse-task.ts` | Extract `<codeshell-image>` blocks out of the task string |
| `engine/friendly-error.ts` | Pattern-match errors → user-facing suggestions |
| `engine/session-title.ts` | Aux-LLM one-line session title from the first exchange |

## 2. The run, end to end

`Engine.run(task, options?) → EngineResult` (`engine/engine.ts:981`, wrapped in an outer try/catch at `:416`). It proceeds in five stages.

### Stage 1 — Validate & parse input
- **Resolve cwd** by precedence: `options.cwd > session.cwd > config.cwd > process.cwd()`.
- **Parse images**: `parseTaskWithImages` (`parse-task.ts:124`) pulls `<codeshell-image mime=… name=…>data:…;base64,…</codeshell-image>` blocks out of the task text. Malformed markup throws `ImageParseError` — there is no silent fallback.
- **Enforce image policy** (`image-policy.ts`): per-image cap, per-turn cumulative cap, and a count cap. Oversized single images are compressed engine-side or dropped with a placeholder; exceeding the cumulative/count cap **refuses the turn** (fail-closed, not silent truncation).
- **Normalize the goal**: `normalizeGoal` (`goal.ts:94`) coerces `string | GoalConfig` into a `GoalConfig`, dropping empty objectives and non-positive budgets.
- **Resolve ceilings**: `resolveMaxTurns` and `resolveMaxStopBlocks` (`goal.ts:68`) — goal-aware, see §4.

### Stage 2 — Session & context setup
- `SessionManager.resume()` or `.create()` returns a `{ transcript, state }` bundle.
- `ContextManager.initReplacementStateFromMessages()` reconstructs the tool-result-persistence decisions from the loaded transcript (see §5).
- `PromptComposer` builds the system prompt from `preset + customSystemPrompt + appendSystemPrompt` (see [05](05-presets-prompt-hooks-skills.md)).
- **Resume repair**: `patchOrphanedToolUses` (`patch-orphaned-tools.ts:59`) scans the loaded history and injects synthetic error `tool_result` blocks for any `tool_use` that never got a result. This keeps the message array valid for the provider API (see §3, invariant 1).

### Stage 3 — Build the turn-loop dependencies
- A `ModelFacade` wraps the concrete `LLMClient` (from `createLLMClient`, or a pooled client via `ModelPool`).
- A `subAgentSpawner` closure is created — the `Agent` tool spawns children with resolved cwd/preset/permission scope.
- `TurnLoopDeps { model, toolExecutor, contextManager, hooks, transcript, … }` and `TurnLoopConfig { maxTurns, maxToolCallsPerTurn, onStream, signal, goal, maxStopBlocks }` are assembled and handed to `TurnLoop`.

### Stage 4 — The loop (`TurnLoop.run`, `turn-loop.ts:393`)

Each iteration of the `while` loop (`turn-loop.ts:417`) is one **turn**:

```
pre-check ─▶ model call ─▶ post-model checks ─▶ tool decision ─┬─▶ final answer ─▶ on_stop
                                                                └─▶ tool exec ─▶ (next turn)
```

**a. Pre-check** (`turn-loop.ts:418`+)
- Abort fast-path: check `signal.aborted` at the loop top (`:430`) before any expensive work.
- **Steering**: `consumeSteerItems` (`:440`) drains the step-gap queue and splices any queued user messages in *without aborting the current turn* (see §4).
- Approaching-limit warnings at `turnsRemaining === 2 / 1 / 0` inject a `system-reminder` so the model wraps up; at `0` the final turn is constrained to answer with no tools.
- `ContextManager.manageAsync(messages)` runs the compaction tiers (see §5).

**b. Model call** (`turn-loop.ts:549`+)
- `callModelWithFallback` streams from the `ModelFacade`; `tool_use` blocks are enqueued into the streaming tool queue as they arrive.
- On `ContextLimitError`: drop oldest rounds and retry (up to 3×), then `patchOrphanedToolUses` if exhausted.
- On `AbortError` / `signal.aborted`: `markStopped()` and return `aborted_streaming` (an abort is **not** an error).
- Truncated-stop continuation: if the model stops mid-tool-call because it hit max output tokens, retry up to 3× with a continuation nudge.

**c. Post-model checks**
- `emitCtxFromUsage` derives prompt overhead from `promptTokens` and feeds `ContextManager.recordActualUsage` (hybrid estimation — see §5).
- **Goal budget check** (`turn-loop.ts:704`): token + time caps are checked *after* the model call but *before* tool execution; exceeding them force-stops the run.

**d. Tool decision** — no tool calls ⇒ final-answer path; tool calls ⇒ execute and iterate.

**e. Final-answer path** (`turn-loop.ts:722`+)
- Emit `assistant_message`, then the `on_turn_end` and `on_stop` hooks. The `on_stop` hook carries the goal context.
- If a hook returns `continueSession` and `stopBlockCount < maxStopBlocks`: increment the counter, emit `goal_progress(not_met)`, inject the nudge, and continue the loop. Otherwise complete normally (or, at the stop-block cap, complete with an `exhausted` status). For a plain interactive run with no goal, the built-in goal handler is a no-op.

**f. Tool-execution path** (`turn-loop.ts:800`+)
- `streamingQueue.drain()` awaits concurrency-safe tools and runs unsafe ones sequentially (see §4).
- The `maxToolCallsPerTurn` cap refuses overflow.
- Per tool: `pre_tool_use` hook (permission + pre-hooks) → `ToolExecutor.executeSingle` → `post_tool_use` hook → `toolResultToBlock` → push `tool_result` into the message array → continue.

### Stage 5 — Termination
Emit `on_session_end`, flush the transcript, save state (terminal reason, turn count, usage), and return `EngineResult { text, reason, sessionId, turnCount, usage }`.

## 3. Invariants the loop guarantees

1. **`tool_use` ↔ `tool_result` pairing.** Every `tool_use` block must be answered by a `tool_result`, and every `tool_result` must follow its `tool_use` — a hard requirement of the Anthropic/OpenAI message shapes. The loop maintains this by emitting results immediately after execution; on resume it is *repaired* by `patchOrphanedToolUses` (`patch-orphaned-tools.ts:59`); during compaction it is *preserved* by `adjustIndexToPreserveAPIInvariants` (see §5). The context-compaction pass that protects this pairing is single-pass and depends on "result immediately follows use" — see the memory note on the compaction tool-pair invariant before reordering tool results.

2. **Abort is terminal, not retryable.** A user Esc/Ctrl+C sets the signal; the loop checks it at the top, after context management, and after the model call, and returns a non-error `aborted_streaming`. User-initiated aborts are never fed back into the retry policy.

3. **Goal budgets are a hard backstop.** The run-scoped tracker (token + wall-clock + turns + consecutive stop-blocks) is checked before tool execution and cannot be overridden mid-run.

4. **Fail-closed image policy.** Over-cap image payloads refuse the turn rather than silently dropping content.

## 4. Two mechanisms worth their own section

### Step-gap steering (non-interrupting)
`steer-queue.ts` is a set of **pure** helpers over a per-session list of `{ id, text }` (`SteerItem`). The host calls `Engine.enqueueSteer(sessionId, text, id)` while a run is in flight; the loop drains the queue at each step boundary (`consumeSteerItems`, `turn-loop.ts:440`) and splices the messages in as ordinary user turns — **no abort**. A `steer_injected` event lets the UI match the injected bubble to the draft it showed (by `id`). A still-pending entry can be revoked with `removeSteerItem` (the 撤回 path); once consumed, it cannot be taken back. This is distinct from *interrupt-and-resend* ("steer" in the UI sense), which aborts and starts a new turn.

### Goal ceilings (`goal.ts`)
A `GoalConfig` carries an objective plus optional `tokenBudget`, `timeBudgetMs`, `maxTurns`, and `maxStopBlocks`. The defaults differ for goal vs. interactive runs precisely because a goal is *unattended* and the stop-hook keeps re-blocking completion:

- `maxTurns`: interactive `100` (`INTERACTIVE_DEFAULT_MAX_TURNS`), goal `300` (`GOAL_DEFAULT_MAX_TURNS`). Precedence: config > `goal.maxTurns` > default (`resolveMaxTurns`).
- `maxStopBlocks` (consecutive judge re-blocks before forced stop): interactive `8`, goal `25`. Precedence: config > `goal.maxStopBlocks` > default (`resolveMaxStopBlocks`, `goal.ts:68`). The tighter interactive cap exists so a plugin `on_stop` hook can't loop 25× on a plain session.

The real safety net for an unattended goal is the token/time budget; `maxStopBlocks` only bites a goal the judge keeps re-blocking with no progress between blocks.

## 5. Context management (`context/`)

When the message array approaches the model's window, the `ContextManager` applies increasingly aggressive compaction — from free-and-lossless to expensive-and-lossy.

| File | Role | ~LOC |
|------|------|------|
| `context/manager.ts` | `ContextManager` — tier orchestration, config/state, hybrid token estimation | ~515 |
| `context/compaction.ts` | Pure tier functions (microcompact, snip, window, summary), token estimation, dedup & masking | ~1,200 |
| `context/tool-result-storage.ts` | Tier-0 persistence: oversized `tool_result` → disk file + preview block | ~400 |

`ContextManager.manageAsync(messages)` (`manager.ts:312`) runs:

- **Tier 0 — persistence & always-on waste removal.**
  - `persistLargeToolResults` (`tool-result-storage.ts:223`): a single `tool_result` over `DEFAULT_PERSIST_THRESHOLD` (≈50 KB) is written to `<transcriptDir>/tool-results/<toolUseId>.txt` and replaced in-context with a `[filepath + 2 KB preview]` block. A per-message aggregate cap (`PER_MESSAGE_AGGREGATE_CAP`, ≈200 KB) packs the largest results until under budget.
  - `truncateToolResults`: hard per-block fallback when persistence is off or the FS write failed.
  - `dedupeFileReads`: same path Read more than once ⇒ keep the newest, replace older copies with a supersede marker.
  - `maskOldObservations`: keep the newest `browser_observe` snapshot verbatim, collapse earlier ones (the highest-leverage browser-token saving).
- **Tier 1 — microcompact** (`compaction.ts:273`): zero-cost, lossless. For re-fetchable tools (`COMPACTABLE_TOOL_NAMES` — Read/Glob/Grep/Bash/PowerShell/REPL/WebFetch/WebSearch/NotebookEdit) it clears old `tool_result` *content* beyond the last few rounds, leaving a `[Old tool result cleared — Tool arg=…]` fingerprint. State-bearing tools (TaskUpdate/Agent/Skill) are left intact. Gated by a floor ratio (~0.7).
- **Tier 2 — summarize** (async): above `compactAtRatio` (~0.85) it asks the aux LLM for a *rolling* summary (it merges the prior summary rather than re-summarizing from scratch, so detail erodes slowly). After 3 consecutive failures it falls back to the sync `snipCompact → windowCompact` path.
- **Tier 3 — window-compact emergency**: above `summarizeAtRatio` (~0.92), keep first + last N as a last resort before `prompt_too_long`.
- **Reactive probe**: during streaming the loop accumulates response tokens and, on crossing each 2000-token bucket (`reactive-threshold.ts:13`), may trigger an emergency window-compact mid-turn.

Two design choices stand out:

- **Frozen decisions.** Once a `tool_use_id` is seen, its persistence fate is immutable for the session (`ContentReplacementState`). Re-applying the same byte-identical replacement avoids flapping the content the model built its state on; `reconstructContentReplacementState` re-derives this on resume.
- **Invariant-preserving slices.** `adjustIndexToPreserveAPIInvariants` (`compaction.ts:70`) expands a compaction slice backwards to never split a `tool_use`/`tool_result` pair. Used by both `snipCompact` and `windowCompact`.
- **Hybrid token estimation.** `recordActualUsage` stores the last *actual* `promptTokens`; `estimateTokensHybrid` uses it as a base and only estimates messages added since — so the estimate converges to ground truth every turn.

## 6. Where to read next

- Tools fired by the loop: [02 · Tool system](02-tool-system.md)
- The `ModelFacade`'s client and how a tag resolves to a model: [03 · LLM & model layer](03-llm-and-model-layer.md)
- Sessions/transcripts the loop persists into, and how all `run` goes through the protocol layer: [04 · Protocol & sessions](04-protocol-and-sessions.md)
- The `on_stop` goal judge and hooks: [05](05-presets-prompt-hooks-skills.md), and persistent goals end-to-end: [06](06-long-running-orchestration.md)
