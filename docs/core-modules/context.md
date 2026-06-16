# context

**One-line role.** Keeps a conversation's messages under the model's context-window budget by progressively compacting, truncating, and persisting tool results.

## 职责 / Responsibility

This module owns context-window management: it estimates token usage, decides when the message history is getting too big, and shrinks it through a tiered ladder (microcompact → LLM summary → snip → window → emergency). It also offloads large tool results to disk and replaces them with a short preview + filepath so the model can re-Read them on demand instead of carrying megabytes inline. Boundaries: it does **not** call the LLM itself — the Engine injects a `SummarizeFn` and feeds back actual token usage; the module is pure message-array transforms plus best-effort disk writes.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `manager.ts` | `ContextManager` class — the orchestrator. Holds config/state and runs the tiered `manage()` / `manageAsync()` ladder. **Main entry point.** |
| `compaction.ts` | The actual transforms: `estimateTokens`, `microcompact`, `snipCompact`, `windowCompact`, `applyToolResultBudget`, `dedupeFileReads`, `truncateToolResult`, summary build/apply, round grouping/dropping. |
| `token-counter.ts` | Char-heuristic token estimation (`estimateStringTokens`, `estimateMessagesTokens`, `calculateContextUsage`) tuned per content type (code/json/CJK). `clampContextRatios` reconciles user-supplied ratios into safe ordering. |
| `tool-result-storage.ts` | Persist oversized `tool_result` blocks to `<transcriptDir>/tool-results/<toolUseId>.txt`, replace inline with preview+path, and re-derive that "frozen" decision on resume. |
| `*.test.ts` | Unit tests for compaction ratios, file-read dedup, and the per-message tool-result budget. |

## 公开接口 / Public API

Re-exported from the package root (`packages/core/src/index.ts`).

```ts
// manager.ts — the orchestrator
class ContextManager {
  constructor(config?: Partial<ContextManagerConfig>);
  setOnCompact(fn: OnCompactFn): void;
  setSummarizeFn(fn: SummarizeFn): void;            // injected by Engine; no LLM dep inside
  setTranscriptPath(path: string): void;            // enables on-disk tool-result persistence
  initReplacementStateFromMessages(messages: Message[]): void;  // call on resume
  recordActualUsage(inputTokens: number, messageCount: number): void;  // feed API usage back
  manage(messages: Message[]): Message[];           // sync ladder (no LLM summary)
  manageAsync(messages: Message[]): Promise<Message[]>;  // async ladder, tries LLM summary first
  shouldReactiveCompact(messages: Message[], currentResponseTokens: number): boolean;
  checkLimits(messages: Message[]): { tokens; ratio; needsCompact; needsEmergency };
}

interface ContextManagerConfig {
  maxTokens: number;            // default 200_000
  compactAtRatio: number;       // default 0.85
  summarizeAtRatio: number;     // default 0.92
  maxToolResultChars: number;   // default 30_000
  microcompactFloorRatio: number;       // default 0.7 — micro idle below this
  microcompactKeepRecent?: number;      // auto-derived from maxTokens if unset
}
type SummarizeFn = (prompt: string) => Promise<string>;
type CompactStrategy = "micro" | "summary" | "window" | "snip" | "emergency";
type OnCompactFn = (info: { strategy: CompactStrategy; before: number; after: number }) => void;

// compaction.ts — used directly by the engine in a few spots
function estimateTokens(messages: Message[]): number;
function microcompact(messages: Message[], options?: MicrocompactOptions): Message[];
function windowCompact(messages: Message[], keepLastN: number): Message[];
function truncateToolResult(result: string, maxChars?: number): string;
function dropOldestRounds(messages: Message[], roundsToDrop: number): Message[];   // turn-loop imports lazily
const COMPACTABLE_TOOL_NAMES: ReadonlySet<string>;  // tools whose results micro may clear

// tool-result-storage.ts
function applyToolResultPersistence(messages, options): Message[];
function createContentReplacementState(): ContentReplacementState;
function reconstructContentReplacementState(messages): ContentReplacementState;
function resolveToolResultsDir(transcriptPath: string): string;
const DEFAULT_PERSIST_THRESHOLD = 50_000;
```

## 怎么用 / How to use

**1. Engine wiring (the real call site — `engine/engine.ts`).** Construct once per session, wire the transcript path + summary function, then call `manage`/`manageAsync` each turn.

```ts
const contextManager = new ContextManager({
  maxTokens: this.resolveMaxContextTokens(),
  // drop undefined fields so they don't clobber the defaults
  ...Object.fromEntries(
    Object.entries(this.resolveContextRatios()).filter(([, v]) => v !== undefined),
  ),
});

contextManager.setTranscriptPath(session.transcript.getFilePath());
contextManager.initReplacementStateFromMessages(messages);   // critical on resume
contextManager.setSummarizeFn(async (prompt) => {
  const res = await auxSummaryClient.createMessage({          // routed to the cheap aux model
    systemPrompt: "You are a conversation summarizer. Be concise and factual.",
    messages: [{ role: "user", content: prompt }],
    tools: [], maxTokens: 1024, reasoning: { mode: "off" },
  });
  return res.text;
});
contextManager.setOnCompact((info) => { /* schedule post_compact hook */ });
```

**2. Per-turn use inside the turn loop (`engine/turn-loop.ts`).** Async path before the LLM call; record real usage after; sync path elsewhere.

```ts
// before sending to the model — try LLM summary, fall back down the ladder
messages = await this.deps.contextManager.manageAsync(messages);

// after the response — feed back actual API usage for hybrid estimation
this.deps.contextManager.recordActualUsage(response.usage.promptTokens, messages.length);

// sync path (no LLM) is also available:
messages = this.deps.contextManager.manage(messages);

// mid-stream reactive guard
if (this.deps.contextManager.shouldReactiveCompact(messages, streamingResponseTokens)) { /* ... */ }
```

## 注意 / Gotchas

- **ESM `.js` import specifiers.** Imports use `./compaction.js` etc. even from `.ts` sources (NodeNext). `dropOldestRounds` is pulled in via a lazy `await import("../context/compaction.js")` in the turn loop. After editing `core/src`, **rebuild** — hosts (tui/desktop) import from `dist`, and stale tests run against package name → dist.
- **No LLM dependency inside the module.** Summarization is injected via `setSummarizeFn`. If it's not set (or fails 3× consecutively), `manageAsync` silently degrades to the same sync ladder (`snip → window → emergency`) as `manage`.
- **Persistence is best-effort and stateful.** It only runs after `setTranscriptPath` (no-op in unit tests / cold start with one message). On **resume you must call `initReplacementStateFromMessages`** — otherwise a previously-persisted result gets re-evaluated against the current threshold and may get a different replacement string, breaking idempotency.
- **Tier ratios must be ordered** `floor < compact < summarize`. Users edit these in `settings.json`, so feed them through `clampContextRatios` before constructing the manager (the engine drops `undefined` fields so they don't overwrite defaults).
- **`microcompactFloorRatio` (default 0.7) means micro does nothing until ~70% full.** This is deliberate — clearing early Read/Bash output under low pressure just forces re-fetches and churns the cache. Don't lower it expecting more aggressive compaction.
- **Token counts are heuristic estimates**, not real tokenizer output (char-ratio per content type). `recordActualUsage` improves accuracy by anchoring on the last real API count and only estimating messages added since.
- **`microcompact` only clears whitelisted tools** (`COMPACTABLE_TOOL_NAMES` — Read/Glob/Bash/...). Orchestration results (TaskCreate/Agent/etc.) are left intact and don't count toward the keep-recent window.
- **`onClear` fires synchronously before `microcompact` returns** — defer any token re-estimate until after `result` is reassigned (the manager does this; copy the pattern if you call `microcompact` directly).
