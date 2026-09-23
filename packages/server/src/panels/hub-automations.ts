import { randomUUID } from "node:crypto";
import { mkdirSync, lstatSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  CronScheduler,
  CronStore,
  lockSync,
  resolveWritePolicy,
  type CronJob,
  type CronJobLifecycleEvent,
  type CronRunRequest,
} from "@cjhyy/code-shell-core/internal";
import { panelExecutionGate } from "./execution-gate.js";
import { readHubSessionState } from "../hub/session-management.js";
import {
  panelAutomationCreationKey,
  parsePanelAutomationCall,
  type PanelAutomationHost,
} from "./automations.js";

/** A transport lost the outcome after dispatch. Never automatically replay it. */
export class HubAutomationUncertainError extends Error {}
export class HubAutomationCancelledError extends Error {}

export interface HubPanelAutomationOptions {
  cwd: string;
  /** Canonical binding root when the workspace is a linked worktree. */
  bindingCwd?: string;
  dataDir: string;
  sessionRootDir: string;
  /** Must check the current project binding, permission and exact package revision.
   * Throw to stop a task whose source is no longer authorized. Never uses a page grant.
   */
  assertExecutable(job: Readonly<CronJob>): Promise<void>;
  /** Host-owned runner; must forward policy and cooperate with abort before resolving.
   * The Hub composition must reserve the bound Session against interactive runs.
   */
  execute(request: CronRunRequest): Promise<void>;
  onJobEvent?(event: CronJobLifecycleEvent): void;
}

function summary(job: CronJob) {
  return {
    id: job.id,
    name: job.name,
    schedule: job.schedule,
    prompt: job.prompt,
    enabled: job.enabled,
    cwd: job.cwd ?? null,
    timezone: job.timezone ?? null,
    permissionLevel: job.permissionLevel ?? null,
    resumeSessionId: job.resumeSessionId ?? null,
    runCount: job.runCount,
    createdAt: job.createdAt,
    lastRun: job.lastRun ?? null,
    nextRun: job.nextRun ?? null,
    disabledReason: job.disabledReason ?? null,
    panelSource: job.panelSource ? { ...job.panelSource } : null,
    lastExecution: job.lastExecution ? { ...job.lastExecution } : null,
  };
}

/** Project-owned scheduling. The Hub supplies its shared Worker, approval
 * policy and Session reservation; embedded hosts may supply equivalent runners.
 */
export function createHubPanelAutomationHost(options: HubPanelAutomationOptions) {
  const cwd = resolve(options.cwd);
  const directory = join(options.dataDir, "panel-automations");
  const records = join(directory, "records");
  const owner = join(directory, "owner");
  for (const path of [directory, records, owner]) {
    mkdirSync(path, { recursive: true, mode: 0o700 });
    const info = lstatSync(path);
    if (!info.isDirectory() || info.isSymbolicLink()) throw Error("Unsafe automation directory");
  }
  // The lifetime lease and bounded CronStore transaction lock use different
  // directories; neither nests a second acquisition of the same lock.
  let closed = false,
    compromised = false;
  let leaseLost: (() => void) | undefined;
  const unlock = lockSync(owner, {
    stale: 30000,
    update: 10000,
    retries: 0,
    onCompromised: () => {
      compromised = true;
      leaseLost?.();
    },
  });
  const identities = [directory, records, owner, `${owner}.lock`].map((path) => ({
    path,
    info: lstatSync(path),
  }));
  const store = new CronStore(join(records, "cron.json"), { strictRead: true });
  const scheduler = new CronScheduler(store);
  const active = new Set<string>();
  const assertStorage = () => {
    if (compromised) throw Error("Cloud automation owner is unavailable");
    for (const { path, info } of identities) {
      const current = lstatSync(path);
      if (
        !current.isDirectory() ||
        current.isSymbolicLink() ||
        current.dev !== info.dev ||
        current.ino !== info.ino
      )
        throw Error("Cloud automation storage or owner directory changed");
    }
  };
  const assertOwner = () => {
    if (closed) throw Error("Cloud automation owner is unavailable");
    assertStorage();
  };
  const assertSession = (sessionId: string) => {
    const state = readHubSessionState(options.sessionRootDir, sessionId);
    if (resolve(state.cwd) !== cwd) throw Error("Automation task is outside this project");
  };
  scheduler.setJobEventListener((event) => options.onJobEvent?.(event));
  scheduler.setExecutor(async (live, signal) => {
    active.add(live.id);
    const job = structuredClone(live);
    let releaseExecution: (() => void) | undefined;
    try {
      assertOwner();
      if (job.panelSource) {
        releaseExecution = panelExecutionGate.enter({
          appId: job.panelSource.appId,
          projectPath: options.bindingCwd ?? cwd,
        });
      }
      try {
        if (job.cwd !== cwd || !job.resumeSessionId || !job.panelSource)
          throw Error("Automation binding is incomplete");
        assertSession(job.resumeSessionId);
        await options.assertExecutable(job);
      } catch (error) {
        if (signal.aborted || closed || compromised) return;
        assertOwner();
        const reason =
          error instanceof Error ? error.message : "Automation authorization unavailable";
        scheduler.disableWithReason(job.id, reason);
        return { stoppedReason: reason };
      }
      assertOwner();
      if (signal.aborted) return;
      // Re-read task ownership after asynchronous package verification. A
      // deleted/moved Session must not be recreated by an unattended run.
      assertSession(job.resumeSessionId!);
      // A pending verification must not execute a deleted/replaced definition.
      // A strict reload also refuses corrupt persistence before side effects.
      const current = store.load().find((candidate) => candidate.id === job.id);
      if (
        !current ||
        current.createdAt !== job.createdAt ||
        current.prompt !== job.prompt ||
        current.resumeSessionId !== job.resumeSessionId ||
        current.cwd !== job.cwd ||
        current.panelSource?.appId !== job.panelSource?.appId ||
        current.panelSource?.revision !== job.panelSource?.revision ||
        current.permissionLevel !== job.permissionLevel
      )
        throw Error("Automation changed while preparing execution");
      if (current.lastExecution?.status === "running")
        throw Error("Previous automation outcome is unknown; restart to reconcile before retrying");
      const receipt: NonNullable<CronJob["lastExecution"]> = {
        id: randomUUID(),
        status: "running",
        startedAt: Date.now(),
      };
      // Persist admission before any Worker frame or model/tool side effect.
      store.mutate((jobs) => {
        const latest = jobs.find((value) => value.id === job.id);
        if (
          !latest ||
          latest.createdAt !== job.createdAt ||
          latest.prompt !== job.prompt ||
          latest.resumeSessionId !== job.resumeSessionId ||
          latest.cwd !== job.cwd ||
          latest.permissionLevel !== job.permissionLevel ||
          latest.panelSource?.appId !== job.panelSource?.appId ||
          latest.panelSource?.revision !== job.panelSource?.revision ||
          latest.lastExecution?.status === "running"
        )
          throw Error("Automation changed or has an unresolved execution");
        return {
          jobs: jobs.map((value) =>
            value.id === job.id
              ? { ...value, lastExecution: receipt, lastRunId: receipt.id }
              : value,
          ),
          result: null,
        };
      });
      job.lastRunId = live.lastRunId = receipt.id;
      let failure: unknown;
      let failed = false;
      try {
        await options.execute({
          job,
          prompt: job.prompt,
          signal,
          ...resolveWritePolicy(job.permissionLevel),
        });
      } catch (error) {
        failure = error;
        failed = true;
      }
      const uncertain = failure instanceof HubAutomationUncertainError;
      const status = uncertain
        ? "interrupted"
        : signal.aborted || failure instanceof HubAutomationCancelledError
          ? "cancelled"
          : failed
            ? "failed"
            : "completed";
      const detail = failed
        ? String(failure instanceof Error ? failure.message : failure)
            .replaceAll("\0", "")
            .slice(0, 2000)
        : undefined;
      assertStorage();
      // A deleted task stays deleted; a replacement never receives this run's receipt.
      // If saving fails, the running checkpoint remains and later fires refuse it.
      store.mutate((jobs) => ({
        jobs: jobs.map((value) =>
          value.id === job.id && value.lastExecution?.id === receipt.id
            ? {
                ...value,
                lastExecution: {
                  ...receipt,
                  status,
                  finishedAt: Math.max(Date.now(), receipt.startedAt),
                  ...(detail ? { detail } : {}),
                },
                ...(uncertain
                  ? { enabled: false, disabledReason: detail ?? "Execution outcome is unknown" }
                  : {}),
              }
            : value,
        ),
        result: null,
      }));
      scheduler.loadJobs();
      if (failure instanceof HubAutomationCancelledError) return { cancelled: true };
      if (failed) throw failure;
    } finally {
      releaseExecution?.();
      active.delete(job.id);
    }
  });
  let closing: Promise<void> | undefined;
  let ownerTimer: ReturnType<typeof setInterval> | undefined;
  const close = () => {
    if (closing) return closing;
    closed = true;
    clearInterval(ownerTimer);
    scheduler.setExecutionEnabled(false);
    scheduler.stopAll();
    closing = Promise.all([...active].map((id) => scheduler.abort(id))).then(() => {
      if (!compromised) unlock();
    });
    return closing;
  };
  leaseLost = () => {
    void close().catch(() => {});
  };
  try {
    // Validate ownership before loadJobs can arm timers or persist misfire stats.
    if (store.load().some((job) => job.cwd !== cwd))
      throw Error("Automation store belongs to another project");
    if (store.load().some((job) => job.lastExecution?.status === "running")) {
      store.mutate((jobs) => ({
        jobs: jobs.map((job) =>
          job.lastExecution?.status === "running"
            ? {
                ...job,
                enabled: false,
                disabledReason:
                  "Previous execution was interrupted; inspect its results before resuming",
                lastExecution: {
                  ...job.lastExecution,
                  status: "interrupted",
                  finishedAt: Math.max(Date.now(), job.lastExecution.startedAt),
                  detail: "Host stopped before recording a terminal outcome",
                },
              }
            : job,
        ),
        result: null,
      }));
    }
    scheduler.loadJobs();
  } catch (error) {
    scheduler.stopAll();
    unlock();
    throw error;
  }
  ownerTimer = setInterval(() => {
    try {
      assertOwner();
    } catch {
      compromised = true;
      leaseLost?.();
    }
  }, 1000);
  ownerTimer.unref?.();
  const host: PanelAutomationHost = {
    async call(scope, method, params) {
      assertOwner();
      const operation = parsePanelAutomationCall(method, params);
      if (resolve(scope.cwd) !== cwd || !/^[a-z0-9][a-z0-9-]{0,127}$/.test(scope.appId))
        throw Error("Automation scope does not match this project");
      if (!(await scope.isAuthorized())) throw Error("Panel automation authorization expired");
      assertSession(scope.sessionId);
      assertOwner();
      if (!(await scope.isAuthorized())) throw Error("Panel automation authorization expired");
      assertOwner();
      assertSession(scope.sessionId);
      scheduler.loadJobs();
      const owns = (job: Readonly<CronJob>) =>
        job.cwd === cwd &&
        job.resumeSessionId === scope.sessionId &&
        job.panelSource?.appId === scope.appId;
      const guard = (job: Readonly<CronJob>) => {
        if (!owns(job)) throw Error("Automation task is not available in this Panel project");
        if (
          !["pause", "delete"].includes(operation.action) &&
          job.panelSource?.revision !== scope.revision
        )
          throw Error(
            "Automation uses a different Panel revision; restore its package before continuing",
          );
      };
      if (operation.action === "list")
        return { automations: scheduler.list().filter(owns).map(summary) };
      if (operation.action === "create") {
        if (typeof scope.revision !== "string" || !/^[a-f0-9]{64}$/.test(scope.revision))
          throw Error("Automation requires a reviewed package revision");
        return summary(
          scheduler.create(operation.input.name, operation.input.schedule, operation.input.prompt, {
            cwd,
            resumeSessionId: scope.sessionId,
            timezone: operation.input.timezone,
            permissionLevel: "full",
            panelSource: { appId: scope.appId, revision: scope.revision },
            ...(operation.key
              ? {
                  creationKey: panelAutomationCreationKey(
                    scope.appId,
                    cwd,
                    scope.sessionId,
                    operation.key,
                  ),
                }
              : {}),
          }),
        );
      }
      const job = scheduler.get(operation.id);
      if (!job) throw Error("Automation task is unavailable");
      guard(job);
      if (operation.action === "update") {
        const updated = scheduler.update(job.id, operation.patch, guard);
        return updated ? summary(updated) : null;
      }
      return { ok: scheduler[operation.action](job.id, guard) };
    },
  };
  return { host, close, activeCount: () => active.size };
}
