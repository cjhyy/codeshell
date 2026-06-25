# engine

**One-line role.** The conversation driver: a multi-turn agent loop that takes one user task plus an LLM, a tool registry, and a transcript, and runs LLM→tool→LLM rounds until the model is done (or a goal/limit stops it), emitting stream events and persisting the session along the way.

## 职责 / Responsibility

This module owns the *turn loop* and *session orchestration* — the heart that drives a conversation. The `Engine` class assembles per-session state (system prompt, tool list, permission classifier, hooks, MCP connections, cost/context tracking) and hands it to a `TurnLoop`, which executes the actual LLM-call → tool-execution → repeat state machine. It also handles goal mode (run until an objective is judged met), context compaction, model hot-switching, config hot-reload, and sub-agent spawning. Boundaries: it does *not* implement the LLM clients, the tool bodies, MCP transport, or the protocol/RPC layer — it composes those lower-level pieces. UI/host concerns (sidebar, RPC, cron) live above it; persistence of cost state is delegated to an injected `CostStateStore`.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `engine.ts` | The `Engine` class — the primary entry point. Construction, `run()`, model switching, config/hook hot-reload, goal control, compaction, sub-agent spawn. (~143KB, the bulk of the module.) |
| `turn-loop.ts` | `TurnLoop` — the internal LLM↔tool state machine. Goal budget tracking, stop-block counting, tool-cap enforcement, ctx-bar emission. Driven by `Engine.run()`. |
| `query.ts` | `query()` async generator — a thin public wrapper over `TurnLoop` that yields `StreamEvent`s via `for await`. |
| `model-facade.ts` | `ModelFacade` — wraps an `LLMClientBase` with transcript recording, usage/cost accounting, and ordered fallback clients on terminal errors (TODO 7.2). |
| `model-connections-pool.ts` | Pooled/reused LLM client connections keyed by model. |
| `runtime.ts` | `EngineRuntime` — shared read-only resources (modelPool, toolRegistry, settings, mcpPool, costTracker, sandbox cache) shared across many `Engine` instances in one worker. |
| `goal.ts` | Goal-mode config + math: `GoalConfig`, `normalizeGoal`, `resolveMaxStopBlocks`, `resolveMaxTurns`, default caps, limit-proximity. |
| `session-title.ts` | One-shot LLM title generation for a new session. |
| `friendly-error.ts` | Maps raw provider/runtime errors to user-friendly messages. |
| `image-policy.ts` / `image-compression.ts` | Vision-input gating (refuse non-vision models) and pre-send image downscaling to save tokens. |
| `sandbox-config.ts` / `sandbox-cache-key.ts` | Resolve sandbox mode and key the per-(mode,cwd) backend cache. |
| `parse-task.ts` | Parse `<codeshell-image>` blocks and structure out of the raw task string. |
| `patch-orphaned-tools.ts` | Repair transcripts with tool_use blocks missing their tool_result (resume safety). |
| `dynamic-tool-defs.ts` | Build tool definitions whose descriptions vary at runtime (e.g. model catalog params). |
| `token-budget.ts`, `reactive-threshold.ts`, `cost-store.ts`, `aux-key.ts`, `tool-summary.ts`, `streaming-tool-queue.ts`, `runtime.ts`, `turn-state.ts` | Small helpers: context/token budgeting, compaction thresholds, cost-state cache key, auxiliary-model cache key, tool-result summarization, streaming tool dispatch, per-turn state. |

## 公开接口 / Public API

Re-exported from the package root (`packages/core/src/index.ts`) as the "primary API":

```ts
export { Engine, loadAgentDefinitionsForCwd } from "./engine/engine.js";
export type { EngineConfig, EngineHookConfig, EngineResult } from "./engine/engine.js";
```

Key surface:

```ts
class Engine {
  constructor(config: EngineConfig);

  // Run one task to completion (multi-turn). Resolves when the model stops,
  // the goal is met, or a limit is hit.
  run(
    task: string,
    options?: {
      cwd?: string;
      onStream?: StreamCallback;
      signal?: AbortSignal;
      sessionId?: string;            // resume an existing session
      goal?: string | GoalConfig;    // goal mode for this run
    },
  ): Promise<EngineResult>;

  // Resource accessors (used to build a shared EngineRuntime from a seed engine).
  getModelPool(): ModelPool;
  getToolRegistry(): ToolRegistry;
  getSessionManager(): SessionManager;
  getHookRegistry(): HookRegistry;
  getConfig(): EngineConfig;

  // Model + permission control.
  switchModel(key: string): ModelEntry;
  getCurrentModel(): string;
  setPermissionMode(mode): void;
  getPermissionMode(): ...;
  setPlanMode(value: boolean): void;

  // Hot-reload + live mutation.
  refreshRuntimeConfig(patch: Partial<EngineConfig>, version: number): void;
  reloadHooks(): void;
  reloadModelPool(): void;
  updateConfig(key: string, value: unknown): void;
  readSetting(key: string): unknown;

  // Goal control on the in-flight run.
  extendGoalRun(...): void;
  clearGoal(sessionId: string): boolean;

  // Context.
  forceCompact(): { before: number; after: number; strategy: string };
  injectContext(sessionId: string, content: string): void;

  // Custom tools / approval.
  registerCustomTool(...): void;
  setAskUser(fn: AskUserFn | undefined): void;
  isHeadless(): boolean;
}

interface EngineConfig {
  llm: LLMConfig;                 // required
  cwd?: string;
  maxTurns?: number;
  permissionMode?: "default" | "acceptEdits" | "dontAsk" | "bypassPermissions" | "auto" | "plan";
  enabledBuiltinTools?: string[]; // whitelist
  disabledBuiltinTools?: string[];// blacklist
  goal?: string | GoalConfig;
  approvalBackend?: ApprovalBackend;
  hooks?: EngineHookConfig[];
  mcpServers?: Record<string, MCPServerConfig>;
  headless?: boolean;
  runtime?: EngineRuntime;        // share resources across engines
  settingsScope?: SettingsScope;  // 'project' (default) | 'full' | 'isolated'
  origin?: SessionOrigin;         // 'tui' | 'desktop' | 'automation' | 'subagent'
  // …many more: clientDefaults, sandbox, costStore, isSubAgent, skillAllowlist, etc.
}

interface EngineResult {
  text: string;
  reason: TerminalReason;
  sessionId: string;
  turnCount: number;
  usage: TokenUsage;
}
```

Lower-level, for advanced/in-loop callers:

```ts
// query.ts — async generator over TurnLoop.
async function* query(params: QueryParams): AsyncGenerator<StreamEvent, QueryResult, undefined>;

// goal.ts — goal-mode helpers (pure, testable).
function normalizeGoal(raw: string | GoalConfig | undefined): GoalConfig | undefined;
function resolveMaxTurns(...): number;
function resolveMaxStopBlocks(...): number;

// engine.ts — pure helpers exported for testing / sub-agent wiring.
function loadAgentDefinitionsForCwd(cwd, disabledAgents?, disabledPlugins?): AgentDefinitionRegistry;
function resolveRunCwd(args): string;
function resolveChildLlm(modelKey, pool, parentLlm): LLMConfig;
function resolveChildToolScope(allowlist, parentDisabled, parentEnabled): { enabled?: string[]; disabled: string[] };
```

## 怎么用 / How to use

**1. One-shot headless run** (from `packages/core/README.md` quickstart):

```ts
import { Engine, HeadlessApprovalBackend } from "@cjhyy/code-shell-core";

const engine = new Engine({
  llm: { provider: "anthropic", model: "claude-sonnet-4-6", apiKey: process.env.ANTHROPIC_API_KEY! },
  cwd: process.cwd(),
  approvalBackend: new HeadlessApprovalBackend("approve-all"), // trusted prompts only
  headless: true,
});

const result = await engine.run("list files and summarise their purpose", {
  onStream(event) {
    if (event.type === "text_delta") process.stdout.write(event.text);
    if (event.type === "tool_use_start") console.log("→", event.toolCall);
  },
});
console.log(result.text, result.turnCount, result.reason);
```

**2. Many sessions sharing one runtime** (the host pattern, from `packages/tui/src/cli/commands/repl.ts`): build a throwaway *seed* Engine to populate the model pool + tool registry in its constructor, lift those into an `EngineRuntime`, then create per-session engines off the shared runtime:

```ts
// 1. Seed engine — ctor populates the pool/registry; never runs a task.
const seedEngine = new Engine({ llm: llmConfig, clientDefaults, cwd, settingsScope: "full" });

// 2. Extract shared resources.
const modelPool = seedEngine.getModelPool();
const toolRegistry = seedEngine.getToolRegistry();
const resolvedLlmConfig = seedEngine.getConfig().llm;

// 3. Build the shared, read-only runtime.
const runtime = new EngineRuntime({
  modelPool, toolRegistry, settings: settingsManager,
  mcpPool: new MCPManager(toolRegistry), costTracker: new CostTracker(),
});

// 4. Per-session engines reuse it (no re-handshake, no re-load).
const engine = new Engine({ llm: resolvedLlmConfig, cwd, runtime, origin: "tui", ...sharedCfg });
const result = await engine.run(userTask, { sessionId, onStream, signal });
```

## 注意 / Gotchas

- **ESM-only, `.js` import specifiers.** All internal imports use the `.js` extension on `.ts` sources (`from "./turn-loop.js"`). Requires an ESM runtime (Node ≥ 20.10). CJS deps inside core must use `createRequire` — a bare `require` throws and the error gets swallowed (this module's surrounding modules have been bitten by exactly that).
- **`new Engine()` is heavy and side-effectful.** The constructor calls `populateModelPoolFromSettings()` and builds the tool registry. Hosts deliberately create a *seed* engine just to harvest `getModelPool()`/`getToolRegistry()`, then discard it. For multiple sessions, always pass a shared `runtime` rather than reconstructing.
- **The tool registry's builtin SET is ctor-frozen.** `refreshRuntimeConfig` / preset hot-reload re-resolves the system prompt and next-turn behavior, but a config change that *adds or removes a builtin tool* only takes effect on session restart. `applyBuiltinOverrideVisibility` can hide an already-registered tool per-turn; it cannot re-add one the constructor omitted.
- **`settingsScope` defaults to `'project'`, not `'full'`.** An embedded/SDK Engine reads only `${cwd}/.code-shell`, never the host user's personal `~/.code-shell` (keys, models, MCP, hooks). Host terminal entrypoints (TUI/desktop/CLI) explicitly pass `settingsScope: "full"`. Sub-agents inherit the parent's scope.
- **`run()` cwd recovery.** When `options.cwd` is omitted but `sessionId` is given, the engine reads the resumed session's recorded cwd from disk (precedence: `options.cwd > session cwd > config.cwd > process.cwd()`, see `resolveRunCwd`). This is what keeps a project-bound session loading the right agents/memory even when the host's repo selection has drifted to null — don't break that ordering.
- **Goal mode vs. permission mode are orthogonal.** Setting `goal` registers a `GoalStopHook` that keeps the loop going until the model judges the objective met, bounded by `maxStopBlocks` (default 25 in goal mode) + `maxTurns` (default 300). The desktop UI happens to default permission to bypass when a goal is set, but the engine treats the two independently.
- **`approvalBackend: HeadlessApprovalBackend("approve-all")` trusts the model fully** — only for local/trusted prompts. For untrusted input, set `permissionMode`/tool allowlists or implement a custom `ApprovalBackend`.
- **Cost-state persistence is opt-in.** Without an injected `costStore`, the engine does not persist cost/usage across resume — it's treated as a UI concern.
- **Sub-agent re-entry is blocked defensively.** `isSubAgent: true` + `resolveChildToolScope` strip the nested-agent tools (`Agent`/`AgentStatus`/`AgentCancel`) so there are no grandchildren even if a registry regression leaks them.
- **Recompile `dist` before host smoke tests.** TUI/desktop import the engine from the built `dist`, so changes to `src/engine` require a core rebuild before they show up downstream.
