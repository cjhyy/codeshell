# run

**One-line role.** The managed run lifecycle layer — wraps `Engine.run()` with a queue, a state machine, event sourcing, checkpoints, approvals, artifact tracking, locking and crash recovery, so headless/automation/cron tasks can be submitted, suspended, resumed and recovered.

## 职责 / Responsibility

This module does NOT replace `Engine`; it coordinates one or more Engine executions as a durable, queryable *Run*. `RunManager` is the entry point: you `submit()` an objective, it gets queued, executed via a `RunExecutor` (the built-in `EngineRunner` calls the LLM Engine), and driven through a validated state machine (`queued → running → waiting_* / completed / failed / blocked / cancelled`). Along the way it persists an append-only event log, structured checkpoints, tool-approval records and artifact references through a `RunStore` (default `FileRunStore` on disk), and uses a file lock + heartbeat so a dead worker's runs can be recovered on restart. Boundaries: it owns run state and persistence, not turn-loop logic, tool execution, or session storage (those belong to `engine`/`session`).

## 文件 / Files

| File | Purpose |
| --- | --- |
| `index.ts` | Public barrel — re-exports every consumer-facing type/class. |
| `types.ts` | All run data shapes: `RunStatus`, `RunSnapshot`, `RunEvent`, `RunCheckpoint`, `RunApproval`, `RunArtifactRef`, submit/resume/query inputs, plus the `VALID_TRANSITIONS` state-machine table. |
| `RunManager.ts` | Top-level coordinator: submit/start/resume/cancel/get/list/attach/recover/shutdown; owns the state machine, event sourcing, abort controllers and execution handles. |
| `factory.ts` | `createRunManager(options)` — one-call SDK convenience constructor with sensible defaults (`~/.code-shell/runs`, concurrency 1, etc.). |
| `EngineRunner.ts` | Built-in `RunExecutor`: builds `EngineConfig` from a snapshot, wraps Engine in an in-process AgentServer/Client, wires the run-aware approval/askUser path. Also defines the `RunExecutor` contract, `RunExecutionHandle`, and automation constants. |
| `RunStore.ts` | `RunStore` persistence interface (snapshot/events/checkpoints/approvals/artifacts). |
| `FileRunStore.ts` | Filesystem `RunStore` implementation under `~/.code-shell/runs/<runId>/` (run.json + events.jsonl + checkpoints/ + approvals/ + artifacts/refs.jsonl). |
| `RunQueue.ts` | In-memory concurrency-limited queue; `RunManager` wires its executor to `executeRun`. |
| `RunApprovalBackend.ts` | Interactive run-aware `ApprovalBackend` + `createRunAskUserFn` — suspends the run on approval/input and lets `RunManager` resolve via the handle. |
| `CheckpointWriter.ts` | Listens to `StreamEvent`s and writes phase-boundary + periodic (every N turns) checkpoints; tracks touched tools. |
| `ArtifactTracker.ts` | Listens to tool results (Write/Edit/Bash/NotebookEdit) and records meaningful file/commit artifact refs; dedupes and rejects `..` paths. |
| `RunLock.ts` | File-based cross-process lock (via `proper-lockfile`) so two workers never execute the same run. |
| `Heartbeat.ts` | Periodic liveness file + PID so `recover()` can tell a crashed worker from a live one. |
| `Evaluator.ts` | `Evaluator` contract + `NoopEvaluator`/`CompositeEvaluator` — post-completion quality gate whose verdict can flip a run to `failed`. |
| `redirect-target.ts` | Helper to parse a shell redirect target (`> file`) for artifact tracking. |

## 公开接口 / Public API

All exported from the package root (`@code-shell/core` / `code-shell`) via `index.ts`.

```ts
// Convenience factory (most hosts use this)
function createRunManager(options: CreateRunManagerOptions): RunManager;
//   options: { llm: LLMConfig; cwd?; maxTurns?; maxContextTokens?;
//              permissionMode?; concurrency?; runsDir?; sessionStorageDir?;
//              mcpServers?; enabled/disabledBuiltinTools?; custom/appendSystemPrompt?;
//              evaluator?; hooks?; defaultTags?; defaultMetadata?;
//              approvalBackend? }  // approvalBackend → headless/unattended

class RunManager {
  constructor(config: RunManagerConfig);          // store + (RunExecutor | EngineRunnerConfig) + concurrency/evaluator/...
  submit(input: SubmitRunInput): Promise<RunSnapshot>;       // create + enqueue
  start(runId: string): Promise<void>;                       // enqueue a queued run
  resume(runId: string, input?: ResumeRunInput): Promise<void>;   // userInput OR approvalDecision
  cancel(runId: string, reason?: string): Promise<void>;
  get(runId: string): Promise<RunSnapshot | null>;
  list(query?: ListRunsQuery): Promise<RunSnapshot[]>;
  getEvents(runId: string): Promise<RunEvent[]>;
  attach(runId: string, cb: RunStreamCallback): DetachFn;    // live stream of status/events/engine events
  recover(): Promise<string[]>;                              // call on startup; returns recovered run ids
  shutdown(): Promise<void>;                                 // stop heartbeats, release locks
}

// Execution backend contract — implement to plug in a non-LLM runner
interface RunExecutor {
  execute(run, context, lifecycleHooks?, onHandleReady?):
    Promise<{ result: RunExecutionResult; handle: RunExecutionHandle }>;
}
class EngineRunner implements RunExecutor { constructor(config: EngineRunnerConfig); }

// Persistence
interface RunStore { /* create/update/get/list/delete, append/listEvents, save/get checkpoint,
                        save/get/getPending approval, append/listArtifactRefs */ }
class FileRunStore implements RunStore { constructor(storageDir?: string); }

// Supporting
class RunQueue { constructor({ concurrency }); }
class CheckpointWriter { constructor(config: CheckpointWriterConfig); }
class ArtifactTracker { constructor(config: ArtifactTrackerConfig); }
class RunLock; class Heartbeat;
interface Evaluator; class NoopEvaluator; class CompositeEvaluator;
const VALID_TRANSITIONS: Record<RunStatus, RunStatus[]>;
const AUTOMATION_RUN_SOURCE: "automation";  const AUTOMATION_PROMPT_NOTE: string;
```

## 怎么用 / How to use

**1. Headless/automation host (real call site — `cli/agent-server-tcp.ts`).** Inject a `HeadlessApprovalBackend` so the run auto-decides with no UI; runs land in the `RunStore` and become queryable history. This is exactly how cron jobs are bound (`startAutomation({ runManager })`).

```ts
import { createRunManager } from "code-shell";
import { HeadlessApprovalBackend } from "code-shell"; // from tool-system/permission

const runManager = createRunManager({
  llm: resolvedLlmConfig,
  cwd,
  permissionMode: "default",
  approvalBackend: new HeadlessApprovalBackend("approve-read-only"),
});

// On process startup, before accepting work:
await runManager.recover();

// Submit (e.g. fired by the cron scheduler):
const run = await runManager.submit({
  objective: "Summarize today's open PRs",
  cwd,
  tags: ["cron"],
  metadata: { source: "automation" }, // triggers AUTOMATION_PROMPT_NOTE in EngineRunner
});
```

**2. Interactive host — submit, stream, resume on approval/input.**

```ts
const run = await manager.submit({ objective: "Refactor the auth module" });

const detach = manager.attach(run.runId, (ev) => {
  if (ev.type === "run_status_changed") updateUI(ev.run.status);
  else if (ev.type === "engine_stream") renderEngineEvent(ev.event);
});

// When the run goes to waiting_approval / waiting_input, resume with the matching field:
await manager.resume(run.runId, { approvalDecision: { approvalId, approved: true } });
// or:
await manager.resume(run.runId, { userInput: "use the staging DB" });

detach();
```

## 注意 / Gotchas

- **`recover()` must be called on startup.** Runs left in `running`/`waiting_*` by a crashed worker stay stuck otherwise. It uses heartbeat staleness + PID liveness to decide; after `attemptCount >= 3` it gives up and marks the run `blocked` rather than re-queueing.
- **`resume()` input must match the wait state.** A live (suspended) run rejects with a clear error if you pass `userInput` to a `waiting_approval` run (or vice versa) — falling through would re-enqueue a duplicate execution and leak the handle. Concurrent resumes (double-click approve) or resume-racing-cancel are serialized per run via `resolvingRuns`; the late arrival is rejected.
- **State transitions are validated.** Any move not in `VALID_TRANSITIONS` throws. Terminal states (`completed`/`failed`/`cancelled`) have no outgoing edges. Don't mutate `snapshot.status` directly — go through the manager.
- **Evaluator can override engine success.** Even if the Engine returns `reason === "completed"`, a `failed` evaluator verdict flips the run to `failed`. Evaluators run *after* the Engine, must be side-effect-free and idempotent. Default is `NoopEvaluator`.
- **`RunLock` uses `proper-lockfile` through `utils/lockfile.js`.** That wrapper exists specifically because a bare `require` of the CJS dependency throws in the ESM process (see the RunLock ESM bug history). Keep CJS deps behind the lazy wrapper; don't add a top-level `require`.
- **`FileRunStore` uses synchronous `fs` calls.** Fine for the core/CLI process, but do not place a `FileRunStore` directly on the Electron *main* process hot path — sync fs blocks the event loop (the project's main-process sync-fs freeze rule). Hosts run the manager off the main thread / in the agent process.
- **`metadata.source === "automation"` changes prompting.** `EngineRunner` prepends `AUTOMATION_PROMPT_NOTE` to the system prompt and, when an `approvalBackend` override is set, runs the Engine `headless: true`. Don't pass `appendSystemPrompt` in `context.engineConfigOverrides` — it will clobber the composed automation+host value.
- **`sessionId` is linked mid-flight, not just at completion.** The manager writes it on the first non-sub-agent `session_started` event so in-flight runs are visible to the sidebar; the completion-time link is a backstop.
- **`ArtifactTracker` is heuristic and best-effort.** It only records Write/Edit/NotebookEdit/`git commit`/redirect/`cp`/`mv` outputs, dedupes per run, and silently drops any path containing `..`. It is not an exhaustive change ledger.
- **`CheckpointWriter` phase detection is keyword-based** (regexes over assistant text) plus a periodic checkpoint every `turnInterval` turns (default 10, `0` disables). Treat checkpoints as "summary + pointers", never full transcripts.
- **`RunManager` accepts either an `EngineRunnerConfig` or a `RunExecutor` instance** for `executor`; the `isRunExecutor` guard keys off a `.execute` method. Implement `RunExecutor` to drive non-LLM backends (CI/CD, ETL).
