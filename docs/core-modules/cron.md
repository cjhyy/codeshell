# cron

**One-line role.** Back-compat shim layer that re-exports the cron scheduling stack (scheduler / persistence / Engine-binding) which physically lives in `../automation`.

## 职责 / Responsibility

This directory is **not** an independent implementation — every file here is a one-line `export * from "../automation/..."` shim. The real cron scheduling code (`CronScheduler`, `CronStore`, `bindCronToEngine`) moved into `packages/core/src/automation/` per `docs/automation-plan-2026-05-31.md`. These shims exist only so older importers using `../cron/scheduler.js`, `../cron/cron-store.js`, and `../cron/cron-runtime.js` keep compiling. New code should import from `../automation/*` directly.

Note: despite the "cron expression helpers" framing, the actual cron-expression parser (`parseCronExpression`, `nextCronTime`, `isCronExpression`) lives in `automation/cron-expr.ts` and is **not** re-exported through this directory.

## 文件 / Files

| File | Purpose |
| --- | --- |
| `scheduler.ts` | Shim → `../automation/scheduler.js`. Surfaces `CronScheduler`, `CronJob`, `cronScheduler` (shared singleton), `CronPermissionLevel`, `CreateJobOptions`, `UpdateJobPatch`. |
| `cron-store.ts` | Shim → `../automation/store.js`. Surfaces `CronStore`, `defaultCronStorePath`. |
| `cron-runtime.ts` | Shim → `../automation/runner.js`. Surfaces `bindCronToEngine`, `CronRunner`, `CronRunRequest`, `CronRunResult`, `RunSubmitter`. |
| `scheduler.test.ts` | Re-entrancy guard (no overlapping runs) + schedule-validation tests, imported via the shim. |
| `cron-store.test.ts` | Round-trip / corrupt-file / atomic-write tests for `CronStore`. |
| `cron-runtime.test.ts` | `bindCronToEngine` executor wiring + read-only permission backend tests. |
| `scheduler-persist.test.ts` | Persistence/reconciliation tests across the store. |

## 公开接口 / Public API

Re-exported through the shims (defined in `automation/`):

```ts
// from ./scheduler.js  (→ automation/scheduler.ts)
interface CronJob {
  id: string; name: string;
  schedule: string;            // cron expr "0 9 * * 1-5" OR interval "30s"/"5m"/"1h"/"1d"/raw-ms "1500"
  prompt: string; enabled: boolean;
  lastRun?: number; nextRun?: number; runCount: number; createdAt: number;
  cwd?: string; timezone?: string;          // IANA tz for cron exprs, default "UTC"
  permissionLevel?: CronPermissionLevel;    // defaults to read-only
  lastRunId?: string;
}
type CronPermissionLevel = "read-only" | "workspace-write" | "full";

class CronScheduler {
  constructor(store?: CronStore);
  setExecutor(fn: (job: CronJob, signal: AbortSignal) => Promise<void>): void;
  setStore(store: CronStore): void;
  setExecutionEnabled(enabled: boolean): void;   // false = persist/track but never arm timers (worker process)
  loadJobs(opts?: { arm?: boolean }): void;       // reconcile against disk; call at startup + as periodic re-sync
  create(name: string, schedule: string, prompt: string, opts?: CreateJobOptions): CronJob;  // throws on bad schedule
  update(id: string, patch: UpdateJobPatch): CronJob | null;
  delete(id: string): boolean;
  list(): CronJob[];
  get(id: string): CronJob | undefined;
  pause(id: string): boolean;
  resume(id: string): boolean;
  runNow(id: string): boolean;                    // fire out-of-band; respects re-entrancy guard
  abort(jobId: string): Promise<boolean>;          // cancel in-flight run, await full teardown
  stopAll(): void;
}
const cronScheduler: CronScheduler;               // shared singleton (no store until setStore)

// from ./cron-store.js  (→ automation/store.ts)
class CronStore {
  constructor(file?: string);                      // default ~/.code-shell/cron.json
  load(): CronJob[];                               // [] when absent/corrupt
  save(jobs: CronJob[]): void;                     // atomic tmp+rename under dir lock
  mutate<T>(fn: (jobs: CronJob[]) => { jobs: CronJob[]; result: T }): { jobs: CronJob[]; result: T };
}
function defaultCronStorePath(): string;

// from ./cron-runtime.js  (→ automation/runner.ts)
type CronRunner = (req: CronRunRequest) => Promise<CronRunResult>;
function bindCronToEngine(scheduler: CronScheduler, runner: CronRunner): void;
interface CronRunRequest { job: CronJob; prompt: string; permissionMode: PermissionMode;
  approvalBackend: ApprovalBackend; sandboxMode: SandboxMode; signal?: AbortSignal; }
interface CronRunResult { text: string; reason: string; }
```

## 怎么用 / How to use

Wire a scheduler to a run backend, then create a job (mirrors `cron-runtime.test.ts`):

```ts
import { CronScheduler } from "../cron/scheduler.js";
import { bindCronToEngine, type CronRunRequest } from "../cron/cron-runtime.js";

const sched = new CronScheduler();

// Install the executor exactly once. The runner receives the resolved
// permissionMode / approvalBackend / sandboxMode for the job's tier.
bindCronToEngine(sched, async (req: CronRunRequest) => {
  // Production: forward req into a headless Engine run.
  // await engine.run({ prompt: req.prompt, permissionMode: req.permissionMode,
  //                     approvalBackend: req.approvalBackend, signal: req.signal });
  return { text: "ok", reason: "completed" };
});

// schedule accepts an interval ("20"/"30s"/"5m"/"1h") or a cron expr ("0 9 * * 1-5").
const job = sched.create("nightly", "0 9 * * 1-5", "summarize the repo",
                         { timezone: "Asia/Shanghai", permissionLevel: "read-only" });
sched.delete(job.id);
```

Persist jobs across restarts by giving the scheduler a store (mirrors `cron-store.test.ts` + `scheduler.ts`):

```ts
import { CronScheduler } from "../cron/scheduler.js";
import { CronStore, defaultCronStorePath } from "../cron/cron-store.js";

const store = new CronStore(defaultCronStorePath());   // ~/.code-shell/cron.json
const sched = new CronScheduler(store);
sched.loadJobs();                  // restore persisted jobs + arm enabled ones
// A worker process that must NOT execute jobs (separate from the owner):
//   sched.setExecutionEnabled(false); sched.loadJobs({ arm: false });
```

## 注意 / Gotchas

- **These files are shims, not the source.** Read/edit the real code in `automation/scheduler.ts`, `automation/store.ts`, `automation/runner.ts`. New code should import from `../automation/*`; only legacy `../cron/*` importers justify these.
- **ESM `.js` extension is mandatory** on all imports (e.g. `../cron/scheduler.js`) — this is an ESM package.
- **Schedule validation throws at `create`/`update` time**, not silently at the first tick. A typo like `"5mn"` throws; valid forms are `"30s"/"5m"/"1h"/"1d"`, raw positive ms (`"1500"`), or a 5-field cron expr.
- **Re-entrancy guard:** a job slower than its interval will not run overlapping copies — a tick is skipped while the prior run is in flight (so `runCount` isn't double-counted).
- **No catch-up on missed runs.** After restart, `nextRun` is recomputed forward from now; runs missed while the process was down are not replayed. Cron-expr timers also apply a 90s misfire grace to skip sleep/wake drift (a slept-through `0 9 * * *` won't fire at wake time).
- **Persistence is best-effort.** Store write failures are swallowed (logged) so an unwritable disk never breaks the in-memory scheduler. `CronStore.load()` returns `[]` for an absent or corrupt file rather than throwing.
- **Cross-process safety:** use `CronStore.mutate()` for read-modify-write (create/update/delete/pause/resume) so load+save happen under one directory lock; a raw `save()` of a stale snapshot can clobber another process's new job.
- **Unattended security tier:** a job with no `permissionLevel` resolves to read-only — `permissionMode "default"` plus a backend that approves reads, denies writes (`bindCronToEngine` via `resolveWritePolicy`). The host runner must forward `req.sandboxMode` into `Engine({ sandbox })` as defense in depth.
- **Must rebuild core** for TUI/desktop dist imports to pick up changes (these consumers import from `dist`).
- The `cronScheduler` singleton starts with **no store**; call `setStore()` + `loadJobs()` at host startup to enable persistence.
