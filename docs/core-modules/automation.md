# automation

**One-line role.** A zero-environment-dependency cron scheduler plus JSON store for recurring/headless agent jobs — schedules prompts, persists them, and fires them through a host-injected run backend.

## 职责 / Responsibility

This module owns scheduled and headless automation tasks: it parses cron expressions and intervals, arms timers, persists jobs to disk so they survive restarts, and on each fire hands a run request to an execution backend the host supplies. It deliberately imports nothing from Electron/Ink/TTY and never picks a storage path or run backend itself — hosts (Electron main, the CLI agent server, the TUI) inject a `CronStore` and either a one-shot `runner` or a `RunManager` submitter. Its boundaries stop at "what to run, when, and under which permission tier"; the actual LLM/Engine execution, IPC, and git/PR plumbing all live in the host.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Public facade: `startAutomation(deps)` wires a scheduler to a store + backend and restores jobs; re-exports every building block so hosts import from one place. |
| `scheduler.ts` | `CronScheduler` class + shared `cronScheduler` singleton. Owns the job map, timers, re-entrancy guard, abort controllers, create/update/delete/pause/resume/runNow, misfire (sleep-wake) guard, and persistence via the store. Defines `CronJob`. |
| `store.ts` | `CronStore` — atomic single-file JSON persistence at `~/.code-shell/cron.json`, with a directory lock and `mutate()` for safe cross-process read-modify-write. |
| `cron-expr.ts` | Dependency-free 5-field cron parser + timezone-aware `nextCronTime` (uses `Intl.DateTimeFormat`, correct across DST, bounded ~2-year search). |
| `runner.ts` | The pluggable execution backends: `bindCronToEngine` (one-shot run) and `bindCronToRunManager` (submit into a RunManager for history). Resolves each job's permission tier via write-policy. |
| `write-policy.ts` | Maps a job's permission tier (`read-only`/`workspace-write`/`full`) to a `permissionMode` + approval backend + sandbox mode; also `wrapUntrustedInput` for prompt-injection defense. |
| `write-run.ts` | `runWriteJobInWorktree` — orchestrates a write-type job in an isolated git worktree and opens a PR if it produced changes, with injected git ops. |

## 公开接口 / Public API

```ts
// index.ts — the facade most hosts use
function startAutomation(deps: StartAutomationDeps): AutomationHandle;
interface StartAutomationDeps {
  store: CronStore;
  runner?: CronRunner;        // provide exactly one of runner / runManager
  runManager?: RunSubmitter;  // preferred when both given (gives run history)
}
interface AutomationHandle {
  scheduler: CronScheduler;
  stop(): void;               // idempotent — halts all timers
}

// scheduler.ts
class CronScheduler {
  constructor(store?: CronStore);
  setStore(store: CronStore): void;
  setExecutor(fn: (job: CronJob, signal: AbortSignal) => Promise<void>): void;
  setExecutionEnabled(enabled: boolean): void;   // false = persist/track but never arm timers
  loadJobs(opts?: { arm?: boolean }): void;      // reconcile against disk (call at startup / periodically)
  create(name: string, schedule: string, prompt: string, opts?: CreateJobOptions): CronJob;
  update(id: string, patch: UpdateJobPatch): CronJob | null;
  delete(id: string): boolean;
  pause(id: string): boolean;
  resume(id: string): boolean;
  list(): CronJob[];
  get(id: string): CronJob | undefined;
  runNow(id: string): boolean;                   // fire out-of-band; force-runs even if paused
  abort(jobId: string): Promise<boolean>;        // cancels in-flight run, awaits teardown
  stopAll(): void;
}
const cronScheduler: CronScheduler;              // shared singleton (used by the CronCreate/Delete/List builtin tools)

type CronPermissionLevel = "read-only" | "workspace-write" | "full";
interface CronJob { id; name; schedule; prompt; enabled; runCount; createdAt;
  lastRun?; nextRun?; cwd?; timezone?; permissionLevel?; lastRunId?; }

// store.ts
class CronStore {
  constructor(file?: string);                    // defaults to defaultCronStorePath()
  load(): CronJob[];
  save(jobs: CronJob[]): void;
  mutate<T>(fn: (jobs: CronJob[]) => { jobs: CronJob[]; result: T }): { jobs: CronJob[]; result: T };
}
function defaultCronStorePath(): string;         // ~/.code-shell/cron.json

// runner.ts
type CronRunner = (req: CronRunRequest) => Promise<CronRunResult>;
function bindCronToEngine(scheduler: CronScheduler, runner: CronRunner): void;
function bindCronToRunManager(scheduler: CronScheduler, runManager: RunSubmitter): void;

// cron-expr.ts
function isCronExpression(s: string): boolean;
function parseCronExpression(expr: string): ParsedCron;
function nextCronTime(cron: ParsedCron, timeZone: string, fromMs: number): number | null;

// write-policy.ts
function resolveWritePolicy(level: CronPermissionLevel | undefined): WritePolicy;
function wrapUntrustedInput(content: string, source: string): string;

// write-run.ts
function runWriteJobInWorktree(input: RunWriteJobInput): Promise<RunWriteJobResult>;
```

## 怎么用 / How to use

### 1. A host wires the scheduler to a RunManager (real call site: `cli/agent-server-tcp.ts`)

```ts
import { startAutomation, CronStore, defaultCronStorePath } from "@code-shell/core";

const automationRunManager = createRunManager({
  llm: resolvedLlmConfig,
  cwd,
  permissionMode: "default",
  approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
});

const automation = startAutomation({
  store: new CronStore(defaultCronStorePath()),
  runManager: automationRunManager,   // jobs land in RunStore with history
});
// ...later, on shutdown:
automation.stop();
```

### 2. A non-executing host that only persists/lists jobs (real call site: `cli/agent-server-stdio.ts`)

This process must NOT run jobs (a sibling process owns execution), so it disables timer arming but still shares the same store via the `cronScheduler` singleton — which the builtin `CronCreate`/`CronDelete`/`CronList` tools operate on.

```ts
import { cronScheduler, CronStore, defaultCronStorePath } from "@code-shell/core";

cronScheduler.setStore(new CronStore(defaultCronStorePath()));
cronScheduler.setExecutionEnabled(false);  // persist + track, never arm timers
cronScheduler.loadJobs();                  // so the agent can list/modify existing jobs
```

### 3. One-shot Engine backend with a per-job permission tier (pattern from `bindCronToEngine` + desktop host)

```ts
import { bindCronToEngine, type CronRunResult } from "@code-shell/core";

bindCronToEngine(cronScheduler, async (req): Promise<CronRunResult> => {
  // req carries the resolved security contract for this job's tier:
  // req.permissionMode, req.approvalBackend, req.sandboxMode, req.signal
  const engine = new Engine({ /* ... */, sandbox: req.sandboxMode });
  const out = await engine.run({
    objective: req.prompt,
    permissionMode: req.permissionMode,
    approvalBackend: req.approvalBackend,
    signal: req.signal,
  });
  return { text: out.text, reason: out.reason };
});
```

## 注意 / Gotchas

- **Inject exactly one execution backend.** `startAutomation` throws if neither `runner` nor `runManager` is supplied; if both are given, `runManager` wins. The module never picks a backend or store path itself.
- **One executor process only.** Timers must be armed in exactly one process. Any sibling process sharing the store must call `setExecutionEnabled(false)` before `loadJobs()`, or jobs fire twice. All mutations go through `CronStore.mutate()` (directory-locked) so concurrent processes don't clobber each other.
- **No catch-up after downtime.** `loadJobs()` recomputes `nextRun` forward from now; runs missed while the process was down are NOT replayed (avoids a restart thundering-herd).
- **Sleep/wake misfire guard.** A `setTimeout` that fires more than 90s past its scheduled instant (host woke from sleep) is treated as a misfire — skipped and re-armed, not run at the wrong wall-clock time.
- **Re-entrancy guard.** A job whose previous run is still in flight is skipped on the next tick rather than stacked; `runNow` respects this too. `runNow` force-runs even a paused job.
- **Persistence is best-effort.** An unwritable disk logs and is swallowed — it never breaks the in-memory scheduler. A corrupt `cron.json` is logged and treated as empty rather than crashing startup. After a fire, only run metadata (`lastRun`/`nextRun`/`runCount`/`lastRunId`) is persisted, so a stale in-flight job can't overwrite an edited prompt/schedule.
- **Permission tier is the security boundary, not `permissionMode`.** `permissionMode` stays `"default"` on purpose; the resolved `approvalBackend` is the single source of truth for what a tier permits. Undefined/unknown tier falls back to read-only. `UpdateAutomationMemory` is always approved regardless of tier (automation-internal bookkeeping). Sandbox confines writes to the workspace even for `full`.
- **Schedules validate at create/update time.** Both intervals (`30s`/`5m`/`1h`/`1d` or raw positive ms) and 5-field cron expressions throw on a bad string up front rather than silently mis-scheduling; an invalid schedule in `update` leaves the job untouched.
- **`cron-expr` has no third-party dep** — it steps minute-by-minute via `Intl.DateTimeFormat`, bounded to ~2 years, returning `null` for unsatisfiable expressions (e.g. Feb 30). Timezone defaults to `"UTC"`.
- **Core must be rebuilt** for TUI/host `dist` imports to pick up changes here.
