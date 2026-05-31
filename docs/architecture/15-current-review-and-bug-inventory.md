# Current Architecture Review and Bug Inventory

**Date:** 2026-05-25  
**Scope:** repo-wide read-only architecture review across `packages/core`, `packages/tui`, `packages/desktop`, tools, hooks, plugins, permissions, and tests.

## Executive Summary

The monorepo split is real and the package direction is still broadly correct:

```text
@cjhyy/code-shell         root meta package and compatibility CLI bin
@cjhyy/code-shell-core    engine / protocol / tools / LLM / run / arena / extensions
@cjhyy/code-shell-tui     CLI / React terminal UI / custom Ink-compatible renderer
@cjhyy/code-shell-desktop Electron thin client + main-process broker + stdio agent worker
```

The biggest change since the previous repo map is desktop: it is no longer a placeholder POC. It now has a real main/preload/renderer surface, settings pages, session/runs/logs/skills/model services, and an `AgentBridge` that launches `@cjhyy/code-shell-core/bin/agent-server-stdio` as a worker.

The highest-risk issues are now safety and boundary enforcement rather than package layout:

1. `lint:engine-bypass` is a false-positive guard because it still scans the old root `src/` path.
2. External hooks/plugins can override permission decisions to `allow`, which makes plugin trust a security boundary.
3. `acceptEdits` currently allows all non-Bash tools in the classifier fallback.
4. Several tools still use `process.cwd()` instead of `ToolContext.cwd`.
5. Desktop has several UI/data-flow drifts after the recent implementation burst.

## Current Runtime Shape

### CLI / TUI

```text
packages/tui/src/cli/main.ts
  -> replCommand() or runCommand()
  -> Engine
  -> AgentServer
  -> AgentClient
  -> App.tsx or headless renderer
```

The interactive UI does not call `engine.run()` directly. It drives `AgentClient` and consumes stream/status/approval events from the protocol layer.

### Managed Runs

```text
RunManager
  -> EngineRunner
  -> Engine
  -> createInProcessClient(engine)
  -> AgentServer / AgentClient
```

This keeps managed/background execution aligned with interactive execution for stream events, status, cancellation, and approvals.

### Desktop

```text
renderer React UI
  -> window.codeshell preload API
  -> ipcMain in Electron main
  -> AgentBridge
  -> @cjhyy/code-shell-core/bin/agent-server-stdio worker
  -> AgentServer + Engine
```

The renderer remains a thin client at runtime. It should not import core runtime code directly; current core imports in renderer are type-only protocol/event types.

## Confirmed Bugs and Risks

### Critical

#### C1. Engine bypass guard scans the old source tree

**Paths:** `scripts/check-no-engine-bypass.sh`, `docs/architecture/14-engine-call-paths.md`

The script still greps the old root `src/` path, while the real code lives under `packages/*/src`. `bun run lint:engine-bypass` can therefore pass even if new direct `new Engine()` call sites are added in `packages/tui`, `packages/core`, or `packages/desktop`.

**Impact:** the ADR rule “internal engine runs must go through protocol” is not enforced.

**Fix direction:** update the script to scan `packages/core/src`, `packages/tui/src`, and relevant desktop main-process paths with a package-aware allowlist.

#### C2. Hooks/plugins can override denied or ask-required tools to `allow`

**Paths:** `packages/core/src/tool-system/executor.ts`, `packages/core/src/hooks`, `packages/core/src/plugins`

`pre_tool_use` can return `decision: "allow"` before the classifier result is applied, and `on_permission_check` can override the classifier after it runs. This is intentional policy-extensibility in code, but dangerous when the hook source is a settings shell hook or installed plugin.

**Impact:** installing or enabling a plugin/hook must be treated as granting trusted code execution and trusted permission-policy authority.

**Fix direction:** distinguish trusted built-in/SDK policy hooks from external settings/plugin hooks. External hooks should probably be able to deny or ask, but not upgrade `deny -> allow` or high-risk `ask -> allow` without explicit user opt-in.

#### C3. Shell/plugin command hooks execute arbitrary shell outside the tool permission/sandbox path

**Paths:** `packages/core/src/hooks/shell-runner.ts`, `packages/core/src/plugins/pluginCommandHook.ts`

Settings shell hooks and plugin command hooks are spawned with `shell: true`. They do not go through `PermissionClassifier`, and Bash sandboxing does not apply to them.

**Impact:** plugin installation is not just prompt/skill installation; it is host command execution authority whenever lifecycle hooks fire.

**Fix direction:** document this clearly in install UX and docs; add plugin hook enable/disable controls or per-plugin trust; consider sandbox/env/cwd limits for hook commands.

### Important

#### I1. `acceptEdits` permission mode is too broad

**Path:** `packages/core/src/tool-system/permission.ts`

The classifier has special Bash handling, but the fallback for `acceptEdits` allows non-Bash tools. That can include tools whose semantics are not “edits”, such as MCP, REPL, PowerShell, Config, and RemoteTrigger, unless covered by explicit rules.

**Fix direction:** narrow `acceptEdits` to known read/edit tools and keep external execution/network/remote-control tools at `ask`.

#### I2. Bash safe-read classification can be bypassed by shell metacharacters

**Path:** `packages/core/src/tool-system/permission.ts`

Safe-read patterns such as `echo`, `cat`, or `ls` match line prefixes. Commands like `echo ok; curl ...`, `ls && osascript ...`, command substitution, or redirection may be treated too optimistically.

**Fix direction:** conservatively classify commands containing `;`, `&&`, `||`, `$()`, backticks, redirects, or pipes as `ask`/dangerous unless parsed as a known read-only command.

#### I3. Some built-in tools still use `process.cwd()` instead of `ToolContext.cwd`

**Paths:** `ApplyPatch`, `REPL`, `PowerShell`, `Skill`, plus default paths in `Glob`/`Grep`

Multi-engine, sub-agent, desktop worker, and worktree scenarios depend on consistent `cwd` propagation. Bash already uses `ctx.cwd`; other tools are not fully aligned.

**Fix direction:** pass and use `ToolContext.cwd` consistently in all built-in executors and add cwd-focused tests.

#### I4. Explicit sandbox misconfiguration can fail open

**Paths:** `packages/core/src/engine/engine.ts`, `packages/core/src/tool-system/sandbox`

Sandbox `auto` may reasonably degrade to off, but an explicit `seatbelt`/`bwrap` request should fail closed if unavailable. Current engine wiring can catch backend resolution errors and continue with sandbox off.

**Fix direction:** only `auto` should degrade; explicit sandbox modes should fail the run or disable Bash with a clear error.

#### I5. Discovered MCP tools default to concurrency-safe despite unknown side effects

**Path:** `packages/core/src/tool-system/mcp-manager.ts`

Discovered MCP tools are `permissionDefault: "ask"`, but also marked `isConcurrencySafe: true` even though `isReadOnly` is false and side effects are unknown.

**Fix direction:** unknown MCP tools should default to not concurrency-safe unless the server/tool metadata explicitly says otherwise.

#### I6. Protocol/global singleton state is not multi-server safe

**Paths:** `packages/core/src/protocol/server.ts`, `packages/core/src/tool-system/permission.ts`, `packages/core/src/tool-system/builtin/plan.ts`, `packages/core/src/tool-system/builtin/arena.ts`

`AgentServer` sets global interactive approval callbacks and toggles global runtime bypass/plan state. Multiple servers in one process can overwrite each other.

**Fix direction:** move approval backend, plan mode, bypass state, and arena status toward engine/server/session-scoped state.

#### I7. `permission_set` query can desynchronize permission state

**Path:** `packages/core/src/protocol/server.ts`

The `agent/query` `permission_set` path updates `engine.setPermissionMode(...)` but does not mirror all state changes performed by `agent/run` or `agent/configure`, such as runtime bypass and plan mode toggles.

**Fix direction:** route permission changes through one protocol method or make `permission_set` update the same state as `handleRun`/`handleConfigure`.

#### I8. Desktop model changes write settings but do not live-configure the worker

**Paths:** `packages/desktop/src/renderer/App.tsx`, `packages/desktop/src/preload/index.ts`, `packages/core/src/protocol/server.ts`

The desktop composer updates settings when the user changes model, but the existing agent worker is long-lived. Without a live `agent/configure` call or worker restart, the next turn may use stale model state.

**Fix direction:** expose/configure live model switching over preload and call `agent/configure` after settings update, or restart/reload the worker intentionally.

#### I9. Desktop approval/runs navigation has UI drift

**Paths:** `packages/desktop/src/renderer/Sidebar.tsx`, `packages/desktop/src/renderer/App.tsx`, settings menu components

`ApprovalsView` still exists in rendering logic, but obvious sidebar/settings entry points appear to have been removed. A badge for pending approvals may show on the “automation” entry, which is semantically confusing.

**Fix direction:** restore an approvals entry or intentionally remove the standalone view; align badges with their destination.

#### I10. Desktop settings merge is shallow in renderer

**Path:** `packages/desktop/src/renderer/App.tsx`

Renderer-side user/project settings merge uses a shallow spread, while settings service/core semantics use deep merge. Nested settings like `permissions`, `providers`, or `mcp` can display differently from what the engine resolves.

**Fix direction:** use the same deep merge semantics in renderer that the settings manager/service uses.

#### I11. Desktop multi-window worker broadcasting lacks per-window routing

**Paths:** `packages/desktop/src/main/agent-bridge.ts`, `packages/desktop/src/renderer/App.tsx`

The desktop bridge broadcasts worker output to all windows. Renderer-side local refs decide what to display. This is fragile for multi-window runs, approvals, and AskUser prompts.

**Fix direction:** add request/window/session routing metadata and route stream/approval events only to subscribed windows or buckets.

#### I12. UI input can unlock while work is still running

**Reported:** 2026-05-31

**Symptom:** The user observed that the UI allowed typing / new input even though the current task or agent was still running.

**Expected behavior:** While a foreground session is still busy, the composer should stay disabled or block sending another message. If concurrent input is intentionally allowed, the UI should make the queue/concurrency model explicit.

**Likely paths:** Electron/TUI busy-state routing around `busyByKey`, `runningBucketRef`, `turn_complete`, tool/subagent lifecycle events, and background-agent routing.

**Risk:** The UI may treat main `turn_complete` as the end of all foreground work even when tools, subagents, or background work still have active lifecycle state. This can lead to accidental overlapping turns, confusing transcript ordering, or duplicate user input while the engine is not actually idle.

**Fix direction:** Reproduce with a long-running foreground tool/subagent, trace stream events and busy-state transitions, and decide the unlock contract explicitly: main turn complete vs all foreground tool/subagent lifecycle complete vs background work excluded from blocking input.

### Minor / Documentation Drift

- Many architecture documents still link to old `src/...` paths rather than `packages/core/src/...` and `packages/tui/src/...`.
- `packages/core/src/index.ts` is still a broad compatibility barrel, not a clean stable SDK surface.
- `packages/core/src/state.ts` mixes engine/session/model/cost state with TUI interaction state.
- `packages/tui/src/ui/App.tsx` is a large god component mixing protocol wiring, stream state machine, input hotkeys, model/session panels, approvals, and background-agent routing.
- Some tests still import built output instead of source, which can hide source/dist drift.

## Verification Snapshot

Read-only verification during this review:

```text
bun test tests/protocol-client-query.test.ts tests/run-manager.test.ts tests/run-manager-usage.test.ts tests/tools.test.ts tests/tool-result-storage.test.ts
# 70 pass, 0 fail

bun test tests/hooks*.test.ts tests/plugin*.test.ts tests/plugins*.test.ts tests/sandbox.test.ts
# 189 pass, 0 fail

bun test tests/desktop-services-git-branches.test.ts
# 5 pass, 0 fail

bun run --filter '@cjhyy/code-shell-core' build
# pass

bun run lint:engine-bypass
# pass, but not trusted because the script scans the old path
```

## Documentation Update Checklist

- Treat this file as the current top-level bug/risk inventory.
- Update `docs/repo-map-and-decoupling-review-2026-05-23.md` if continuing to use it as the main repo map; its desktop section is now stale.
- Update `docs/architecture/04-tool-system.md` for hook permission overrides, sandbox scope, MCP concurrency, and `acceptEdits` caveat.
- Update `docs/architecture/06-ui-protocol-rendering.md` for monorepo paths, desktop stdio worker, and multi-server/global-state limitations.
- Update `docs/architecture/08-extension-points.md` and `docs/hooks.md` for plugin hooks, plugin skills, arbitrary shell execution trust, and current priority order.
