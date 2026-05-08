# Engine & Turn Loop Architecture

> Detailed file-by-file analysis of `src/engine/` and `src/context/` modules.

---

## 1. `src/engine/engine.ts` (590 lines)

### Exports
- **`EngineConfig`** (interface) — full configuration for the Engine: LLM config, cwd, max turns, permission mode, preset selection, builtin tool filtering, hooks, MCP servers, optional CostStore, etc.
- **`EngineHookConfig`** (interface) — hook descriptor: event, handler, priority, name.
- **`EngineResult`** (interface) — final output from `run()`: text, TerminalReason, sessionId, turnCount, TokenUsage.
- **`Engine`** (class) — the main facade that wires everything together.

### Key Responsibilities
The Engine is the **orchestrator**. Its `run()` method:

1. **Wires globals**: sets `setAskUserFn`, `setArenaLLMConfig`, `setToolSearchRegistry`, `setSubAgentConfig` — these are module-level singletons that builtin tools reference.
2. **Resolves preset**: via `resolveAgentPreset()` and `resolveBuiltinToolNames()` — determines which builtin tools are active and default permission rules.
3. **Initializes ModelPool**: from SettingsManager — allows model switching at runtime.
4. **Creates/resumes session**: via `SessionManager.create()` or `.resume()`. On resume, restores cost state from `CostStateStore` and compacted messages.
5. **Builds permission config**: merges preset rules, settings rules, and mode-specific overrides (`acceptEdits`, `bypassPermissions`, `dontAsk`, `auto`).
6. **Parallelizes slow init**: `createLLMClient` (network), `buildSystemPrompt` (includes git status), `buildSystemContext` — all run in `Promise.all`.
7. **Plan mode filtering**: when `isInPlanMode()`, only read-only tools are exposed.
8. **Wires ContextManager**: injects `summarizeFn` (lightweight LLM call) and transcript path.
9. **Constructs ModelFacade**: wraps `LLMClient` with transcript recording and usage tracking. Also injects `getOutputTokens` and `summarize` methods.
10. **Sets up FileHistory**: hooks `on_tool_start` to auto-snapshot files before Write/Edit.
11. **Runs TurnLoop**: passes `ModelFacade`, `ToolExecutor`, `ContextManager`, `HookRegistry`, `Transcript`, system prompt, and tool definitions.
12. **Stores results**: saves compacted messages (stripped of userContext) for future resume; persists turn count, status, token usage, cost state to session.
13. **Emits hooks**: `on_agent_start` and `on_agent_end`.

### Additional Methods
- `registerCustomTool()` — for product adapters to inject tools before `run()`.
- `switchModel()` — hot-switches the active model via pool key.
- `injectContext()` — writes assistant message into transcript without triggering a turn.
- `forceCompact()` — triggers immediate context compaction, returns token stats.
- `updateConfig()` — writes settings to disk with dotted-key support.
- `setPermissionMode()` / `getPermissionMode()` — runtime permission mode switching.

### Connections
- **Inputs**: `LLMConfig`, `Settings`, `HookConfig`, `MCPServerConfig`, `CostStateStore`
- **Creates**: `ToolRegistry`, `HookRegistry`, `SessionManager`, `ModelPool`, `PermissionClassifier`, `ToolExecutor`, `ContextManager`, `PromptComposer`, `ModelFacade`, `TurnLoop`, `MCPManager`
- **Wires globals for**: `ask-user.ts`, `arena.ts`, `agent.ts`, `tool-search.ts`
- **Consumed by**: CLI `App.tsx`, `AgentServer`, product adapters

### Design Patterns / Gotchas
- **Facade pattern**: Engine hides the complexity of wiring 12+ components. The constructor is lightweight; `run()` does the heavy lifting.
- **Lazy `require()`**: `forceCompact()` and `updateConfig()` use `require()` inline to avoid circular dependencies (`compaction.js`, `settings/manager.js`).
- **Mutable globals**: `setAskUserFn`, `setArenaLLMConfig`, `setSubAgentConfig`, `setToolSearchRegistry` are module-level mutable state. This means you cannot run two Engine instances with different configurations simultaneously without race conditions.
- **Session compaction cache**: `compactedMessagesBySession` Map persists compacted message state across `run()` calls with the same `sessionId` — avoids re-compacting on resume.
- **`stripUserContextMessage`**: userContext (CLAUDE.md) is prepended as first message but stripped before caching compacted messages, so it doesn't persist across runs.

---

## 2. `src/engine/turn-loop.ts` (515 lines)

### Exports
- **`TurnLoopConfig`** (interface) — maxTurns, maxToolCallsPerTurn, tokenBudget, onStream, signal.
- **`TurnLoopDeps`** (interface) — the 7 dependencies injected by Engine: model, toolExecutor, contextManager, hooks, transcript, systemPrompt, tools.
- **`TurnLoopResult`** (interface) — text, reason, messages.
- **`TurnLoop`** (class) — the core agent state machine.

### Key Responsibilities
The `run()` method implements the agent loop:

1. **Pre-turn checks**:
   - Turn-limit warnings (injects `<system-reminder>` at 2 turns remaining and last turn).
   - Anti-loop detection: after 8 consecutive tool-only turns, injects a hard stop nudge.
   - Context management: calls `contextManager.manageAsync()` (may trigger LLM summarization).

2. **Model call with fallback** (`callModelWithFallback`):
   - Wraps `onStream` to track `tool_use_start` IDs and reactive compaction warnings.
   - On streaming failure (non-context-error): emits `tombstone` event, retries non-streaming.
   - On `ContextLimitError`: progressive recovery via `dropOldestRounds()` — drops 1, then 2, then 3 oldest API rounds.
   - After recovery failure: calls `patchOrphanedToolUses()` to inject synthetic error results for dangling tool_use blocks.

3. **Token budget check**:
   - Feeds actual API `promptTokens` back to ContextManager for hybrid estimation.
   - Handles `max_output_tokens` truncation: up to 3 continuation calls when `stopReason === "max_tokens"`.
   - Checks cumulative output tokens against budget via `checkTokenBudget()`.

4. **Tool execution**:
   - Clips tool calls to `maxToolCallsPerTurn`.
   - Builds assistant message with `ContentBlock[]` (text + tool_use blocks).
   - Uses `StreamingToolQueue` for concurrency-safe overlapping execution.
   - Records all results to transcript.
   - Fire-and-forget tool use summary via `generateToolUseSummary()`.

5. **Max-turns fallback**: runs one final no-tools summarization call.

### Key Details
- **`streamedToolIds`**: Set tracking tool IDs already emitted as `tool_use_start` during streaming — prevents duplicate UI events when the tool execution phase re-emits them.
- **`patchOrphanedToolUses()`**: Searches backwards for the most recent assistant message with `tool_use` blocks, finds any missing `tool_result` blocks, and injects synthetic error results. Critical for API contract compliance.

### Design Patterns / Gotchas
- **State machine**: follows the `pre_check → model_call → post_check → tool_exec → context_mgmt → hook_notify → next turn` pattern.
- **Streaming fallback**: emits `tombstone` before retrying non-streaming, so the UI can revoke partial output.
- **Progressive recovery**: `dropOldestRounds` is tried 1/2/3 rounds — not just a binary retry.
- **API round grouping**: `groupMessagesByApiRound()` in compaction.ts groups by assistant-responses — used for intelligent truncation.

---

## 3. `src/engine/model-facade.ts` (164 lines)

### Exports
- **`ModelFacade`** (class) — wraps LLM client with transcript recording and usage tracking.

### Key Responsibilities
1. **`call()`**: streaming call — forwards `text_delta` and `tool_use_start` chunks to `onStream` callback; logs latency, message count, stop reason, tool call count, usage.
2. **`callWithoutStreaming()`**: non-streaming fallback — used when streaming fails.
3. **`recordUsage()`**: accumulates API duration and token counts into bootstrap state via `addAPIDuration()`, `addInputTokens()`, `addOutputTokens()`, `addToModelUsage()`.
4. **`recordResponse()`**: records the assistant response to transcript as `ContentBlock[]`:
   - **DeepSeek V4 thinking-mode contract**: reasoning_content is persisted as a dedicated `reasoning` block (goes first so it sits adjacent to its assistant turn even after compaction).
   - Text goes as `text` block.
   - Tool calls go as `tool_use` blocks with id, name, input.
5. **`getUsage()`**: delegates to `client.getUsage()`.

### Optional Injectable Methods
- **`summarize?`**: injected by Engine for tool-use summaries (lightweight LLM call, no tools, 256 token max).
- **`getOutputTokens?`**: injected by Engine for token budget tracking.

### Design Patterns / Gotchas
- **Facade pattern**: adds transcript recording and usage tracking around the raw `LLMClientBase`.
- **Thinking mode**: the `reasoning` content block type is critical for providers that require echoing reasoning_content back on subsequent turns (DeepSeek V4). This is persisted in transcript and round-tripped back to messages.
- **Bootstrap state**: usage is accumulated in a module-level singleton (`bootstrap/state.ts`) rather than instance state — means all Engine instances share the same usage counters.

---

## 4. `src/engine/streaming-tool-queue.ts` (71 lines)

### Exports
- **`StreamingToolQueue`** (class) — concurrent-safe tool execution queue.

### Key Responsibilities
Implements a pattern for starting tool execution **during** streaming (not after):

1. **`enqueue(call)`**: if tool is concurrency-safe (read-only — Read, Glob, Grep, WebSearch, WebFetch), starts execution immediately via `executor.executeSingle()`. Unsafe tools (Write, Edit, Bash) are queued.
2. **`drain()`**: executes queued unsafe tools **sequentially** (each `await`-ed before next starts), then awaits all pending promises. Returns results in original enqueue order for deterministic transcript.
3. **`size`**: number of tools enqueued.

### Design Patterns / Gotchas
- **Overlap optimization**: safe tools run in parallel while unsafe tools are pending — both groups start at the same time conceptually, maximizing throughput.
- **Idempotency guard**: `draining` flag prevents double-drain.
- **Order preservation**: results are returned in `callOrder` order regardless of completion order — important for transcript determinism.

---

## 5. `src/engine/token-budget.ts` (60 lines)

### Exports
- **`BudgetTracker`** (interface) — continuationCount, lastDeltaTokens, prevTurnTokens.
- **`createBudgetTracker()`** — factory for BudgetTracker.
- **`BudgetDecision`** (type) — `"continue" | "nudge" | "stop"`.
- **`checkTokenBudget()`** — decides whether to continue, nudge, or stop the turn loop.

### Key Logic
1. If budget is `Infinity` or `<= 0`: always `"continue"`.
2. Computes `pct = turnOutputTokens / budget` and `delta` (tokens gained this turn).
3. **Diminishing returns detection**: 3+ continuations AND last two deltas both < 500 tokens → `"stop"`.
4. **Stop**: already nudged once AND (diminishing OR `pct >= 0.9`).
5. **Nudge**: `pct >= 0.9` (first time).
6. **Continue**: otherwise.

### Design Patterns / Gotchas
- **Pure functions**: `checkTokenBudget` mutates the tracker in-place and returns a decision — the caller (TurnLoop) owns the tracker lifecycle.
- **Two-phase stop**: nudge first, then stop on next check — gives the model one turn to wrap up.

---

## 6. `src/engine/tool-summary.ts` (46 lines)

### Exports
- **`SummarizeFn`** (type) — `(systemPrompt: string, userMessage: string) => Promise<string>`.
- **`generateToolUseSummary()`** — generates a 1-line commit-subject-style summary of tool executions.

### Key Logic
1. Takes `ToolCall[]` and `ToolResult[]`, builds input strings (`Tool: Read({"file_path":"..."}) → output`)
2. Calls the injected `summarize` function with a system prompt asking for "< 40 chars, past tense, commit-subject style".
3. Returns `null` on failure (non-critical — fire-and-forget pattern).

### Connections
Called as a **fire-and-forget** dynamic import in TurnLoop:
```typescript
import("./tool-summary.js").then(({ generateToolUseSummary }) => { ... });
```
This avoids a static import cycle and means the module is only loaded when `onStream` is provided.

---

## 7. `src/engine/query.ts` (159 lines)

### Exports
- **`QueryParams`** (interface) — messages, systemPrompt, tools, maxTurns, maxToolCallsPerTurn, signal, deps.
- **`QueryDeps`** (interface) — the 5 dependencies from TurnLoopDeps (model, toolExecutor, contextManager, hooks, transcript).
- **`QueryResult`** (interface) — text, reason, turnCount.
- **`query()`** — async generator function yielding `StreamEvent`s.

### Key Responsibilities
Provides a **generator-based API** on top of TurnLoop:

1. Creates an event queue and a `Promise`-based wake mechanism.
2. Wraps `onStream` to push events into the queue and wake the generator.
3. Runs `TurnLoop.run()` in the background via `loopPromise`.
4. Yields events from the queue as they arrive.
5. When loop completes, drains remaining events, then returns `QueryResult`.

### Design Patterns / Gotchas
- **Async generator pattern**: callers use `for await (const event of query(params))` — clean streaming API.
- **Background execution**: TurnLoop runs as a promise while the generator loop yields events — decouples computation from consumption.
- **Adapted from restored-src**: this is a simplified version of the original Claude Code query implementation.
- **Currently unused?**: Engine.run() directly constructs TurnLoop. This generator API may be for future protocol/server use or was ported from the reference codebase.

---

## 8. `src/engine/turn-state.ts` (22 lines)

### Exports
- **`TurnState`** (interface) — phase, turnNumber, modelResponse?, toolCalls?, finalText?, error?, terminalReason?.
- **`initialTurnState()`** — factory returning `{ phase: "pre_check", turnNumber }`.

### Key Responsibilities
Lightweight state snapshot for a single turn. Used within TurnLoop for tracking the current turn's phase.

### Design Patterns / Gotchas
- **Immutable-ish**: each turn creates a fresh TurnState via `initialTurnState()` — no mutation.
- **Minimal usage**: the state machine phases (pre_check, model_call, post_check, tool_exec) are documented but not extensively enforced via state transitions — the TurnLoop code path is the enforcer.

---

## 9. `src/engine/cost-store.ts` (24 lines)

### Exports
- **`CostStateSnapshot`** (type) — `unknown` (opaque to Engine).
- **`CostStateStore`** (interface) — `serialize()` and `restore()`.

### Key Responsibilities
Defines the contract for persisting session-level cost state across `run({ sessionId })` calls:

- Engine calls `restore()` on session resume (line 203 in engine.ts).
- Engine calls `serialize()` at the end of `run()` and stores the blob on `session.state.costState`.
- Engine itself does NOT compute prices or format cost summaries — it just hands blobs to the store.

### Design Patterns / Gotchas
- **Strategy pattern**: the CLI provides a concrete `costTracker` implementation; a SaaS backend could inject a database-backed store.
- **Opaque blob**: `CostStateSnapshot = unknown` — Engine never inspects the state.
- **Optional**: if no store is injected, cost state is not persisted (Engine still reports per-run token usage via `EngineResult.usage`).

---

## 10. `src/context/manager.ts` (311 lines)

### Exports
- **`ContextManagerConfig`** (interface) — maxTokens, compactAtRatio (0.6), summarizeAtRatio (0.8), maxToolResultChars (30000).
- **`SummarizeFn`** (type) — `(prompt: string) => Promise<string>`.
- **`ContextManager`** (class) — three-tier context management system.

### Key Responsibilities

**Tier system**:
| Tier | Name | Sync/Async | Strategy |
|------|------|------------|----------|
| 0 | Truncate | Sync | Truncate individual tool results > 30K chars |
| 0b | Budget | Sync | Aggregate per-message tool result budget (100K chars) |
| 1 | Microcompact | Sync | Clear old tool_result content (keep last 3 rounds) |
| 2 | LLM Summary | Async | Generate structured summary via model call |
| 2b | Snip Compact | Sync | Keep first N + last M, drop middle |
| 3 | Window Compact | Sync | Keep first + last N messages |

**Two entry points**:
- `manage(messages)` — sync path (no LLM access).
- `manageAsync(messages)` — async path (tries LLM summarization before sync fallbacks).

**Hybrid token estimation** (`estimateTokensHybrid`):
- Uses actual API `promptTokens` as base when available (recorded via `recordActualUsage`).
- Adds character-based estimation for messages added since the last API call.
- Falls back to pure estimation when no actual data.

**Additional features**:
- `shouldReactiveCompact()` — called during streaming to detect mid-turn token pressure (triggers at 90%).
- `checkLimits()` — returns tokens, ratio, needsCompact, needsEmergency.
- `deduplicateToolCalls()` / `recordToolResult()` — hashes tool calls by name+args, caches repeated identical calls (after 2 executions).
- Consecutive summary failure tracking: after 3 failures, stops attempting LLM summarization.

### Connections
- Injected by Engine, used by TurnLoop.
- Depends on `compaction.ts` for all strategies and `token-counter.ts` for estimation.

### Design Patterns / Gotchas
- **Tiered defense**: multiple strategies at different cost levels — cheap sync operations first, expensive LLM call only when needed.
- **Hybrid estimation**: bridges the gap between fast heuristics (char/4) and accurate API counts.
- **Tool dedup**: prevents the model from re-running identical expensive operations (useful when model loops).
- **Summary cache**: `lastSummary` is stored for one cycle — used as sync fallback if LLM summary was generated but subsequent compaction still needs it.

---

## 11. `src/context/compaction.ts` (420 lines)

### Exports
- **`estimateTokens()`** — convenience wrapper adding 33% overhead padding.
- **`adjustIndexToPreserveAPIInvariants()`** — the critical function that prevents splitting tool_use/tool_result pairs.
- **`snipCompact()`** — keep first N + last M, inject snipped-count marker.
- **`windowCompact()`** — keep first message + last N.
- **`microcompact()`** — clear old tool_result content (keep last 3 rounds).
- **`applyToolResultBudget()`** — per-message aggregate budget (largest results truncated first).
- **`truncateToolResult()`** — single-result truncation (keeps 70% head, 20% tail).
- **`buildSummarizationPrompt()`** — 9-section structured summary prompt.
- **`applySummaryCompaction()`** — hybrid: summary + recent messages verbatim, with transcript path and referenced file list.
- **`groupMessagesByApiRound()`** — groups messages by assistant-response boundaries.
- **`dropOldestRounds()`** — progressive recovery for prompt-too-long errors.
- **`extractReferencedFilePaths()`** — extracts file paths from tool_use blocks.

### Key Design Decisions

**`adjustIndexToPreserveAPIInvariants`** (lines 35-79):
The most architecturally important function. When compacting by keeping only the last N messages, tool_result blocks may reference `tool_use_id`s that were dropped. This function:
1. Collects all `tool_use_id`s referenced by tool_results in the kept range.
2. Checks which ones are already satisfied by tool_use blocks in the kept range.
3. Searches backwards for the assistant messages containing the missing tool_use blocks.
4. Adjusts the slice start index backwards to include those assistant messages.

Without this, compacted conversations would fail API validation.

**`applySummaryCompaction`** (lines 295-340):
Instead of eagerly restoring file contents into context (wasteful), provides:
- A structured summary.
- The transcript file path (model can `Read` on demand).
- List of recently-referenced files (model knows what to re-read).

### Design Patterns / Gotchas
- **Pure functions**: all compaction functions are pure — take messages, return new messages array. No side effects.
- **Tool pair safety**: every slicing function calls `adjustIndexToPreserveAPIInvariants` — this is the single most important invariant in the compaction system.
- **Head+tail truncation**: `truncateToolResult` keeps 70% head + 20% tail, not just head — preserves context at both ends.
- **Sorted truncation**: `applyToolResultBudget` sorts by size descending and truncates largest first — more tokens saved per truncation.

---

## 12. `src/context/token-counter.ts` (117 lines)

### Exports
- **`estimateStringTokens()`** — estimates tokens for a single string, with content-type detection.
- **`estimateMessagesTokens()`** — estimates tokens for a message array.
- **`ContextUsage`** (interface) — usedTokens, maxTokens, usagePercent, systemPromptTokens, messagesTokens, headroom.
- **`calculateContextUsage()`** — full context window usage report.

### Key Logic

**Content-type detection**:
| Type | Ratio | Detection |
|------|-------|-----------|
| English | 4.0 chars/token | Default |
| Code | 3.2 chars/token | >= 3 code indicators (`{`, `}`, `import`, `function`, `class`, etc.) |
| JSON | 3.5 chars/token | Starts with `{` or `[` |
| CJK | 1.5 chars/token | > 30% CJK characters (weighted average for mixed) |
| Mixed | 3.6 chars/token | (defined but not used in detection) |

**Per-message overhead**: 4 tokens for role/formatting.
**Per-block overhead**: 2 tokens for block structure.

### Design Patterns / Gotchas
- **Heuristic, not accurate**: these are empirical averages — not a real tokenizer. The 33% overhead padding in `estimateTokens()` (compaction.ts) compensates for underestimation.
- **Hybrid path**: `ContextManager.estimateTokensHybrid()` uses actual API counts when available, falling back to this heuristic for new messages — best of both worlds.
- **CJK detection**: special handling for Chinese/Japanese/Korean which have much higher token density (1.5 chars/token vs 4.0 for English).

---

## Cross-Cutting Architectural Patterns

### 1. Tool Pair Invariant
The most critical invariant across the entire engine: **every `tool_result` block must have its corresponding `tool_use` block in the same message array**. Violating this causes API 400 errors. Protected by:
- `adjustIndexToPreserveAPIInvariants()` in every compaction function.
- `patchOrphanedToolUses()` in TurnLoop for error recovery.
- `stripUserContextMessage()` in Engine to avoid leaving a dangling first message.

### 2. Dependency Injection
Engine constructs all components and wires them together — no service locator or DI container. Each component receives its dependencies via constructor:
- `TurnLoop` receives `TurnLoopDeps` (7 dependencies).
- `ContextManager` receives `SummarizeFn` via setter injection.
- `ModelFacade` receives `summarize` and `getOutputTokens` via property assignment.

### 3. Fire-and-Forget Async
Several operations are non-blocking:
- Tool use summaries (`generateToolUseSummary`) — dynamic import + async call, no await.
- Hook emissions — awaited but non-critical (errors are caught by HookRegistry).

### 4. Streaming Architecture
The streaming pipeline:
```
LLM API → LLMClientBase (SSE parsing) → onChunk → ModelFacade.call → onStream → TurnLoop (wrapped) → EngineConfig.onStream → UI
```
During streaming, `StreamingToolQueue` starts safe tools immediately. After streaming, any remaining unsafe tools execute sequentially.

### 5. Error Recovery Layers
Multiple layers of recovery in order of severity:
1. **Streaming failure** → non-streaming retry (with tombstone).
2. **Context limit** → progressive drop of 1/2/3 API rounds.
3. **Orphaned tool uses** → synthetic error injection.
4. **Max turns** → forced no-tools summarization.

### 6. Module-Level Mutable State (Caution)
Several singletons are set via module-level functions:
- `setAskUserFn()` in `builtin/ask-user.ts`
- `setArenaLLMConfig()` in `builtin/arena.ts`
- `setSubAgentConfig()` in `builtin/agent.ts`
- `setToolSearchRegistry()` in `builtin/tool-search.ts`
- `addAPIDuration()`, `addInputTokens()`, etc. in `bootstrap/state.ts`

This means multiple Engine instances in the same process will interfere. Appropriate for single-agent CLI usage; problematic for multi-tenant server scenarios.

### 7. Context Budget Flow
```
Engine config (maxContextTokens: 200000)
  → ContextManager (compactAtRatio: 0.6, summarizeAtRatio: 0.8)
    → token-counter.ts (heuristic estimation)
    → ContextManager.recordActualUsage() (API ground truth)
      → estimateTokensHybrid() (actual + heuristic delta)
        → manageAsync() (tiered compaction decisions)
```
