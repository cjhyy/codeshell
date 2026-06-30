# 06 · Long-Running Orchestration

> Runs, automation/cron, and persistent goals — the machinery for work that outlives a single interactive prompt. Source-mapped against `packages/core/src/run/`, `automation/`, `cron/`, and `engine/goal.ts`.

## 1. The managed run lifecycle (`run/`)

`RunManager` wraps an `Engine` run with a state machine, a queue, crash recovery, checkpoints, and cross-process locking — everything you need to fire a job, walk away, and come back to a recoverable result.

| File | Role | ~LOC |
|------|------|------|
| `run/RunManager.ts` | Top-level orchestrator: submit/resume/cancel, transitions, recovery | ~700 |
| `run/types.ts` | `RunStatus`, `RunSnapshot`, `RunEvent`, `VALID_TRANSITIONS` | ~50 |
| `run/RunQueue.ts` | In-process FIFO with configurable concurrency (default 1) | ~97 |
| `run/FileRunStore.ts` | Filesystem persistence (snapshots/events/checkpoints/approvals/artifacts) | ~230 |
| `run/RunLock.ts` | Cross-process advisory lock (proper-lockfile via createRequire) | ~165 |
| `run/Heartbeat.ts` | Periodic liveness writer + stale/process-alive detection | ~142 |
| `run/CheckpointWriter.ts` | Phase-boundary + periodic checkpoint extraction | ~170 |
| `run/ArtifactTracker.ts` | Record meaningful artifacts (writes, git commits, redirects) | ~189 |
| `run/EngineRunner.ts` | Bridge a `RunSnapshot` into `Engine.run`, inject run-aware approval/askUser | ~265 |
| `run/RunApprovalBackend.ts` | Suspend the engine on approval/input, resolved by `RunManager` | ~155 |
| `run/Evaluator.ts` | Post-run quality gate (Noop / Composite) | ~108 |
| `run/factory.ts` | `createRunManager` convenience factory | ~121 |

### The state machine
`VALID_TRANSITIONS` (`types.ts`) defines the legal graph: `queued → running → {waiting_input | waiting_approval | blocked | completed | failed | cancelled}`, with `completed`/`failed`/`cancelled` terminal. Every transition is validated; terminal states block further ops.

### Hardening for unattended execution
- **RunLock** — a file-based advisory lock on `run.json` (proper-lockfile, ESM-safe via `createRequire` — the RunLock-ESM-bug memory note records the "Run now does nothing" failure when a bare `require` threw and was swallowed). Acquire fails fast if held; stale locks (>60 s) can be reclaimed.
- **Heartbeat** — writes `{pid, timestamp, runId}` every ~5 s (timer unreffed). On startup, `RunManager.recover` finds stale `running` runs: dead + stale ⇒ force-unlock and re-queue or block (after ≥3 attempts), alive + recent ⇒ skip (still executing elsewhere). `process.kill(pid, 0)` is the liveness probe.
- **Atomic persistence** — snapshots write `.tmp`+rename; JSONL appends serialize through a per-file promise lock that never rejects.
- **Race guards** — `resolvingRuns` serializes resume/cancel per run; `RunQueue` dedups a runId and respects the concurrency ceiling.

### Approval suspension
`RunApprovalBackend` suspends the engine on an approval (24 h timeout) and `RunManager` resolves it via an execution handle; `createRunAskUserFn` does the same for input, with a supersede check that unblocks the first awaiter if a new question arrives. **Fail-closed**: if the hooks aren't wired, approvals are denied (never auto-approved).

`EngineRunner` wraps the engine in an in-process `AgentServer`+`AgentClient` (so a run goes through the same protocol seam as the REPL — see [04](04-protocol-and-sessions.md)), and injects `AUTOMATION_PROMPT_NOTE` into the system prompt for unattended runs ("No human is watching. You ARE the automation — do not ask user questions… call UpdateAutomationMemory exactly once").

## 2. Automation & cron (`automation/`)

A **zero-environment-dependency** scheduling module — it imports nothing from Electron/Ink and makes no GUI/TTY assumptions, so the same code runs in the desktop main process or a CLI server.

| File | Role | ~LOC |
|------|------|------|
| `automation/scheduler.ts` | `CronScheduler` — schedule/arm/fire jobs, dual backends | ~640 |
| `automation/cron-expr.ts` | 5-field cron parser + timezone-aware next-trigger (no dep) | ~208 |
| `automation/store.ts` | `CronStore` — single-file JSON, cross-process locked | ~134 |
| `automation/runner.ts` | `bindCronToEngine` / `bindCronToRunManager` | ~114 |
| `automation/write-policy.ts` | permission tier → permissionMode + approval backend + sandbox | ~129 |
| `automation/write-run.ts` | run write-jobs in an isolated git worktree | ~64 |

`startAutomation(deps)` wires the scheduler to a host-supplied store + execution backend (preferring `RunManager` when supplied). The scheduler arms timers per job (interval via `setInterval`, cron via computed `setTimeout` re-armed after each fire), guards re-entrancy (`running` set), and supports `abort(jobId)` that trips the controller and awaits settle.

Several robustness details:
- **Misfire grace (~90 s)**: if a cron timer fires >90 s late (host sleep/wake), it *skips* the missed run and re-arms to the next correct occurrence — comfortably clearing cron's 60 s granularity while still catching sleep drift (the automation-kKg28 memory note traces this to a real Mac sleep/wake incident).
- **One-shot jobs** (`once`): deleted after the first fire — this is how scheduling was decoupled from the CC-room special path back into the generic layer (the schedule-decouple memory note).
- **CronStore.mutate**: load-mutate-save under a directory lock so multi-process writers don't clobber.

### The read-only contract
`write-policy.ts` maps a job's permission tier to a *backend*, not classifier rules:
- `read-only` → `HeadlessApprovalBackend("approve-read-only")`
- `workspace-write` → tier backend approving write tools
- `full` → tier backend approving everything

Crucially, `permissionMode` stays `"default"` for all tiers so the classifier doesn't add its own rules — **the backend is the single source of truth for what a tier permits**. All tiers run sandboxed (`auto`), and external input is wrapped via `wrapUntrustedInput` (`<untrusted_input>…</untrusted_input>` with a neutralized closing tag) so injected instructions are treated as data. Write-type jobs run in a fresh git worktree (`runWriteJobInWorktree`) and open a PR if they produced changes — never touching the user's working copy. (`cron/` holds back-compat shim re-exports after the module moved to `automation/`.)

## 3. Persistent goals (`engine/goal.ts`)

A goal is "keep going until this objective is met." It is **persistent**: stored in `session.state.activeGoal` (not just passed to one send), survives interrupts, and rehydrates on resume. Precedence per send: `options.goal` (replaces) > stored `activeGoal` > engine default.

`GoalConfig` carries the objective plus optional `tokenBudget`, `timeBudgetMs`, `maxTurns`, `maxStopBlocks` (see [01](01-engine-and-turn-loop.md) §4 for the ceilings). Two mechanisms collaborate:

- **The stop-hook judge** — `createGoalStopHook` registers an `on_stop` handler that runs the *aux* model ("is this goal met? what gaps remain?"). If not met and under the `maxStopBlocks` cap, it returns `continueSession` and the loop injects a nudge and continues. The run-scoped budget tracker (token + wall-clock, checked before tool execution) is the hard backstop.
- **`complete_goal`** — the model can proactively declare the goal met, short-circuiting the loop.

Two collaborate (judge + proactive declaration); both must agree the work is done before the goal clears (the goal-mechanism-wiring memory note). `applyGoalExtension` allows mid-run bumps to turns/token/time budgets, seeding an unset cap from current usage so the new cap lands *above* current consumption (the B1 extension fix).

### The busy-wait fix
A goal run that kicks off a background job (e.g. `GenerateVideo`'s poll loop) used to make the model spin with `Sleep` waiting for it. The fix: a `backgroundJobRegistry` tracks non-agent background work, the goal judge's overview includes running jobs (so the model knows the job is finite), and the turn loop *parks* until completion rather than self-spinning (the goal-background-busywait memory note). This unifies with the background-shell/sub-agent wakeup path in [04](04-protocol-and-sessions.md).

## 4. Where to read next
- The turn loop the run drives and the goal ceilings: [01 · Engine & turn loop](01-engine-and-turn-loop.md)
- The approval backends a run/cron job uses: [02 · Tool system](02-tool-system.md)
- Why a run goes through `AgentServer`/`AgentClient`: [04 · Protocol & sessions](04-protocol-and-sessions.md)
