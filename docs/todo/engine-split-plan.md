# Engine Split Plan

Status: planning draft only. Source code has not been changed.

Scope: physically split `packages/core/src/engine/engine.ts`. In this checkout it is
3,521 lines, not roughly 3,301. The prior prerequisites are already in place:
`EngineConfig`, `EngineHookConfig`, and `EngineResult` live in
`packages/core/src/engine/types.ts`, and the type-level tool-system to engine cycle
has already been broken.

Guiding rule: keep `packages/core/src/engine/engine.ts` as the public facade until the
end. Existing imports such as `import { Engine, resolveRunCwd } from "./engine.js"`
should continue to work through re-exports/delegating methods while implementation
moves to sibling modules under `packages/core/src/engine/`.

## Current Structure Map

Line anchors refer to `packages/core/src/engine/engine.ts` in the current checkout.

- `1-145`: Imports. The file pulls in LLM clients, tool registry/executor, builtin
  tools, hooks, context management, prompt composition, session/transcript, logging,
  MCP, settings, credentials, presets, model pool, parsing/image policy, memory,
  runtime, path, and fs.
- `146-203`: Compatibility helpers and public re-exports. Includes
  `compatFileNamesFrom` (`153-161`), type re-export from `./types.js` (`191-192`),
  `EnqueueSteerResult` (`194-197`), and `diskDefaultsFrom` re-export (`203`).
- `205-322`: Pure top-level helpers:
  `resolveChildLlm` (`217-227`), `resolveRunCwd` (`246-253`),
  `loadAgentDefinitionsForCwd` (`255-281`), nested-agent constants (`283`),
  `applyBuiltinOverrideVisibility` (`293-299`), and `resolveChildToolScope`
  (`308-322`).
- `324-433`: `Engine` fields. This is the live mutable state cluster:
  preset, registry, hooks, session manager, MCP manager, model pool, settings hook
  handles, config reload version, agent definition cache, runtime, sandbox cache,
  permission/plan mode, settings manager, aux client cache, last context/messages,
  compacted message cache, context usage seed/overhead stores, steering queue,
  active permission classifier, active turn loop, active goal hook, and active run
  session.
- `435-481`: Context-window helpers. `maxContextTokens`, `resolveMaxContextTokens`,
  and settings-backed `resolveContextRatios`.
- `489-570`: Hook emission and hook wiring. `emitHook`, `registerSettingsHooks`,
  and `reloadHooks`; preserves plugin/settings/config hook order and handles.
- `572-641`: Constructor. Resolves preset, freezes builtin registry set, creates hook
  registry and session manager, registers plugin/settings/config hooks, and populates
  the model pool when no shared runtime is supplied.
- `648-783`: Model pool loading. Reads settings model connections, syncs
  `config.llm`, applies image/temperature defaults, supports `reloadModelPool`, and
  auto-populates from legacy env/API-key config.
- `789-923`: Small public API and steering/session probes:
  `registerCustomTool`, `setAskUser`, `setBrowserBridge`, `enqueueSteer`,
  `unsteer`, private `consumeSteer`, `setInjectCredential`, `isHeadless`,
  and `sessionExistsOnDisk`.
- `929-1110`: `run()` preflight. Resolves cwd from session/config/process,
  wraps `onStream` to track todo and goal progress, parses image blocks, enforces
  vision and size policy, compresses or drops oversized images, and derives the
  text-only task.
- `1112-1126`: Pasted-noise rejection before any session/tool setup.
- `1128-1247`: In-run sub-agent spawner. Builds a child `Engine`, strips nested
  agent tools, resolves child LLM/tool scope, filters child stream events, anchors
  child sessions in the parent transcript, and runs/resumes child sessions.
- `1249-1320`: Sandbox and base `ToolContext` setup. Reads project/global sandbox,
  resolves/caches backend, builds `ToolContext`, overlays session cwd/sandbox/
  sub-agent spawner, and wires stream callback.
- `1321-1368`: Run logging and user message content. Logs task metadata, collects
  attached image file paths, and builds either text or multimodal content blocks.
- `1370-1522`: Session creation/resume and logging scope. Handles existing vs new
  sessions, compacted message cache, orphaned tool-use patching, cost-store restore,
  client-message idempotency, transcript persistence, turn sequence, `setCurrentSid`,
  tool context session id, and `runWithSid`.
- `1523-1617`: Session-start phase. Records session start, emits `on_session_start`
  and `user_prompt_submit`, applies prompt rewrites, emits `session_started` with a
  rough context seed, and replays last todo snapshot on resume.
- `1619-1818`: Turn setup. Starts LLM client creation, builds permission config,
  creates `ToolExecutor` and guards, creates `ContextManager`, reads disabled
  capability lists, builds `PromptComposer`, connects MCP servers, computes tool
  visibility, builtin overrides, MCP filtering, feature-flag filtering, dynamic tool
  definitions, and plan-mode tool filtering.
- `1819-1930`: Prompt and model facade setup. Awaits LLM/prompt/context builds,
  prepends user context, injects lifecycle reminders, appends dynamic context,
  wires compaction summarization, resolves aux client, initializes cumulative usage,
  creates `ModelFacade`, records usage baseline, and wires tool-use summaries.
- `1932-1977`: File-history and start hook. Loads per-session file history,
  registers `on_tool_start` backup hook, and emits `on_agent_start`.
- `1979-2057`: Goal and compaction hook setup. Normalizes/persists active goal,
  registers run-scoped goal stop hook, exposes active goal hook, and buffers
  `ContextManager` compaction events for UI and `TurnLoop`.
- `2058-2168`: `TurnLoop` construction and active handle exposure. Supplies all
  deps/config callbacks, including steering, client-message idempotency, cumulative
  usage, persisted-goal clearing, context overhead store, streaming, signal,
  fresh image messages, goal limits, and turn-boundary persistence.
- `2170-2249`: Turn execution and run-scoped cleanup. Runs the loop, drains
  background sub-agents only for headless top-level runs, unregisters goal/file
  hooks, clears active handles, and updates compacted message cache.
- `2251-2349`: Post-run completion. Logs and records session end, emits
  `on_session_end`, starts fire-and-forget memory pipeline and first-turn title
  generation, persists terminal state/usage/cost, emits `on_agent_end` and
  `turn_complete`, and returns `EngineResult`.
- `2369-2446`: Summarization and aux client helpers. Shared compaction summarizer
  and aux-model resolution/cache.
- `2448-2555`: Background memory/dream pipeline. Sanitizes transcript content,
  runs `MemoryOrchestrator`, and delegates dream consolidation.
- `2557-2684`: Tool/model/session accessors and model persistence. Includes
  `switchModel`, `resetSessionUsage`, `persistActiveModel`, and simple getters.
- `2686-2766`: Runtime config hot reload. Merges disk patch, re-resolves preset,
  reloads hooks, reconciles MCP servers, and tracks monotonic config version.
- `2768-2927`: Goal/session context control. `getGoal`, `clearGoal`,
  `injectContext`, `forceCompact`, and `stripUserContextMessage`.
- `2936-2967`: Settings manager and generic settings read/write.
- `2969-3109`: Permission and plan-mode runtime control. Builds permission rules
  and approval backend, reconfigures in-flight classifier, exposes permission rules,
  and toggles plan mode.
- `3111-3175`: Background-agent wait utilities for headless drain.
- `3177-3235`: Agent definitions and capability overrides. Memoized agent registry,
  disabled agents, and per-project builtin override reads.
- `3237-3392`: Sandbox cache, shell env, worktree setup scripts, and base
  `ToolContext` construction.
- `3394-3509`: Disabled skill/plugin lists, feature flags, memories config, and
  memory extraction client resolution.
- `3512-3521`: Builtin tool to feature-flag map.

## Extraction Strategy

Prefer three patterns, in this order:

1. Pure functions with explicit parameters for stateless logic.
2. Small helper classes that own their own mutable state, such as steering queues or
   hook handles.
3. Narrow context interfaces for helpers that must mutate `Engine` state. Do not pass
   the entire `Engine` object except where existing public contracts require it
   (`ToolContext.engine`, MCP `connectAll(..., this)`).

Keep facade compatibility:

- `engine.ts` should continue exporting `Engine`, `EngineConfig`, `EngineHookConfig`,
  `EngineResult`, `diskDefaultsFrom`, and today's exported helper functions.
- Public `Engine` methods can become one-line delegates, but their signatures should
  remain stable.
- Tests can continue importing from `./engine.js` until the split is complete.

## Natural Extraction Seams

### `engine/helpers.ts`

Moves:

- `compatFileNamesFrom` (`153-161`)
- `sameLlmIdentity` (`175-184`) if aux/model code is not moved yet; otherwise place
  it with aux-client logic.
- `resolveChildLlm` (`217-227`)
- `resolveRunCwd` (`246-253`)
- `loadAgentDefinitionsForCwd` (`255-281`)
- `NESTED_AGENT_TOOLS` (`283`)
- `applyBuiltinOverrideVisibility` (`293-299`)
- `resolveChildToolScope` (`308-322`)

Public surface:

```ts
export function compatFileNamesFrom(...): string[];
export function resolveChildLlm(...): LLMConfig;
export function resolveRunCwd(...): string;
export function loadAgentDefinitionsForCwd(...): AgentDefinitionRegistry;
export function applyBuiltinOverrideVisibility<T extends { name: string }>(...): T[];
export function resolveChildToolScope(...): { enabled?: string[]; disabled: string[] };
```

State needs: none. Pass all dependencies as params.

Risk: low. This is a pure move with re-exports from `engine.ts`.

### `engine/steering-runtime.ts`

Moves:

- `steerQueueBySid` field (`409`)
- `enqueueSteer` (`830-862`)
- `unsteer` (`869-875`)
- `consumeSteer` (`878-897`)

Public surface:

```ts
export class EngineSteeringRuntime {
  enqueueSteer(sessionId: string, text: string, id?: string, clientMessageId?: string): EnqueueSteerResult;
  unsteer(sessionId: string, id: string): boolean;
  consumeSteer(sessionId: string, source?: "normal_step" | "finalize_backfill"): SteerItem[];
}
```

Engine facade:

- Keep `Engine.enqueueSteer(...)`, `Engine.unsteer(...)`, and the private turn-loop
  callback delegating to `this.steering`.

State needed:

- `activeRunSession?.state.sessionId` (`839`)
- `activeTurnLoop !== null` (`840`)
- queue map, owned by `EngineSteeringRuntime`

Pass as callbacks, not as a shared mega-context:

```ts
new EngineSteeringRuntime({
  activeRunSessionId: () => this.activeRunSession?.state.sessionId,
  hasActiveTurnLoop: () => this.activeTurnLoop !== null,
});
```

Risk: low. It touches in-flight steering but only moves queue ownership and delegates
the public API.

### `engine/hook-wiring.ts`

Moves:

- `settingsHookHandles` field (`344`)
- `emitHook` (`489-497`)
- `registerSettingsHooks` (`506-529`)
- `reloadHooks` (`543-570`)
- Plugin/settings hook registration portions of the constructor (`609-632`) can move
  after the initial helper class exists.

Public surface:

```ts
export class EngineHookWiring {
  emit(event: HookEventName, data?: Record<string, unknown>): Promise<HookResult>;
  registerSettingsHooks(): void;
  reloadHooks(): void;
  registerConfiguredHooks(hooks?: EngineHookConfig[]): void;
}
```

State needed:

- `hooks`
- `config.isSubAgent`
- settings hook handles, owned by the helper
- `getSettingsManager()`
- `readDisabledLists()` for plugin-hook reload

Pass via constructor:

```ts
new EngineHookWiring({
  hooks: this.hooks,
  isSubAgent: () => this.config.isSubAgent === true,
  getSettingsManager: () => this.getSettingsManager(),
  readDisabledLists: () => this.readDisabledLists(),
});
```

Risk: low to medium. The main risk is preserving hook order and reload semantics:
plugin hooks priority 80, settings hooks priority 50, config/SDK hooks default
priority (`609-632`), and reload removing only tracked settings handlers plus
`plugin:` handlers (`543-570`).

### `engine/model-selection.ts`

Moves:

- `populateModelPoolFromSettings` (`648-743`)
- `reloadModelPool` (`751-759`)
- `autoPopulatePool` (`766-783`)
- `switchModel` (`2570-2579`)
- `persistActiveModel` (`2613-2662`)
- Optionally keep simple accessors in `Engine` (`2665-2671`) as delegates.

Public surface:

```ts
export function populateModelPoolFromSettings(ctx: ModelSelectionContext): void;
export function reloadModelPool(ctx: ModelSelectionContext): void;
export function switchModel(ctx: ModelSelectionContext, key: string): ModelEntry;
```

Context:

```ts
interface ModelSelectionContext {
  runtime: EngineRuntime | null;
  modelPool: ModelPool;
  getConfig(): EngineConfig;
  setConfig(next: EngineConfig): void;
  getSettingsManager(): SettingsManager;
}
```

State needed:

- `runtime`
- `modelPool`
- mutable `config.llm` and `config.clientDefaults`
- settings manager

Risk: medium. This mutates `this.config`, reads disk settings, writes
`~/.code-shell/settings.json`, and is covered by model persistence tests.

### `engine/settings-access.ts`

Moves:

- `settingsManager` field (`366`)
- `agentDefsCache` field (`353`)
- `getSettingsManager` (`2936-2945`)
- `updateConfig` / `readSetting` (`2947-2967`)
- `getAgentDefinitions` (`3182-3194`)
- `readDisabledAgents` (`3205-3217`)
- `readBuiltinOverride` (`3226-3235`)
- `readDisabledLists` and `getEffectiveDisabledLists` (`3405-3428`)
- `readFeatureFlags` and `getFeatureFlags` (`3435-3455`)
- `readMemoriesConfig` (`3462-3478`)

Public surface:

```ts
export class EngineSettingsAccess {
  getSettingsManager(): SettingsManager;
  updateConfig(key: string, value: unknown): void;
  readSetting(key: string): unknown;
  getAgentDefinitions(cwd: string): AgentDefinitionRegistry;
  readDisabledLists(): { disabledSkills: string[]; disabledPlugins: string[]; disabledPluginHooks: string[] };
  getEffectiveDisabledLists(): { disabledSkills: string[]; disabledPlugins: string[] };
  readBuiltinOverride(cwd?: string): Record<string, CapabilityOverride> | undefined;
  readFeatureFlags(): FeatureFlagOverrides | undefined;
  getFeatureFlags(): Record<FeatureFlagName, boolean>;
  readMemoriesConfig(): MemoriesConfig | undefined;
}
```

State needed:

- `config.cwd`
- `config.settingsScope`
- `config.projectTrusted`
- `config.isSubAgent`
- internal cached `SettingsManager`
- internal cached agent definitions

Pass `getConfig()` into the constructor so hot-reloaded config is seen without
rebuilding the helper.

Risk: medium. This is a broad read-only settings split, but it affects tool
visibility, prompt composition, plugin filtering, feature flags, memory extraction,
and tests around no-repo whitelist and shell env.

### `engine/tool-context.ts`

Moves:

- `resolveSandboxWithoutRuntime` (`3242-3259`)
- `readShellEnv` (`3291-3325`)
- `filterSubagentEnv` (`3334-3336`)
- `readWorktreeSetupScripts` (`3345-3359`)
- `buildToolContext` (`3361-3392`)
- Possibly `resolveMaxContextTokens` and `resolveContextRatios` (`440-481`) if the
  module also owns per-run context-manager creation.

Public surface:

```ts
export class EngineToolContextFactory {
  resolveSandboxWithoutRuntime(config: SandboxConfig, cwd: string): Promise<SandboxBackend>;
  readShellEnv(cwd?: string): Record<string, string> | undefined;
  readWorktreeSetupScripts(cwd?: string): SetupScripts | undefined;
  buildToolContext(engine: Engine): ToolContext;
}
```

State needed:

- `sandboxCache`, owned by this helper if moved
- `config` values for cwd, llm, askUser, browser bridge, credential injection,
  sub-agent status, settings scope, skill allowlist, background shell permission
- `modelPool`, `toolRegistry`, `hooks`
- `planMode`, `permissionMode`
- settings access for env and disabled lists
- `engine` reference only for `ToolContext.engine`

Risk: medium. This is a good cohesive extraction, but `ToolContext` is a cross-cutting
contract used by tools, tests, and dream consolidation.

### `engine/permission-mode.ts`

Moves:

- `activePermission` field (`410`) can remain in `Engine` initially, then be owned
  by a helper later.
- `buildPermissionConfig` (`2969-3044`)
- `setPermissionMode` (`3052-3061`)
- `getPermissionMode` (`3063-3065`)
- `getPermissionRules` (`3091-3094`)
- `setPlanMode` (`3100-3109`)

Public surface:

```ts
export class EnginePermissionMode {
  buildPermissionConfig(mode: EngineConfig["permissionMode"], cwd: string): PermissionBuildResult;
  setPermissionMode(mode: NonNullable<EngineConfig["permissionMode"]>): void;
  getPermissionMode(): NonNullable<EngineConfig["permissionMode"]>;
  getPermissionRules(): PermissionRule[];
  setPlanMode(value: boolean): void;
  setActivePermission(permission: PermissionClassifier | undefined): void;
}
```

State needed:

- mutable `config.permissionMode`
- `preset.defaultPermissionRules`
- `config.settingsScope`, `config.projectTrusted`, `config.approvalBackend`
- `activePermission`
- `permissionMode` and `planMode` public fields, unless those are converted to
  accessors in a separate PR

Risk: medium. The sensitive behavior is live reconfiguration of an in-flight
`PermissionClassifier` (`3056-3059`) and keeping `permissionMode` and `planMode`
consistent.

### `engine/auxiliary-work.ts`

Moves:

- `auxClientCache` field (`374-377`)
- `buildSummarizeFn` (`2369-2389`)
- `resolveAuxClient` (`2391-2446`)
- `runMemoryPipeline` (`2448-2516`)
- `runDreamLoop` (`2534-2555`)
- `resolveExtractionClient` (`3486-3509`)

Public surface:

```ts
export class EngineAuxiliaryWork {
  buildSummarizeFn(client: LLMClient, recordUsage?: (usage: TokenUsage) => CumulativeUsageCounters): SummarizeFn;
  resolveAuxClient(fallback: LLMClient): Promise<LLMClient>;
  runMemoryPipeline(transcript: Transcript, sessionId: string, cwd: string, primaryClient: LLMClient): Promise<void>;
  resolveExtractionClient(primaryClient: LLMClient): Promise<LLMClient>;
}
```

State needed:

- `modelPool`
- mutable aux client cache, owned by helper
- `config.llm` and `config.clientDefaults`
- settings access for defaults and memories
- `toolRegistry`
- `buildToolContext()` for dream consolidation

Risk: medium. These paths are best-effort/background, but they share client identity
and usage/cost decisions with compaction and session summaries.

### `engine/session-actions.ts` and `engine/context-compaction.ts`

Moves:

- `resetSessionUsage` (`2585-2603`)
- `getGoal` (`2786-2788`)
- `clearGoal` (`2799-2826`)
- `injectContext` (`2828-2839`)
- `forceCompact` (`2845-2927`)
- `stripUserContextMessage` (`2929-2934`) can move with compaction or run finalization.

Public surface:

```ts
export class EngineSessionActions {
  resetSessionUsage(sessionId: string): void;
  getGoal(sessionId: string): GoalConfig | undefined;
  clearGoal(sessionId: string): boolean;
  injectContext(sessionId: string, content: string): void;
}

export async function forceCompact(ctx: ForceCompactContext, sessionId?: string): Promise<ForceCompactResult>;
```

State needed:

- `sessionManager`
- `activeRunSession`
- `activeGoalHook`
- `hooks`
- `lastSessionId`
- `compactedMessagesBySession`
- `lastContextManager`
- `lastMessages`
- context ratio/max-token helpers
- summarizer helper
- mutable session state persistence

Risk: medium to high. `clearGoal` intentionally fixes an in-flight stale-write race
(`421-433`, `2799-2826`), and `forceCompact` shares state with automatic compaction.

### `engine/run-preflight.ts`

Moves from `run()`:

- cwd/session-cwd resolution (`956-970`)
- stream wrapper for todo/goal progress (`972-998`)
- image parsing and policy (`999-1110`)
- noise rejection (`1112-1126`)
- attached image path hints and user message content construction (`1329-1368`)

Public surface:

```ts
export async function prepareRunInput(args: PrepareRunInputArgs): Promise<
  | { ok: true; cwd: string; taskText: string; parsedTask: ParsedTask; userMessageContent: string | ContentBlock[]; wrappedOnStream?: StreamCallback }
  | { ok: false; result: EngineResult }
>;
```

State needed:

- `config.cwd`, `config.llm`, `config.clientDefaults` only by value
- `sessionManager.readCwd`
- `capabilitiesFor`, image policy/compression, and `existsSync`
- stream callback and transcript append for `goal_progress`

Risk: medium. The `wrappedOnStream` closure currently refers to `session` before it
is initialized (`981-989` vs `1383`); extraction should return a wrapper factory that
accepts the resolved `SessionBundle` later, rather than preserving that temporal
coupling.

### `engine/run-session.ts`

Moves from `run()`:

- session create/resume (`1370-1490`)
- client-message idempotency (`1387-1407`)
- orphaned tool-use patching (`1414-1426`)
- cost-store restore (`1427-1430`)
- transcript append/state save (`1431-1489`)
- turn sequence and sid scoping prep (`1492-1522`)

Public surface:

```ts
export function prepareSessionForRun(args: PrepareSessionArgs): PreparedSession;
```

State needed:

- `sessionManager`
- `compactedMessagesBySession`
- `config.llm`, `config.origin`, `config.isSubAgent`, `config.costStore`
- current parent sid via `getCurrentSid`
- `setCurrentSid` stays in orchestration unless the whole run is moved

Risk: medium. This code owns idempotency, transcript mutation, and state status.

### `engine/run-turn-setup.ts`

Moves from `run()`:

- session/user-prompt hooks and context seed (`1523-1617`)
- LLM client promise, permissions, executor/guards (`1619-1659`)
- context manager and prompt composer (`1660-1691`)
- MCP connection (`1693-1706`)
- tool visibility and dynamic definitions (`1708-1818`)
- prompt message assembly and model facade setup (`1819-1930`)

Public surface:

```ts
export async function prepareTurnLoop(args: PrepareTurnLoopArgs): Promise<PreparedTurnLoopInputs>;
```

State needed:

- `hooks`
- hook emitter
- settings access
- permission helper
- tool registry
- MCP manager getter/setter
- runtime
- model pool
- config/preset/plan mode
- context caches (`ctxSeedSent`, `ctxOverheadBySid`, `lastContextManager`,
  `lastSessionId`, `lastMessages`)
- aux helper

Risk: high. This is the densest portion of `run()` and should happen only after the
lower-risk modules exist.

### `engine/run-goal.ts`

Moves from `run()`:

- active-goal normalization/persistence (`1979-2019`)
- goal stop hook creation/registration (`2020-2046`)
- persisted-goal clear callback used by `TurnLoop` (`2079-2092`)
- `extendGoalRun` can remain a delegating `Engine` method over `activeTurnLoop`
  (`3072-3081`).

Public surface:

```ts
export function setupGoalForRun(args: SetupGoalForRunArgs): GoalRunState;
```

State needed:

- `sessionManager`
- `hooks`
- active goal hook setter/getter
- `config.goal`, `config.maxTurns`, `config.maxStopBlocks`, `config.isSubAgent`
- aux summary client
- stream callback

Risk: medium to high because event ordering and mid-run `clearGoal` behavior are
load-bearing.

### `engine/run-finalize.ts`

Moves from `run()`:

- file-history hook setup/cleanup (`1932-1970`, `2241-2243`)
- headless background-agent drain (`2174-2232`) plus wait utilities (`3111-3175`)
- post-run message cache/logging/hooks/memory/title/state save/result (`2245-2349`)

Public surface:

```ts
export async function runTurnLoopAndFinalize(args: RunFinalizeArgs): Promise<EngineResult>;
export function waitForBackgroundAgentChange(...): Promise<boolean>;
export function waitForBackgroundAgentChangeOrTimeout(...): Promise<boolean>;
```

State needed:

- active turn loop/session setters
- hooks
- session manager
- compacted message cache
- memory and title helpers
- cost store
- `isHeadless`
- `stripUserContextMessage`

Risk: high. It controls cleanup ordering and externally visible terminal events.

## Ordered PR Plan

Each PR should leave `engine.ts` compiling and keep the public facade stable.

### PR 1: Move Pure Exported Helpers

Type: pure move.

Create `packages/core/src/engine/helpers.ts` and move the stateless top-level helpers
from `153-322`. Re-export them from `engine.ts`; import them back into `engine.ts`
for internal use.

Verification:

- `bun test packages/core/src/engine/__tests__/compat-filenames.test.ts`
- `bun test packages/core/src/engine/engine.resolve-cwd.test.ts`
- `bun test packages/core/src/engine/engine.agent-precedence.test.ts`
- `bun test packages/core/src/engine/resolve-child-tool-scope.test.ts`
- `bun test packages/core/src/engine/__tests__/builtin-override-per-turn.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: low.

### PR 2: Extract Engine-Level Steering Runtime

Type: introduces a small helper class; Engine public methods delegate.

Create `engine/steering-runtime.ts`, move the queue map and methods from `830-897`,
and construct the helper in `Engine` with callbacks for the active session/turn-loop
state. Keep `Engine.enqueueSteer` and `Engine.unsteer` signatures unchanged. The
`TurnLoop` dependency at `2075` should call `this.steering.consumeSteer(...)`.

Verification:

- `bun test packages/core/src/engine/steer-queue.test.ts`
- `bun test packages/core/src/engine/engine-steer-idle.test.ts`
- `bun test packages/core/src/engine/turn-loop-steer-backfill.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: low.

### PR 3: Extract Hook Wiring

Type: introduces a small helper class and moves owned mutable hook-handle state.

Create `engine/hook-wiring.ts`. Move `emitHook`, `registerSettingsHooks`, and
`reloadHooks` from `489-570`, then move constructor hook registration from
`609-632` into helper calls. Keep `Engine.getHookRegistry()` unchanged and keep a
private `emitHook(...)` delegate if that makes the run diff smaller.

Verification:

- `bun test packages/core/src/engine/__tests__/engine-config-hot-reload.test.ts`
- `bun test packages/core/src/plugins/loadPluginHooks.test.ts`
- `bun test packages/core/src/plugins/pluginCommandHook.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: low to medium.

### PR 4: Extract Model Selection and Persistence

Type: context interface for mutable config and model pool.

Create `engine/model-selection.ts`. Move model-pool population/reload/autopopulate
from `648-783` and switch/persist logic from `2570-2662`. Keep `Engine.switchModel`,
`Engine.reloadModelPool`, `Engine.getModelPool`, and `Engine.getCurrentModel` as
facade methods. Use a narrow `getConfig`/`setConfig` context so the helper can update
`config.llm` and `config.clientDefaults`.

Verification:

- `bun test packages/core/src/engine/persist-active-model.test.ts`
- `bun test packages/core/src/engine/engine.persist-model-mode.test.ts`
- `bun test packages/core/src/engine/model-connections-pool.test.ts`
- `bun test packages/core/src/engine/__tests__/aux-client-per-session-key.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: medium.

### PR 5: Extract Settings Access and Tool Context Factory

Type: helper classes with narrow context interfaces.

Create `engine/settings-access.ts` for `2936-2967`, `3182-3235`, and `3405-3478`.
Create `engine/tool-context.ts` for `3242-3392`. The settings helper should own the
cached `SettingsManager` and agent definition cache. The tool-context helper should
own the sandbox cache if `resolveSandboxWithoutRuntime` moves.

Keep `Engine.buildToolContext`, `Engine.readWorktreeSetupScripts`,
`Engine.getEffectiveDisabledLists`, and `Engine.getFeatureFlags` as delegates.

Verification:

- `bun test packages/core/src/engine/engine.shell-env.test.ts`
- `bun test packages/core/src/engine/engine.no-repo-whitelist.test.ts`
- `bun test packages/core/src/engine/__tests__/builtin-override-removes-tool.test.ts`
- `bun test packages/core/src/engine/dynamic-tool-defs.test.ts`
- `bun test packages/core/src/tool-system/__tests__/disabled-builtin-execution-gate.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: medium.

### PR 6: Extract Permission Mode Runtime

Type: helper class with mutable active-permission/config access.

Create `engine/permission-mode.ts` and move `2969-3109`. Keep public methods on
`Engine` as delegates. During `run()`, after constructing the `PermissionClassifier`
at `1628`, call a helper setter so later `setPermissionMode` can reconfigure it.
Decide in this PR whether `Engine.permissionMode` and `Engine.planMode` remain public
fields mirrored by the helper, or become accessors in a separate compatibility PR.

Verification:

- `bun test packages/core/src/engine/engine.permission-rules.test.ts`
- `bun test packages/core/src/tool-system/plan-mode.test.ts`
- `bun test packages/core/src/run/engine-runner-approval.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: medium.

### PR 7: Extract Auxiliary Work and Session Actions

Type: helper classes plus one shared compaction function.

Create `engine/auxiliary-work.ts` and move `2369-2555` plus `3486-3509`. Then create
`engine/session-actions.ts` / `engine/context-compaction.ts` for `2585-2603` and
`2786-2927`. Keep facade methods on `Engine`.

This PR should be split into two commits inside the PR:

1. Auxiliary work first (`buildSummarizeFn`, aux client, memory/dream/extraction).
2. Session actions and `forceCompact` after the shared summarizer helper exists.

Verification:

- `bun test packages/core/src/engine/engine.force-compact.test.ts`
- `bun test packages/core/src/engine/session-usage.test.ts`
- `bun test packages/core/src/engine/cache-hit-rate.test.ts`
- `bun test packages/core/src/engine/goal.test.ts`
- `bun test packages/core/src/engine/__tests__/aux-client-per-session-key.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: medium to high.

### PR 8: Carve `run()` Into Run Modules, Then Delegate

Type: introduces run context interfaces; highest-risk step.

Do this in small commits while keeping every commit compiling:

1. `engine/run-preflight.ts`: move preflight/image/noise/user-content logic from
   `956-1126` and `1329-1368`.
2. `engine/run-session.ts`: move session create/resume/idempotency from
   `1370-1522`.
3. `engine/run-goal.ts`: move goal setup from `1979-2046` and the goal clear callback
   construction from `2079-2092`.
4. `engine/run-finalize.ts`: move background-agent waits, headless drain, cleanup,
   and post-run finalization from `2170-2349` and `3111-3175`.
5. `engine/run-turn-setup.ts`: move the densest turn setup from `1523-1930` only after
   the earlier commits have reduced the context surface.
6. Optionally move the remaining orchestration into `engine/run-orchestration.ts`,
   leaving `Engine.run(...)` as:

```ts
async run(task: string, options?: RunOptions): Promise<EngineResult> {
  return runEngine(this.runContext(), task, options);
}
```

Recommended context shape:

```ts
interface EngineRunContext {
  getConfig(): EngineConfig;
  setConfig(next: EngineConfig): void;
  preset(): AgentPreset;
  hooks(): HookRegistry;
  sessionManager(): SessionManager;
  toolRegistry(): ToolRegistry;
  modelPool(): ModelPool;
  runtime(): EngineRuntime | null;
  settings: EngineSettingsAccess;
  steering: EngineSteeringRuntime;
  hookWiring: EngineHookWiring;
  permissions: EnginePermissionMode;
  toolContextFactory: EngineToolContextFactory;
  auxiliary: EngineAuxiliaryWork;
  setActiveTurnLoop(loop: TurnLoop | null): void;
  setActiveRunSession(session: SessionBundle | null): void;
  setActiveGoalHook(hook: ReturnType<typeof createGoalStopHook> | null): void;
  getActiveGoalHook(): ReturnType<typeof createGoalStopHook> | null;
  contextCaches: {
    ctxSeedSent: Set<string>;
    ctxOverheadBySid: Map<string, number>;
    compactedMessagesBySession: Map<string, Message[]>;
    getLastContextManager(): ContextManager | undefined;
    setLastContextManager(manager: ContextManager | undefined): void;
    getLastSessionId(): string | undefined;
    setLastSessionId(sid: string | undefined): void;
    setLastMessages(messages: Message[] | undefined): void;
  };
}
```

Verification:

- Focused run tests first:
  - `bun test packages/core/src/engine/engine-client-message-id.test.ts`
  - `bun test packages/core/src/engine/engine.force-compact.test.ts`
  - `bun test packages/core/src/engine/engine-steer-idle.test.ts`
  - `bun test packages/core/src/engine/engine.session-title.test.ts`
  - `bun test packages/core/src/engine/engine.resolve-cwd.test.ts`
  - `bun test packages/core/src/engine/turn-loop*.test.ts`
- Protocol smoke around Engine facade:
  - `bun test packages/core/src/protocol/server.compact.test.ts`
  - `bun test packages/core/src/protocol/server.reload-settings.test.ts`
  - `bun test packages/core/src/protocol/server.steer.test.ts`
- `bun run --filter '@cjhyy/code-shell-core' build`

Risk: high. This is where event ordering and shared mutable state are most likely to
regress.

## Things That Make a Clean Split Hard

- `run()` uses closure ordering that is easy to break. The `wrappedOnStream` defined
  at `981-996` writes to `session.transcript`, but `session` is declared and assigned
  later at `1383-1490`. Extracting preflight should return a callback factory that is
  bound after session resolution.
- Sub-agent spawning is tightly coupled to the parent run. The closure at
  `1128-1247` captures `session`, `options`, `cwd`, parent config, model pool, and
  session manager, and it constructs a child `Engine`. Moving this too early can
  introduce an implementation import cycle unless child-engine construction is passed
  in as a callback.
- Goal state has deliberate in-flight race protection. `activeGoalHook` and
  `activeRunSession` (`421-433`) coordinate with goal setup (`1979-2046`), run cleanup
  (`2235-2240`), and `clearGoal` (`2799-2826`). Any helper must preserve the exact
  live-bundle clearing behavior.
- Hook ordering is observable. Constructor registration (`609-632`) and reload
  (`543-570`) preserve plugin/settings/config priorities and remove handlers by
  identity/name prefix. Extract hook wiring before moving run hooks.
- Compaction state is shared by automatic and manual paths. `lastContextManager`,
  `lastMessages`, `lastSessionId`, and `compactedMessagesBySession` are written in
  `run()` (`1853-1858`, `2245-2249`) and `forceCompact` (`2864-2921`). Moving one
  side without the other can desynchronize `/compact`.
- Tool visibility is assembled from several independently hot-reloaded sources:
  builtin overrides (`1747-1760`), MCP server allow-list (`1771-1783`), builtin guards
  (`1795-1798`), feature flags (`1789-1802`), dynamic tool defs (`1803-1808`), and
  plan mode (`1810-1817`). Keep this as one helper once extracted.
- `config` is mutated in many places: model pool population (`697-700`, `738`),
  auto-populate (`778-781`), `switchModel` (`2575-2576`), hot reload (`2725`), and
  permission mode (`3053`). Use explicit `getConfig`/`setConfig`, not copied config
  snapshots, for helpers that can run after hot reload.
- `ToolContext.engine = this` (`3381`) is an intentional public escape hatch used by
  tools. `buildToolContext` can move, but it still needs the Engine facade reference.
- Event order matters for clients: `recordSessionStart` and session hooks
  (`1522-1560`), `session_started` (`1599-1603`), `on_agent_start` (`1972-1977`),
  turn loop, `on_session_end` (`2263-2271`), memory/title fire-and-forget
  (`2273-2311`), final state save (`2313-2326`), `on_agent_end` (`2328-2333`), and
  `turn_complete` (`2335-2336`) should not be rearranged.

## Recommended First Two Steps

1. PR 1, `engine/helpers.ts`: lowest-risk pure move. It immediately removes the
   stateless helper block and proves the facade re-export pattern.
2. PR 2, `engine/steering-runtime.ts`: still low risk, but it exercises the first
   state-owning helper pattern on a small, well-tested area before touching hooks,
   settings, or `run()` orchestration.
