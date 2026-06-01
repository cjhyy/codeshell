# Automation runs must not ask the user (and must know they're automation)

Date: 2026-06-01
Status: Design — pending implementation

## Problem

Session `nT_JSYPSg_Pl2-Oq` is a daily read-only news-briefing automation run
(objective: "每天早上汇总过去 24 小时内的重要新闻… 保持只读"). The run went
through the automation RunManager (read-only `approvalBackend` override), yet
the model called `AskUserQuestion` asking *"需要我为你设置每天上午9:00自动生成
同款只读简报的计划任务吗？"* — offering to set up the very automation it already
is. The `AskUserQuestion` call then **blocked for 300s** (`duration_ms: 300005`,
`ok: true`) before a tool-exec timeout released it.

Two independent root causes:

### Layer A — the model doesn't know it's an unattended automation run

`bindCronToRunManager` (`packages/core/src/automation/runner.ts:97`) passes
`metadata: { source: "automation", cronJobId, cronJobName }` to
`RunManager.submit`. That metadata is stored on the RunSnapshot but is **never
surfaced to the system prompt**. The model therefore treats the run like an
interactive chat and offers to "set up automation."

### Layer B — `AskUserQuestion` can still suspend in an unattended run

`EngineRunner` deliberately leaves `askUserFn` **undefined** when an
`approvalBackend` override is present (the unattended signal —
`EngineRunner.ts:115–129`). With `askUser` undefined, `AskUserQuestion` would
hit its headless branch and return instantly:

> "Error: AskUserQuestion is not available in headless mode. Make a reasonable
> assumption and proceed." (`tool-system/builtin/ask-user.ts:84`)

But `EngineRunner` then wraps the engine in an in-process `AgentServer`
(`createInProcessClient`, `EngineRunner.ts:184`). The `AgentServer`
**constructor unconditionally** re-binds askUser back to a client round-trip:

```ts
// packages/core/src/protocol/server.ts:110
this.legacyEngine.setAskUser((question, opts) =>
  this.requestAskUserFromClient(question, opts));
```

This clobbers the intentionally-undefined askUser. The call suspends waiting for
a client answer that never comes (`createRunAskUserFn` has no timeout —
`RunApprovalBackend.ts:110`), until the tool-exec layer times it out at 300s.

## Why not gate Layer B on "goal mode"

One idea raised: "isn't an automation task goal-mode by default, so gate on
that?" No. `goal` (`engine.ts:1312`) only controls **when the turn loop stops**
(a GoalStopHook that re-loops until the model judges the goal met). It says
nothing about whether a human is present, automation runs do **not** currently
set `goal`, and tying askUser-suppression to goal mode would both (a) be a false
coupling and (b) risk changing loop-termination behavior. The correct,
already-existing signal is `headless` (`engine.ts:146`), which already drives
sandbox auto-mode and investigation-guard soft mode for unattended runs.

## Design

### Fix A — inject an automation system-prompt note

Thread the unattended/automation fact into `EngineConfig.appendSystemPrompt`
(field already exists and is forwarded — `EngineRunner.ts:156`).

When the run is automation, append (English, matching repo system-prompt
convention; the model is separately instructed to answer in the user's
language):

> This is an unattended, scheduled automation run. No human is watching, and
> `AskUserQuestion` will not reach anyone. You ARE the automation — do not ask
> the user questions and do not offer to set up or schedule automation. Produce
> the requested output directly; when uncertain, state your assumption and
> proceed.

How the automation signal reaches `appendSystemPrompt`:
- `bindCronToRunManager` already sets `metadata.source = "automation"`.
- `EngineRunner.execute` reads `run.metadata?.source === "automation"` (the
  RunSnapshot carries `metadata`) and, when true, **prepends** the note to any
  existing `appendSystemPrompt` (preserving host-provided appends).

This keeps the automation knowledge data-driven (metadata), not a new config
field, and works for any host that tags a run `source: "automation"`.

### Fix B — don't wire askUser to the client for headless engines

1. `AgentServer` constructor: gate the `setAskUser` call on the engine NOT being
   headless. Add a structural read for the engine's headless flag (the engine
   already stores `this.config.headless`; expose it via an existing getter or a
   minimal `isHeadless()` accessor). When headless, **skip** `setAskUser`,
   leaving `ctx.askUser` undefined so `AskUserQuestion` returns the instant
   headless error.

   ```ts
   if (this.legacyEngine) {
     setInteractiveApprovalFn(...);
     if (!this.legacyEngine.isHeadless()) {
       this.legacyEngine.setAskUser(...);
     }
   }
   ```

2. `EngineRunner`: when running unattended (an `approvalBackend` override is
   set — same condition that already nulls `askUserFn`), set
   `headless: true` on the `EngineConfig` it builds, so the in-process server
   sees a headless engine. (The TUI cron path already passes `headless: true`;
   this aligns the RunManager/desktop path with it.)

Net effect: in unattended runs, `AskUserQuestion` short-circuits to "make a
reasonable assumption and proceed" instead of suspending for 300s.

## Components touched

- `packages/core/src/run/EngineRunner.ts` — read `run.metadata.source`, prepend
  automation note to `appendSystemPrompt`; set `headless: true` under override.
- `packages/core/src/protocol/server.ts` — gate `setAskUser` on
  `!engine.isHeadless()`.
- `packages/core/src/engine/engine.ts` — add `isHeadless()` accessor (if no
  existing getter exposes `config.headless`).
- Tests (below).

## Testing

TDD — red first for each:

1. **EngineRunner injects automation note** — given a RunSnapshot with
   `metadata.source === "automation"`, the EngineConfig passed to the Engine has
   the automation note prepended to `appendSystemPrompt`; given a non-automation
   run, `appendSystemPrompt` is unchanged.
2. **EngineRunner sets headless under override** — when `config.approvalBackend`
   is set, the built EngineConfig has `headless: true`; when unset, it does not
   force headless.
3. **AgentServer skips askUser when headless** — construct an AgentServer over a
   headless legacyEngine; assert `engine.setAskUser` was NOT called (spy), so
   `AskUserQuestion` execution hits the headless-error branch. Non-headless
   engine still gets askUser wired (regression guard).
4. **AskUserQuestion headless branch** (characterization, may already exist) —
   with `ctx.askUser` undefined, returns the "not available in headless mode"
   string and does not block.

## Out of scope

- Adding a timeout to `createRunAskUserFn` (the no-timeout suspend is a real
  latent issue, but Fix B removes the path that triggers it for automation;
  interactive runs legitimately wait on the user). Note it, don't fix here.
- Changing tool-exec's 300s timeout.
- Per-job write tiers / goal-mode coupling.
