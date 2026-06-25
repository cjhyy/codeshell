# services

**One-line role.** A grab-bag of shared, mostly self-contained side-effect services wired into the Engine: telemetry, diagnostics, desktop notifications, OAuth login, cross-platform browser launch, and the end-of-session memory pipeline (extract / summarise / auto-dream).

## 职责 / Responsibility

This module holds engine-adjacent services that don't belong to a single subsystem — each is small, dependency-light, and best-effort. The largest piece is the memory pipeline: `MemoryOrchestrator` runs after a turn loop completes to extract durable memories, summarise the session, and conditionally trigger `runDreamConsolidation` (an LLM tool-call loop that cleans up the `dream` memory scope). The rest are leaf utilities (analytics, diagnostics, notifier, oauth, browser-open) that other parts of core or a host can call directly. Boundaries: these services don't own the LLM client, the tool registry, or the permission backend — callers (mainly `Engine`) inject those; the services only decide *what* to do and *when*.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Re-exports the public surface (note: `dream-consolidation` is NOT here — it's exported from the package root `src/index.ts`). |
| `memory-orchestrator.ts` | `MemoryOrchestrator` — end-of-session pipeline tying together extract / session-summary / auto-dream. Called by `Engine.run()`. |
| `extract-memories.ts` | Build the extraction prompt and parse the LLM JSON response into `ExtractedMemory[]`; code-side cap of 2 per pass. |
| `session-memory.ts` | Persist/load/list/search per-session summaries under `~/.code-shell/session-memories`. |
| `session-memory-sort.ts` | `sortSessionMemoriesByRecency` — order by `createdAt`, not filename. |
| `auto-dream.ts` | Dream cadence state machine (`shouldAutoDream`/`recordSession`/`recordDreamComplete`) + dream prompt builders. State in `~/.code-shell/auto-dream-state.json`. |
| `dream-consolidation.ts` | `runDreamConsolidation` — the bounded LLM tool-call loop that mutates the `dream` memory scope (exported from package root). |
| `analytics.ts` | Singleton event tracker with a JSONL file sink under `~/.code-shell/analytics`. |
| `diagnostics.ts` | Singleton error/health tracker with JSONL persistence under `~/.code-shell/diagnostics`. |
| `notifier.ts` | Cross-platform desktop notifications (osascript / notify-send / PowerShell toast), shell-free via `execFileSync`. |
| `oauth.ts` | OAuth 2.0 authorization-code-with-PKCE flow over a localhost callback server. |
| `browser-open.ts` | `browserOpenCommand` — per-platform argv to open a URL with no shell interpolation. |

## 公开接口 / Public API

Re-exported from `services/index.ts`:

```ts
// analytics — singleton + convenience
const analytics: AnalyticsService;            // .init() / .track() / .flush() / .shutdown()
function trackEvent(name: string, properties?: Record<string, unknown>): void;

// diagnostics — singleton
const diagnostics: DiagnosticsTracker;         // .record() / .recordError() / .getRecent() / .generateReport()

// notifier
function notify(options: NotificationOptions): void;
function notifyComplete(taskName: string, duration?: number): void;
function notifyError(context: string, error: string): void;

// oauth
function authorize(config: OAuthConfig): Promise<OAuthTokens>;
function refreshToken(config: OAuthConfig, refreshTokenValue: string): Promise<OAuthTokens>;

// extract-memories
function buildExtractionPrompt(transcript, existingMemories): string;
function parseExtractionResponse(response: string, maxCount?: number): ExtractedMemory[];

// auto-dream
function shouldAutoDream(config?: AutoDreamConfig): boolean;
function recordSession(): void;
function recordDreamComplete(): void;
function buildDreamSystemPrompt(): string;
function buildDreamUserPrompt(userMemories, dreamMemories): string;

// session-memory
function saveSessionMemory(entry: SessionMemoryEntry): void;
function loadSessionMemory(sessionId: string): SessionMemoryEntry | null;
function listSessionMemories(limit?: number): SessionMemoryEntry[];
function searchSessionMemories(query: string): SessionMemoryEntry[];
function buildSessionMemoryPrompt(messages): string;

// memory-orchestrator
class MemoryOrchestrator {
  constructor(options: MemoryOrchestratorOptions);
  run(
    transcript: Array<{ role: string; content: string }>,
    sessionId: string,
  ): Promise<MemoryOrchestratorResult>;   // { extracted, dreamTriggered }
}
```

Exported from the **package root** (`@codeshell/core`), not from `services/index.ts`:

```ts
function runDreamConsolidation(input: DreamConsolidationInput): Promise<DreamConsolidationResult>;
// DreamConsolidationInput: { llmClient, toolRegistry, toolContext, projectDir?, sessionId? }
// DreamConsolidationResult: { ran: boolean; summary: string }
```

`browserOpenCommand(platform, url): { cmd; args }` lives in `browser-open.ts` and is consumed internally by `oauth.ts`; it is not re-exported.

## 怎么用 / How to use

**1. End-of-session memory pipeline (real call site in `Engine.run()`).** The Engine owns the LLM client and tool registry; the orchestrator just decides what runs and when. The whole thing is wrapped in best-effort error handling.

```ts
import { MemoryOrchestrator } from "../services/memory-orchestrator.js";

const orchestrator = new MemoryOrchestrator({
  // lightweight, non-streaming aux call — no tools, no reasoning tokens
  callLLM: async (sysPrompt, userMsg) => {
    const resp = await llmClient.createMessage({
      systemPrompt: sysPrompt,
      messages: [{ role: "user", content: userMsg }],
      tools: [],
      maxTokens: 1024,
      recordUsage: false,
      reasoning: { mode: "off" },
    });
    return resp.text;
  },
  // caller drives the dream loop because it owns the tool registry + LLM client
  runDream: async ({ systemPrompt, userPrompt, projectDir }) =>
    this.runDreamLoop({ systemPrompt, userPrompt, projectDir, llmClient, sessionId }),
  projectDir: cwd,
  maxCount: this.readMemoriesConfig()?.maxCount,      // settings.memories.maxCount
  autoExtract: this.readMemoriesConfig()?.autoExtract, // false → skip extractor
});

await orchestrator.run(plainMessages, sessionId);
```

**2. Driving dream consolidation directly (e.g. desktop "整理 / Dream" button).** A host can build a seed Engine just to obtain a tool registry + LLM client, then call this without ever running a turn:

```ts
import { runDreamConsolidation } from "@codeshell/core"; // package root export

const { ran, summary } = await runDreamConsolidation({
  llmClient: opts.llmClient,
  toolRegistry: engine.getToolRegistry(),
  toolContext: engine.buildToolContext(),
  projectDir: opts.projectDir,
  sessionId: opts.sessionId,
});
```

## 注意 / Gotchas

- **`dream-consolidation` is exported from the package root, not `services/index.ts`.** Import `runDreamConsolidation` / `DreamConsolidationInput` from `@codeshell/core`, not from the services barrel. The orchestrator references it only indirectly via the injected `runDream` callback.
- **Everything is best-effort.** The memory pipeline, notifications, analytics, and diagnostics all swallow their own errors (the Engine additionally wraps `orchestrator.run` in a try/catch that only logs). Never rely on these to surface failures — they are designed to never break a turn.
- **Singletons.** `analytics` and `diagnostics` are module-level singletons. `analytics.init()` installs a 30s flush timer and a `beforeExit` flush; if you `init()` it, also `shutdown()` to clear the interval. `diagnostics` keeps all entries in memory (only `getRecent(count)` trims output) — it has no cap, so a long-lived process accumulates.
- **Dream loop is hard-bounded and scope-locked.** `runDreamConsolidation` caps at 8 LLM round-trips and 10 total writes, and refuses any `MemorySave`/`MemoryDelete` outside the `dream` scope (no interactive permission backend exists on this path). The `user` scope is read-only context. It returns `ran: false` (no-op) if the registry is missing any of the four `Memory*` tools.
- **Auto-dream cadence is global, file-backed state.** `shouldAutoDream` / `recordSession` / `recordDreamComplete` read and write `~/.code-shell/auto-dream-state.json` (default: every 5 sessions, at most once per 24h). It is process-global, not per-project, and not synchronized across concurrent processes.
- **Shell-free by design (security).** `notifier.ts`, `oauth.ts`, and `browser-open.ts` all pass arguments as argv arrays via `execFile`/`execFileSync` — never an interpolated shell string — so titles/messages/URLs can't be shell-interpreted. Preserve this when editing; the helper builders (`buildOsascriptArgs`, `browserOpenCommand`, etc.) exist so the argv stays a single literal.
- **Extraction is double-capped.** The prompt asks for "at most 2", and `parseExtractionResponse` enforces it in code (`MAX_MEMORIES_PER_EXTRACTION = 2`, override via `maxCount`). Don't assume the prompt alone limits output.
- **Memory writes carry provenance.** Extractor-saved memories are tagged `origin: "auto"` so the UI can distinguish them from user-curated entries.
- **`./compact.ts` was removed.** If you see references to a `microCompact` service here, that stub is gone — the source of truth for compaction is `ContextManager` in `src/context/`.
