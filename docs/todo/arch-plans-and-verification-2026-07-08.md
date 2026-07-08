# Architecture Plans and Verification - 2026-07-08

Scope: this is a read-only verification and planning pass. Source code was not changed.
This document intentionally does not reopen known by-design decisions: `CLAUDE_PLUGIN_ROOT`
to `CODESHELL_PLUGIN_ROOT` rewriting, browser account-switch retaining non-cookie
localStorage, and tunnel non-reconnect behavior.

## NEEDS-VERIFICATION resolutions

### 1. `@cjhyy/code-shell-cdp` publishability

Verdict: REAL BUG.

The package is clearly intended to be public:

- `packages/cdp/package.json:2-4` names `@cjhyy/code-shell-cdp` and describes it as a standalone CDP action layer.
- `packages/cdp/package.json:14-20` ships `dist` and has its own build script.
- `packages/cdp/package.json:38-40` sets `publishConfig.access = public`.
- `packages/cdp/README.md:7-13` documents `npm install @cjhyy/code-shell-cdp` and `bun add @cjhyy/code-shell-cdp`.
- `docs/architecture/00-overview.md:35` says `packages/cdp/` publishes `@cjhyy/code-shell-cdp`.
- `scripts/release.ts:42-48` includes `packages/cdp/package.json` in the version bump set.
- `.github/workflows/release.yml:45-51` includes `packages/cdp/package.json` in the tag/version verification gate.

The actual release workflow does not publish it:

- Root `package.json:19` builds only core, TUI, and the root meta package.
- `.github/workflows/release.yml:81-85` runs that root build in the npm publish job.
- `.github/workflows/release.yml:90-113` documents and performs publish order `core -> tui -> meta`; there is no `bun publish --cwd packages/cdp`.

Registry evidence confirms the package is absent while the other release packages exist at the current rc:

- `npm view @cjhyy/code-shell-cdp version dist-tags --json` exited with `E404 Not Found`.
- `npm view @cjhyy/code-shell version dist-tags --json` returned `next: 0.6.0-rc.14`.
- `npm view @cjhyy/code-shell-core version dist-tags --json` and `npm view @cjhyy/code-shell-tui version dist-tags --json` also returned `next: 0.6.0-rc.14`.

Concrete fix:

1. Add the CDP package build to the release publish job before publishing.
2. Publish `packages/cdp` with the same dist-tag policy as the other release packages.
3. Update the workflow comments from `core -> tui -> meta` to include CDP. CDP has no runtime dependency on the other packages, so it can publish either before or after them.
4. Extend the release workflow unit/static coverage in `packages/core/src/release-workflow.test.ts` so it asserts that any package included in version verification is also built and published, or explicitly marked non-npm.

### 2. Printable CDP `pressKey()` text payload

Verdict: REAL BUG.

Static evidence:

- `packages/cdp/src/keymap.ts:134-142` defines `KeyEvent` without `text` or `unmodifiedText`.
- `packages/cdp/src/keymap.ts:160-168` emits only key, code, virtual key code, native virtual key code, and modifiers.
- `packages/cdp/src/keymap.ts:171-172` plans printable no-modifier keys as only `keyDown` and `keyUp`.
- `packages/cdp/src/driver.ts:213-220` sends those planned events directly as `Input.dispatchKeyEvent`.
- `packages/cdp/src/driver.ts:145-164` proves the package already uses `Input.insertText` for `typeNode`, so text insertion is available through CDP.
- Existing `packages/cdp/src/driver.test.ts:147-160` covers a shortcut sequence (`Control+a`) but does not assert that printable `pressKey("a")` inserts text.

Runtime repro evidence:

- A temporary script under `/tmp` launched Chromium through Playwright, focused an `<input>`, imported the current `CdpActionsDriver` from `packages/cdp/src/driver.ts`, then called `pressKey()` through a raw CDP session.
- Results:
  - `pressKey("a")` returned `{ ok: true }` and left the input value `""`.
  - `pressKey("A")` returned `{ ok: true }` and left the input value `""`.
  - `pressKey("1")` returned `{ ok: true }` and left the input value `""`.
  - `pressKey("-")` returned `{ ok: true }` and left the input value `""`.
  - `pressKey("Space")` returned `{ ok: true }` and left the input value `""`.
  - `Control+a` followed by `Backspace` did remove an existing value, so shortcut/control-key behavior still works.
- The scratch script was deleted after running; no `/tmp/codeshell-presskey-repro-*.ts` files remain.

Concrete fix:

1. Extend `KeyEvent` with optional `text` and `unmodifiedText`.
2. For printable, no-control keys, emit `text` and `unmodifiedText` on the `keyDown` event, matching Chromium CDP `Input.dispatchKeyEvent` semantics. Do not add text for pure modifiers, arrows, Enter, Tab, Escape, Backspace/Delete, or shortcuts with Control/Meta/Alt.
3. Add a unit test that `planKeySequence("a")`, `planKeySequence("1")`, and `planKeySequence("Space")` include text payloads on `keyDown`.
4. Add a CDP integration-style test or targeted smoke script that focuses an input and proves `pressKey("a")` inserts text while `Control+a` remains a shortcut sequence.

## Architectural implementation plans

### 1. Split `engine.ts` and keep the core/tool-system/engine cycle broken

Status: OPEN, with prerequisites already completed.

Current state:

- `packages/core/src/engine/engine.ts` is still 3,567 lines.
- `packages/core/src/engine/types.ts` is already extracted and owns `EngineConfig`, `EngineHookConfig`, and `EngineResult` at `packages/core/src/engine/types.ts:26-176`.
- `packages/core/src/engine/engine.ts:191-192` re-exports and imports those types, preserving the public barrel surface.
- The old type-level cycle is already broken: `packages/core/src/tool-system/context.ts:32-47` defines `ToolRuntimeHost`, and `packages/core/src/tool-system/context.ts:251-255` exposes `ToolContext.engine` as that narrow host instead of importing concrete `Engine`.
- `packages/core/src/engine/engine.ts:324-433` still mixes config, runtime state, steering queues, context state, hooks, tool context assembly, sessions, memory, sub-agents, slash/session actions, and run orchestration.
- `packages/core/src/engine/engine.ts:2062-2175` constructs and runs `TurnLoop`, making it the highest-value extraction boundary.

Change plan:

1. Freeze the cycle guard before moving code.
   - Add an import-boundary test or lint assertion that `tool-system/context.ts` cannot import `engine/engine.ts`.
   - Keep `EngineConfig`, `EngineHookConfig`, and `EngineResult` exported from `engine/types.ts`; do not move them back into `engine.ts`.
2. Extract pure helper blocks first.
   - Move standalone helpers and small structs from the top and bottom of `engine.ts` into focused files under `packages/core/src/engine/`, for example `config.ts`, `permissions.ts`, `usage.ts`, `sessions.ts`, and `tool-context.ts`.
   - Keep exports package-internal unless already public through `packages/core/src/index.ts`.
   - Run targeted tests after each file move.
3. Extract steering state into an `EngineSteeringRuntime`.
   - Move `steerQueueBySid`, `enqueueSteer`, `unsteer`, and `consumeSteer` out of `Engine`.
   - Keep the external Engine API stable by delegating `Engine.enqueueSteer()` and `Engine.unsteer()` to the runtime.
   - This should be done before or together with the steering boundary rearchitecture below.
4. Extract run construction into a `RunSessionBuilder` or `EngineRunCoordinator`.
   - Inputs: `EngineConfig`, `SessionManager`, `ToolRegistry`, prompt/system context builders, `ContextManager`, hooks, current settings.
   - Output: a configured `TurnLoop` plus any cleanup callbacks and usage/session state closures.
   - Do not move `TurnLoop` behavior into this class; it should only assemble dependencies and lifecycle wiring.
5. Extract model selection and model facade wiring.
   - Isolate active model pool resolution, fallback/continuation facade setup, and `ModelUsageFacade` baseline folding.
   - Keep `Engine.setModelByKey()` and model config mutation on `Engine`, but make them delegate to a smaller model runtime.
6. Extract session actions.
   - Move `clearSession`, `deleteSession`, `forceCompact`, `injectContext`, `setPermissionMode`, and similar non-run APIs into small service modules used by `Engine`.
   - Preserve API signatures on `Engine` for compatibility.
7. Only after the above, thin `engine.ts` down to the public facade.
   - `Engine` should own public API compatibility, dependency construction, and delegation.
   - Avoid a broad semantic rewrite in the split PRs.

Blast radius and risk:

- High blast radius because every host uses `Engine.run()` and many tests import `Engine`.
- Main risk is changing run lifecycle ordering, stream events, hook timing, or session state persistence while moving code.
- Secondary risk is accidentally reintroducing `core -> tool-system -> engine` imports by placing shared types in the wrong module.

Existing coverage:

- Engine run behavior and stream/event coverage spread across `packages/core/src/engine/*.test.ts`.
- Steering-specific tests: `packages/core/src/engine/steer-queue.test.ts`, `packages/core/src/engine/turn-loop-steer-backfill.test.ts`, and `packages/core/src/engine/engine-steer-idle.test.ts`.
- Context and usage coverage: `packages/core/src/context/*.test.ts` and `packages/core/src/engine/turn-loop-usage-cache.test.ts`.
- Import-cycle/debt context: `docs/todo/engine-split-plan.md` and `docs/todo/architecture-debt.md`.

New tests needed:

- A dedicated import-boundary test for `tool-system/context.ts` and `engine/types.ts`.
- Snapshot-style tests for `Engine` public exports after the split.
- Focused tests for each extracted runtime before removing the original inline implementation.
- A small integration test that runs a multi-tool turn with hooks, context compaction, usage events, and steering enabled after the facade split.

Effort/risk rating: XL / High. Do it as several mechanical PRs. Stop each PR at a behaviorally equivalent boundary.

### 2. Arena extraction: JSON utility done, optional builtin next, package move later

Status: PARTIAL. Step 1 is done; optional builtin and package extraction remain open.

Current state:

- The generic JSON helpers are already extracted: `packages/core/src/utils/json.ts:1-62`.
- Arena keeps a compatibility re-export from `packages/core/src/arena/strategies/utils.ts:43-49`.
- Non-Arena memory code now imports from the generic utility at `packages/core/src/services/memory-orchestrator.ts:19`.
- Arena is still a default builtin dependency through `packages/core/src/tool-system/builtin/index.ts:43` and `packages/core/src/tool-system/builtin/index.ts:603-613`.
- The Arena tool itself imports the Arena subsystem at `packages/core/src/tool-system/builtin/arena.ts:13-20` and exposes status/config helpers at `packages/core/src/tool-system/builtin/arena.ts:92-117`.
- `ToolRegistry` always imports `BUILTIN_TOOLS` at `packages/core/src/tool-system/registry.ts:7`, and builtin registration is only name-filtered through `builtinTools` at `packages/core/src/tool-system/registry.ts:19-54`.
- Core protocol still imports Arena status at `packages/core/src/protocol/server.ts:41` and handles `arena_status` at `packages/core/src/protocol/server.ts:1457`.
- Public core exports expose Arena directly at `packages/core/src/index.ts:282-341` and extended TUI Arena formatting at `packages/core/src/index.ts:745-755`.
- Settings/onboarding still have Arena-specific surface at `packages/core/src/settings/schema.ts:387-406` and `packages/core/src/onboarding.ts:404-419`.
- The TUI `/arena` command imports Arena from core at `packages/tui/src/cli/commands/arena.ts:14-25` and constructs it at `packages/tui/src/cli/commands/arena.ts:102-114`.

Change plan:

1. Keep `utils/json.ts` as the canonical JSON helper location.
   - Do not move it into a future Arena package.
   - Keep Arena's re-export for one release if external or in-repo callers use it.
2. Introduce optional builtin registration in core.
   - Replace the eager Arena import in `tool-system/builtin/index.ts` with a builtin module registry that can include optional modules.
   - Add a `BuiltinModule` or `CapabilityModule` shape: `id`, `tools`, optional `statusHandlers`, optional settings schema hooks, optional lifecycle hooks.
   - Make the default core registry load non-Arena builtins eagerly and Arena only when enabled by preset/config.
3. Change `ToolRegistry` from a flat `BUILTIN_TOOLS` import to module-aware registration.
   - `registerBuiltins()` should accept builtin names plus optional module ids.
   - If `Arena` is not selected by preset/config, core should not import `tool-system/builtin/arena.ts`.
4. Move `arena_status` behind the same optional module.
   - Protocol should ask the registry/module host for a status provider instead of importing `getArenaStatus` directly.
   - Preserve the current RPC response shape when Arena is enabled.
   - Return a clear disabled/unavailable status when Arena is not enabled.
5. Mark public Arena exports as experimental/internal before moving the package.
   - `docs/todo/architecture-debt.md:29` explicitly warns that Arena is a large public-looking export surface.
   - Add `@experimental` or `@internal` documentation and release notes before any package boundary change.
6. After optional builtin is stable, create `packages/arena`.
   - Move `packages/core/src/arena/**` and Arena renderers into the package.
   - Make `@cjhyy/code-shell-core` depend on it only through optional module wiring, or make hosts import it directly.
   - Decide product semantics before the move: whether `settings.arena.participants`, `arena_status`, and `/arena` remain core-supported or become extension/package features.
7. Update the TUI command.
   - Either keep `/arena` as a first-party command that imports `@cjhyy/code-shell-arena`, or hide it unless the Arena package/module is installed.
   - Keep `TERMINAL_CODING_EXTRA_TOOLS` behavior from `packages/core/src/preset/index.ts:130-136` equivalent when Arena is available.

Blast radius and risk:

- Medium-high. Arena touches tools, presets, protocol, settings, onboarding, public exports, and TUI CLI.
- Main risk is a breaking public API change from moving exports too early.
- Secondary risk is an optional module loading path that silently drops `Arena` from existing terminal-coding presets.

Existing coverage:

- `packages/core/src/utils/json.test.ts` and `packages/core/src/arena/strategies/extract-json-array.test.ts`.
- Preset/tool whitelist coverage in `packages/core/src/preset/preset-builtin-tools.test.ts`.
- Arena strategy/rendering tests under `packages/core/src/arena/**`.
- TUI command coverage around `packages/tui/src/cli/commands/arena*.test.ts`, if present.

New tests needed:

- Registry tests proving `Arena` is not imported/registered when disabled.
- Registry tests proving `Arena` is registered when terminal-coding preset enables it.
- Protocol tests for `arena_status` enabled and disabled.
- Public export compatibility tests for one release cycle.
- TUI `/arena` command tests for available and unavailable module states.

Effort/risk rating: L / Medium-high for optional builtin. XL / High for moving to a separate package.

### 3. Steer step-boundary injection rearchitecture

Status: PARTIAL. Current behavior is improved but still not a general step-boundary model.

Current state:

- `Engine` owns steering queues through `packages/core/src/engine/engine.ts:409` and methods at `packages/core/src/engine/engine.ts:836-897`.
- `TurnLoop` receives `consumeSteer` at `packages/core/src/engine/turn-loop.ts:145`, wired from `Engine` at `packages/core/src/engine/engine.ts:2078`.
- `TurnLoop` consumes steer at the top of normal turns at `packages/core/src/engine/turn-loop.ts:576`.
- It also has selected finalization backfill points at `packages/core/src/engine/turn-loop.ts:877-879`, `963-965`, `1095-1097`, `1113-1115`, `1137-1139`, and `1223`.
- The injection helper is `packages/core/src/engine/turn-loop.ts:1344-1367`; it appends a user message, transcript item, and `steer_injected` stream event.
- Continuation model calls after `max_tokens` are made inside the same turn around `packages/core/src/engine/turn-loop.ts:782-820`, without a central steer boundary before the continuation request.
- Max-turn summary is another LLM request around `packages/core/src/engine/turn-loop.ts:1216-1243`; current steer consumption before it is ad hoc rather than part of a common boundary primitive.

Desired behavior:

- Treat steer as a user message that can be consumed at every safe LLM step boundary.
- A safe boundary is before an LLM request when appending a user message will not break assistant `tool_use` to user `tool_result` adjacency.
- This should match the Codex-style model: user steering is not only a turn-top concern; it can be inserted between tool-call steps once the pending tool results have been appended.

Change plan:

1. Add a single boundary primitive inside `TurnLoop`.
   - Example: `await this.beforeModelRequest(messages, { source, allowSteer, reason })`.
   - It should perform abort checks, optional context management if needed, and steer consumption in one place.
   - It should return whether messages changed so callers can re-run context or loop as needed.
2. Classify every LLM request site.
   - Normal model call before tool selection: allow steer.
   - Post-tool next step after all tool results are appended: allow steer.
   - Continuation request after `max_tokens`: decide policy explicitly. If continuation is meant to continue the same assistant message, do not inject steer into the middle of that assistant response; instead queue it for the next step and emit a deferred reason. If the product wants steer to interrupt continuation, close the assistant message first and make the next request a new step.
   - Final/max-turn summary requests: allow steer only if it will produce a new model request that sees the steering before summarizing.
3. Preserve tool adjacency invariants.
   - Never insert a user steer message between assistant `tool_use` content and corresponding user `tool_result` content.
   - Reuse or extend the existing adjacency validation helpers at the bottom of `turn-loop.ts`.
4. Move finalization backfill into the same primitive.
   - Replace scattered `consumeQueuedSteer(messages, "finalize_backfill")` calls with one finalization path.
   - This reduces missed return branches when new stop paths are added.
5. Move queue mechanics out of `Engine` as part of the engine split.
   - `Engine` should expose public methods but delegate queue storage to `EngineSteeringRuntime`.
   - `TurnLoop` should depend on a narrow `consumeSteer` function or runtime interface, not on `Engine`.
6. Update stream/transcript semantics.
   - Keep the existing `steer_injected` event contract.
   - Add a reason/source field for deferred steering if continuation cannot safely consume it.

Blast radius and risk:

- Medium-high. This touches live run-loop ordering and model request boundaries.
- Main risk is breaking OpenAI-style tool-call adjacency, causing invalid message arrays or provider errors.
- Secondary risk is double-consuming steer across finalization loops.

Existing coverage:

- `packages/core/src/engine/steer-queue.test.ts` covers queue helpers and stream event shape.
- `packages/core/src/engine/turn-loop-steer-backfill.test.ts` covers after-tool and finalization backfill cases.
- `packages/core/src/engine/engine-steer-idle.test.ts` covers active/idle behavior and shutdown ordering.

New tests needed:

- Steer queued during tool execution is injected after all tool results and before the next model request.
- Steer queued during continuation is either deferred with an event or explicitly starts a new step, depending on the chosen policy.
- Steer queued before max-turn summary is seen by the summary model request.
- No test may produce user content between assistant tool calls and tool results.
- Duplicate client ids remain idempotent across new boundary paths.

Effort/risk rating: L / High. Implement before broad `engine.ts` movement if possible, or make it the first extracted steering-runtime PR.

### 4. Compaction token-estimation 2.5x fix: persist actual prompt-token anchors

Status: PARTIAL. The original in-run 2.5x underestimate is fixed; resume/cold-start anchoring remains open.

Current state:

- The raw fallback estimator in `packages/core/src/context/compaction.ts:21` still uses message token estimation based on message content heuristics.
- `ContextManager` now records provider usage through `packages/core/src/context/manager.ts:141-145`.
- `ContextManager.estimateTokensHybrid()` at `packages/core/src/context/manager.ts:151-169` uses the last real `promptTokens` anchor plus estimates for newly appended messages, and rescales after message shrinkage.
- `TurnLoop` records actual provider prompt tokens after model calls at `packages/core/src/engine/turn-loop.ts:732-745`.
- Tests already cover the in-run anchor: `packages/core/src/context/manager-hybrid.test.ts`, `packages/core/src/context/manager-micro-escalation.test.ts`, and `packages/core/src/engine/turn-loop-usage-cache.test.ts`.
- `Engine` still emits a rough session-start prompt estimate before the first model response at `packages/core/src/engine/engine.ts:1582-1604`.
- `SessionState` initialization at `packages/core/src/session/session-manager.ts:175` stores cumulative token usage, but there is no persisted context-estimation anchor with message count and estimator baseline.

Problem to solve:

- After process restart or session resume, `ContextManager` starts without the last actual prompt-token anchor, so pre-first-call compaction decisions can fall back to the rough estimator.
- The current fix is strong only after a provider response in the current process.

Change plan:

1. Add a small persisted context usage anchor to session state.
   - Shape: `{ promptTokens: number; messageCount: number; estimateAtAnchor?: number; recordedAt: number; provider?: string; model?: string }`.
   - Store it separately from cumulative `tokenUsage`, because cumulative totals are not a current-context size anchor.
2. Add `ContextManager.seedActualUsage(anchor)`.
   - It should set the same internal fields as `recordActualUsage()`.
   - It should validate positive finite `promptTokens` and `messageCount > 0`.
3. Persist the anchor whenever `recordActualUsage()` is called from `TurnLoop`.
   - The existing call has `response.usage.promptTokens` and the current `messages`, so it can derive `messageCount` and `estimateAtAnchor`.
   - Write through the session state path that already persists `tokenUsage`.
4. Restore the anchor before the first context-management decision on resume.
   - When constructing `ContextManager` in `Engine.run()`, seed it from session state if the anchor is compatible with the loaded message count.
   - If the current message count is less than the anchor count due to compaction or transcript edits, allow the hybrid shrink path if `estimateAtAnchor` exists; otherwise discard the anchor.
5. Stop relying on char/4 for session-start prompt display when an anchor exists.
   - The initial `session_started.promptTokens` event can use the persisted anchor as a better seed, with a flag or comment in code that it will be replaced by real provider usage after the first call.
6. Keep fallback behavior explicit.
   - If no provider usage exists, the fallback estimator remains necessary. Consider a tokenizer-backed estimate later, but do not mix that into the anchor persistence change.

Blast radius and risk:

- Medium. This changes session state serialization and early context-management behavior.
- Main risk is using a stale anchor after compaction/resume and overestimating or underestimating the live context.
- Secondary risk is confusing cumulative usage counters with current-context size.

Existing coverage:

- `packages/core/src/context/manager-hybrid.test.ts` for anchored rescaling.
- `packages/core/src/context/manager-micro-escalation.test.ts` for anchored compaction gates.
- `packages/core/src/engine/turn-loop-usage-cache.test.ts` for recording provider prompt usage.
- Session persistence tests under `packages/core/src/session/**`.

New tests needed:

- `ContextManager.seedActualUsage()` produces the same estimate path as `recordActualUsage()`.
- Session state persists and reloads the anchor.
- Resume before the first provider call uses the persisted anchor for compaction gating.
- Stale anchors are discarded or safely rescaled when message count shrinks.
- `session_started` prompt token seed prefers the anchor over char/4 when present.

Effort/risk rating: M / Medium.

### 5. Credentials partition mismatch and active browser target ownership

Status: PARTIAL. The explicit partition mismatch for credential capture/restore is fixed; the remaining live bug is global active-guest targeting for browser automation and AI cookie injection.

Current state:

- Browser panels use per-bucket partitions in `packages/desktop/src/renderer/panels/PanelArea.tsx:425-429`.
- Main validates and preserves `persist:browser:<bucket>` in `packages/desktop/src/main/index.ts:1103-1113`.
- Credential IPC now accepts a bucket and maps it to the exact browser partition at `packages/desktop/src/main/index.ts:1660-1667`.
- Capture/restore handlers pass that partition at `packages/desktop/src/main/index.ts:1669-1714`.
- Preload exposes bucket-aware credential APIs at `packages/desktop/src/preload/index.ts:837-851`.
- `CookieTab` uses `activeBucket` for current-session capture and restore at `packages/desktop/src/renderer/credentials/CookieTab.tsx:191-207` and `239-243`.
- There is also an explicit all-live-sessions capture path through `captureAllCookiesFromSessions(listGuestSessions())` at `packages/desktop/src/main/index.ts:1693-1694`.

Remaining bug:

- `packages/desktop/src/main/browser-driver/active-guest.ts:13-35` keeps a single global active `WebContents`.
- `packages/desktop/src/main/browser-driver/active-guest.ts:53-79` lists live guests and sessions without owner metadata.
- `packages/desktop/src/main/agent-bridge.ts:369-390` handles browser actions by calling `handleBrowserAction()` with global `activeGuest`, `listGuests`, and `focusGuest`.
- Browser action parsing already has `sessionId` at `packages/desktop/src/main/browser-driver/intercept.ts:15-18` and `40-43`, but the bridge does not use it for target selection.
- `packages/desktop/src/main/agent-bridge.ts:430-439` correctly resolves cookie credentials by originating session cwd, but `packages/desktop/src/main/agent-bridge.ts:453-462` injects the cookie jar into `activeGuest()?.session`.
- `packages/desktop/src/main/agent-bridge.ts:463-465` and `packages/desktop/src/main/index.ts:1715-1717` broadcast `browser:reload` to every browser panel.
- Renderer browser panels listen globally to `browser:open-tab` and `browser:reload` at `packages/desktop/src/renderer/browser/useBrowserTabs.ts:280-290`.

Change plan:

1. Add owner metadata to browser guests.
   - Extend `active-guest.ts` from `Set<WebContents>` to a registry keyed by `webContents.id`.
   - Track `{ guest, partition, bucket, engineSessionId?, panelId?, lastFocusedAt }`.
   - Keep global `activeGuest()` temporarily for legacy callers, but add `guestForSession(sessionId)` and `guestForBucket(bucket)`.
2. Teach the renderer to register guest ownership.
   - Extend `WebviewElement` typing with `getWebContentsId()`.
   - In `BrowserPanel` or `useBrowserTabs`, after `dom-ready` or when the webview ref is available, send an IPC event with `guestId`, frozen `partition`, `bucket`, and `engineSessionId`.
   - `PanelArea` already receives `bucket` and `engineSessionId` at `packages/desktop/src/renderer/panels/PanelArea.tsx:405-416`; pass those into `BrowserPanel`.
3. Use parsed `sessionId` for browser automation routing.
   - In `AgentBridge.maybeHandleBrowserAction()`, resolve target with `guestForSession(parsed.sessionId)` first.
   - Fall back to an explicitly focused guest only when no session id is present, and include a diagnostic in the result when falling back.
   - Update `listTabs` and `switchTab` to be scoped to the originating session unless the request is explicitly cross-session.
4. Use parsed `sessionId` for AI cookie injection routing.
   - In `maybeHandleCredentialAction()`, after resolving credential by session cwd, restore cookies into `guestForSession(parsed.sessionId)?.session`.
   - If no guest exists for that session, restore into `browserPartitionForBucket(sessionBucket)` if derivable, or return a clear error instead of mutating the global active guest.
5. Scope browser open/reload IPC.
   - Add payload fields: `{ bucket?, engineSessionId?, guestId?, url? }`.
   - Renderer listeners should ignore events not matching their current panel.
   - Replace all-window broadcast reloads with targeted reload events for the affected bucket/session.
6. Add teardown.
   - When a webview is destroyed, remove its metadata.
   - When an agent session closes, remove or mark ownership metadata so stale sessions do not capture future browser actions.

Blast radius and risk:

- Medium-high in desktop only. Browser automation, cookie injection, browser tabs, and credential account-switch are all affected.
- Main risk is breaking legacy popout/shared browser behavior that still defaults to `persist:browser`.
- Secondary risk is races: webview attach happens before renderer ownership metadata arrives.

Existing coverage:

- Pure intercept tests in `packages/desktop/src/main/browser-driver/intercept.test.ts`.
- Credential partition tests, if present, around `credentials-service`.
- Renderer credential tests around `CookieTab`.
- Browser tab/panel tests around `useBrowserTabs`.

New tests needed:

- `active-guest` unit tests for owner registration, focus ordering, lookup by session, lookup by bucket, and cleanup.
- `AgentBridge` tests proving a browser action with `sessionId=s1` drives the s1 guest even if s2 was focused last.
- Credential injection tests proving cookie jars restore into the originating session guest, not the global active guest.
- Renderer tests proving `browser:reload` and `browser:open-tab` are ignored by nonmatching panels.
- Regression test for legacy no-session fallback.

Effort/risk rating: L / Medium-high.

### 6. MCP login-shell PATH root fix

Status: RESOLVED in current source. No implementation plan should be executed unless this regresses.

Current state:

- App startup imports `injectLoginShellPathAtStartup` at `packages/desktop/src/main/index.ts:235`.
- `packages/desktop/src/main/index.ts:1439-1441` runs it during startup so GUI-launched Electron inherits a login-shell PATH.
- `packages/desktop/src/main/login-shell-path.ts:91-114` merges login-shell PATH entries idempotently.
- `packages/desktop/src/main/login-shell-path.ts:221-224` probes the configured shell using `shell -lic env`.
- `packages/desktop/src/main/login-shell-path.ts:274-330` injects the merged PATH and safe missing env vars into `process.env`.
- `packages/desktop/src/main/agent-bridge.ts:149-152` spawns the worker with `...process.env`, so the worker receives the injected PATH.
- `packages/core/src/tool-system/mcp-manager.ts:78-90` returns a minimal env only when a server has explicit `env` or `envVars`.
- The installed MCP SDK also inherits PATH by default when no explicit env is passed: `node_modules/.bun/@modelcontextprotocol+sdk@1.29.0/node_modules/@modelcontextprotocol/sdk/dist/esm/client/stdio.js:8-24` and `65-70`.

Existing coverage:

- `packages/desktop/src/main/login-shell-path.test.ts` covers PATH merge, noisy shell env parsing, safe env injection, idempotence, and non-secret logging.
- `packages/core/src/tool-system/mcp-stdio-env-filter.test.ts:49-53` covers PATH/HOME inheritance when an explicit MCP env is built.
- `packages/core/src/tool-system/mcp-manager.test.ts:390-401` covers undefined env when no env/envVars are configured and PATH inclusion when envVars are used.

Validation-only follow-up:

1. Keep a desktop smoke test or manual release checklist item: launch the macOS app from Finder, configure an MCP stdio server installed under Homebrew or a user package manager path, and verify it starts.
2. Add a small integration test for the worker spawn env if the desktop main-process test harness supports it.
3. Do not add another PATH workaround in MCP manager unless startup injection regresses; duplicate fixes could reintroduce broad host-env inheritance.

Effort/risk rating: Done / Low residual risk.

## Priority-ordered execution order

1. Fix the newly confirmed CDP/package release issues from the verification section.
   - Publishability blocks users following public install docs.
   - Printable `pressKey()` returns success while doing nothing for normal typing.
2. Credentials/browser target ownership.
   - This is still a live desktop cross-session correctness bug, and the source already has `sessionId` available at the intercept layer.
3. Steer step-boundary injection.
   - User steering correctness is central to long-running agent behavior; implement before broad engine movement so the boundary model is clear.
4. Compaction anchor persistence.
   - The in-run 2.5x bug is fixed, but resume/cold-start behavior still needs the real provider prompt-token anchor.
5. Engine split, staged mechanically.
   - Start with import-boundary guard, helper extraction, and steering runtime. Avoid semantic changes while moving code.
6. Arena optional builtin.
   - The JSON extraction prerequisite is already done. Make Arena optional before considering a package move.
7. Arena package move.
   - Defer until optional registration and product semantics for `arena_status`, `settings.arena`, public exports, and `/arena` are settled.
8. MCP login-shell PATH.
   - No implementation work; keep only validation/smoke coverage unless the fix regresses.
