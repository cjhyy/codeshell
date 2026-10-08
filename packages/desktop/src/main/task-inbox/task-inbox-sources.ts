import { createHash } from "node:crypto";
import type { DiskSessionMeta } from "@cjhyy/code-shell-server/storage";
import type {
  PetLongTask,
  PetLongTaskControlRequest,
  PetLongTaskControlResult,
  PetLongTaskSnapshot,
} from "@cjhyy/code-shell-pet";
import type { SessionCatalogSnapshot, SessionSummary } from "../../shared/session-catalog.js";
import type { AutomationSummary } from "../automation-service.js";
import type { RunSummary } from "../runs-service.js";
import type {
  DesktopPetProjectionSnapshot,
  DesktopPetSession,
} from "../pet/pet-state-aggregator.js";
import type { TaskInboxActionAdapter } from "./task-inbox-actions.js";
import type { TaskInboxSourceReader } from "./task-inbox-projector.js";
import { mapTaskInboxRecord } from "./task-inbox-mappers.js";
import type {
  TaskAction,
  TaskInboxActionContext,
  TaskInboxActionResult,
  TaskInboxRecordV1,
  TaskSource,
  TaskStatus,
} from "./task-inbox-types.js";

/** Resolver-free subset of the generic worker's BackgroundWork response. */
export type TaskInboxBackgroundEntry = {
  sourceSession: { sessionId: string; title?: string };
  canCancel?: boolean;
  executionOrigin?: "worker" | "main";
} & (
  | {
      kind: "shell";
      shell: {
        shellId: string;
        sessionId: string;
        command: string;
        cwd: string;
        status: string;
        startedAt: number;
        exitedAt?: number;
        exitCode: number | null;
      };
    }
  | {
      kind: "subagent";
      agentId: string;
      childSessionId?: string;
      runtimeGeneration?: number;
      name?: string;
      description: string;
      status: string;
      startedAt: number;
      finishedAt?: number;
    }
  | {
      kind: "job";
      jobId: string;
      description: string;
      status: string;
      startedAt: number;
      finishedAt?: number;
      finalText?: string;
      cwd?: string;
      externalSessionId?: string;
    }
);

export interface TaskInboxSourcesDeps {
  diskSessions(): Promise<
    Array<DiskSessionMeta & { projectId?: string; createdAt?: number; automationId?: string }>
  >;
  sessionCatalog?(): Promise<SessionCatalogSnapshot>;
  sessionProjection?(): DesktopPetProjectionSnapshot | undefined;
  native: {
    hasLiveWorker(): boolean;
    isSessionRunning(sessionId: string): boolean;
    cancel(sessionId: string, context?: TaskInboxActionContext): Promise<boolean | void>;
  };
  runs?: { list(): Promise<RunSummary[]> };
  automations?: {
    list(): AutomationSummary[];
    get(id: string): AutomationSummary | null;
    pause(id: string): boolean;
    resume(id: string): boolean;
    runNow(id: string): boolean;
  };
  mimi?: {
    snapshot(): PetLongTaskSnapshot;
    get(id: string): PetLongTask | undefined;
    control(request: PetLongTaskControlRequest): Promise<PetLongTaskControlResult>;
  };
  external?: {
    hasSession(id: string): boolean;
    isSessionRunning?(id: string): boolean;
    hasPending?(id: string): boolean;
    kind?(id: string): string | undefined;
    interrupt(id: string, webContentsId?: number): Promise<void>;
  };
  background?: {
    available(): boolean;
    list(): Promise<TaskInboxBackgroundEntry[]>;
    cancel(entry: TaskInboxBackgroundEntry, context?: TaskInboxActionContext): Promise<boolean>;
  };
}

const TERMINAL = new Set(["done", "completed", "failed", "cancelled", "canceled"]);
const clean = (text: string | undefined, limit = 4096): string | undefined =>
  text?.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, "").slice(0, limit) || undefined;
const revision = (...parts: unknown[]): string =>
  createHash("sha256").update(JSON.stringify(parts)).digest("hex");
function statusOf(value: string | undefined): TaskStatus {
  switch (value) {
    case "queued":
    case "pending":
    case "starting":
      return "queued";
    case "running":
    case "cancelling":
    case "active":
      return "running";
    case "waiting":
    case "blocked":
      return "waiting";
    case "paused":
      return "paused";
    case "done":
    case "completed":
    case "succeeded":
      return "done";
    case "failed":
    case "error":
      return "failed";
    case "cancelled":
    case "canceled":
    case "killed":
      return "cancelled";
    default:
      return "interrupted";
  }
}

/** No global singleton is read here. All controls remain owned by their
 * authoritative service, and read-only historical sources cannot gain writes. */
export function createTaskInboxSources(deps: TaskInboxSourcesDeps): {
  readers: TaskInboxSourceReader[];
  adapters: TaskInboxActionAdapter[];
} {
  let pendingSessions: Promise<TaskInboxRecordV1[]> | undefined;
  let pendingBackground: Promise<TaskInboxBackgroundEntry[]> | undefined;

  const background = (): Promise<TaskInboxBackgroundEntry[]> => {
    if (!deps.background?.available()) return Promise.resolve([]);
    if (!pendingBackground) {
      pendingBackground = deps.background.list().finally(() => {
        pendingBackground = undefined;
      });
    }
    return pendingBackground;
  };

  const sessions = (): Promise<TaskInboxRecordV1[]> => {
    if (pendingSessions) return pendingSessions;
    pendingSessions = (async () => {
      const [disk, catalog] = await Promise.all([deps.diskSessions(), deps.sessionCatalog?.()]);
      const metadata = new Map<string, { row: SessionSummary; workspacePath: string }>();
      for (const [workspacePath, index] of Object.entries(catalog?.indices ?? {})) {
        for (const row of index.sessions) {
          if (row.engineSessionId) metadata.set(row.engineSessionId, { row, workspacePath });
        }
      }
      const projection = new Map(
        (deps.sessionProjection?.()?.sessions ?? []).map((row) => [row.agentSessionId, row]),
      );
      const diskById = new Map(disk.map((row) => [row.engineSessionId, row]));
      const records: TaskInboxRecordV1[] = [];
      for (const id of new Set([...diskById.keys(), ...projection.keys()])) {
        const durable = diskById.get(id);
        const live = projection.get(id);
        const meta = metadata.get(id);
        const isExternal =
          !!live?.external || !!deps.external?.kind?.(id) || !!deps.external?.hasSession(id);
        const source: TaskSource = isExternal ? "external-runtime" : "session";
        const nativeRunning =
          !isExternal && deps.native.hasLiveWorker() && deps.native.isSessionRunning(id);
        const externalRunning =
          isExternal &&
          !!deps.external?.hasSession(id) &&
          (deps.external.isSessionRunning
            ? deps.external.isSessionRunning(id)
            : live?.runState === "running");
        const externalWaiting =
          isExternal && !!deps.external?.hasSession(id) && !!deps.external.hasPending?.(id);
        const running = nativeRunning || externalRunning;
        const liveFresh =
          live?.freshness.workerState === "active" &&
          (isExternal ? !!deps.external?.hasSession(id) : deps.native.hasLiveWorker());
        let status = externalWaiting
          ? ("waiting" as const)
          : sessionStatus(durable, live, running, liveFresh);
        const capabilities: TaskAction[] = ["open"];
        if (running || externalWaiting || (liveFresh && status === "waiting"))
          capabilities.push("cancel");
        // Runtime allocation is not proof that a turn is active.
        if (
          isExternal &&
          !live &&
          !externalRunning &&
          !externalWaiting &&
          durable?.status === "active"
        )
          status = "interrupted";
        const updatedAt = Math.max(
          durable?.updatedAt ?? 0,
          live?.lastActivityAt ?? 0,
          meta?.row.updatedAt ?? 0,
        );
        records.push(
          mapTaskInboxRecord({
            source,
            sourceId: id,
            sessionId: id,
            title: clean(meta?.row.title ?? durable?.title ?? live?.title, 1024) ?? id,
            status,
            capabilities,
            createdAt: durable?.createdAt ?? meta?.row.createdAt ?? updatedAt,
            updatedAt,
            sourceRevision: revision(
              id,
              durable?.runId,
              live?.runId,
              status,
              updatedAt,
              capabilities,
            ),
            ...(durable?.automationId || meta?.row.cronJobId
              ? { automationId: durable?.automationId ?? meta?.row.cronJobId }
              : {}),
            ...(durable?.projectId ? { projectId: durable.projectId } : {}),
            ...(durable?.cwd || live?.external?.cwd || meta?.workspacePath
              ? { workspacePath: durable?.cwd || live?.external?.cwd || meta?.workspacePath }
              : {}),
            ...(clean(live?.summary) ? { summary: clean(live?.summary) } : {}),
            ...(live?.terminal?.at !== undefined && TERMINAL.has(status)
              ? { terminalAt: live.terminal.at }
              : {}),
          }),
        );
      }
      return records;
    })().finally(() => {
      pendingSessions = undefined;
    });
    return pendingSessions;
  };

  const automationRecord = (job: AutomationSummary): TaskInboxRecordV1 => {
    const capabilities: TaskAction[] = ["open", job.enabled ? "pause" : "resume", "retry"];
    return mapTaskInboxRecord({
      source: "automation",
      sourceId: job.id,
      automationId: job.id,
      title: clean(job.name, 1024) ?? job.id,
      status: job.enabled ? "queued" : "paused",
      capabilities,
      createdAt: job.createdAt,
      updatedAt: Math.max(job.createdAt, job.lastRun ?? 0),
      sourceRevision:
        job.revision ?? revision(job.id, job.enabled, job.schedule, job.runCount, job.lastRun),
      ...(job.cwd ? { workspacePath: job.cwd } : {}),
      ...(job.projectId ? { projectId: job.projectId } : {}),
      // An automation definition is distinct from its executions. Do not bind
      // resumeSessionId as sessionId, which would hide that conversation.
      summary: clean(job.schedule, 4096),
    });
  };

  const mimiRecord = (task: PetLongTask): TaskInboxRecordV1 => {
    const capabilities: TaskAction[] = ["open"];
    if (!TERMINAL.has(task.status)) {
      capabilities.push("cancel");
      if (task.status !== "paused") capabilities.push("pause");
    }
    if (task.status === "paused" || task.status === "interrupted") capabilities.push("resume");
    if (task.status === "failed" || task.status === "interrupted") capabilities.push("retry");
    if (task.status === "interrupted") capabilities.push("verify");
    return mapTaskInboxRecord({
      source: "mimi-delegation",
      sourceId: task.id,
      attempt: task.attempt,
      sessionId: task.sessionId,
      title: clean(task.objective, 1024) ?? task.id,
      status: task.status,
      capabilities,
      createdAt: task.createdAt,
      updatedAt: task.updatedAt,
      sourceRevision: String(task.revision),
      ...(task.workspacePath ? { workspacePath: task.workspacePath } : {}),
      ...(clean(task.resultSummary ?? task.waitingFor ?? task.summary)
        ? { summary: clean(task.resultSummary ?? task.waitingFor ?? task.summary) }
        : {}),
      ...(clean(task.lastError) ? { error: clean(task.lastError) } : {}),
      ...(task.completedAt !== undefined ? { terminalAt: task.completedAt } : {}),
      artifacts: task.artifacts.slice(0, 100).map((artifact) => ({
        kind: artifact.kind,
        label: clean(artifact.label, 1024) ?? artifact.kind,
        uri: clean(artifact.reference, 4096) ?? task.sessionId,
      })),
    });
  };

  const backgroundRecord = (entry: TaskInboxBackgroundEntry): TaskInboxRecordV1 => {
    const shell = entry.kind === "shell" ? entry.shell : undefined;
    const source: TaskSource =
      entry.kind === "shell"
        ? "background-shell"
        : entry.kind === "job"
          ? "background-job"
          : "subagent";
    const workId = shell
      ? shell.shellId
      : entry.kind === "subagent"
        ? entry.agentId
        : entry.kind === "job"
          ? entry.jobId
          : "";
    const startedAt = shell ? shell.startedAt : entry.kind !== "shell" ? entry.startedAt : 0;
    const finishedAt = shell
      ? shell.exitedAt
      : entry.kind !== "shell"
        ? entry.finishedAt
        : undefined;
    // Shell ids are process-local counters. Fence every registry identity by
    // owner and start/generation so a new worker cannot overwrite old results.
    const sourceId = `${workId}:${revision(entry.executionOrigin, entry.sourceSession.sessionId, startedAt, entry.kind === "subagent" ? entry.runtimeGeneration : undefined).slice(0, 24)}`;
    const rawStatus = shell ? shell.status : entry.kind !== "shell" ? entry.status : undefined;
    const status =
      shell?.status === "exited" ? (shell.exitCode === 0 ? "done" : "failed") : statusOf(rawStatus);
    const capabilities: TaskAction[] = ["open"];
    if (
      entry.canCancel &&
      deps.background?.available() &&
      ["queued", "running"].includes(status) &&
      rawStatus !== "cancelling"
    )
      capabilities.push("cancel");
    const sessionId =
      entry.kind === "subagent"
        ? (entry.childSessionId ?? entry.sourceSession.sessionId)
        : entry.sourceSession.sessionId;
    return mapTaskInboxRecord({
      source,
      sourceId,
      sessionId,
      parentSessionId: entry.sourceSession.sessionId,
      title:
        clean(shell?.command ?? (entry.kind !== "shell" ? entry.description : undefined), 1024) ??
        sourceId,
      status,
      capabilities,
      createdAt: startedAt,
      updatedAt: finishedAt ?? startedAt,
      sourceRevision: revision(
        sourceId,
        startedAt,
        entry.kind === "subagent" ? entry.runtimeGeneration : undefined,
        status,
        capabilities,
      ),
      ...(shell?.cwd || (entry.kind === "job" && entry.cwd)
        ? { workspacePath: shell?.cwd || (entry.kind === "job" ? entry.cwd : undefined) }
        : {}),
      ...(entry.kind === "job" && clean(entry.finalText)
        ? { [status === "failed" ? "error" : "summary"]: clean(entry.finalText) }
        : {}),
      ...(finishedAt !== undefined ? { terminalAt: finishedAt } : {}),
    });
  };

  const readSource = async (source: TaskSource): Promise<TaskInboxRecordV1[]> => {
    if (source === "session" || source === "external-runtime")
      return (await sessions()).filter((record) => record.source === source);
    if (source === "automation") return deps.automations?.list().map(automationRecord) ?? [];
    if (source === "mimi-delegation") return deps.mimi?.snapshot().tasks.map(mimiRecord) ?? [];
    if (source === "legacy-run")
      return ((await deps.runs?.list()) ?? []).map((run) =>
        mapTaskInboxRecord({
          source,
          sourceId: run.runId,
          title: clean(run.objective, 1024) ?? run.runId,
          status: TERMINAL.has(run.status) ? statusOf(run.status) : "interrupted",
          capabilities: ["open"],
          createdAt: run.createdAt,
          updatedAt: run.updatedAt,
          sourceRevision: revision(run.runId, run.updatedAt, run.status),
          ...(run.sessionId ? { sessionId: run.sessionId } : {}),
          ...(run.cwd ? { workspacePath: run.cwd } : {}),
          ...(clean(run.summary ?? undefined) ? { summary: clean(run.summary ?? undefined) } : {}),
          ...(clean(run.error ?? undefined) ? { error: clean(run.error ?? undefined) } : {}),
          ...(run.finishedAt !== null ? { terminalAt: run.finishedAt } : {}),
        }),
      );
    return (await background()).map(backgroundRecord).filter((record) => record.source === source);
  };

  const reread = async (record: TaskInboxRecordV1): Promise<TaskInboxRecordV1 | undefined> => {
    if (record.source === "automation") {
      const current = deps.automations?.get(record.sourceId);
      return current ? automationRecord(current) : undefined;
    }
    if (record.source === "mimi-delegation") {
      const current = deps.mimi?.get(record.sourceId);
      return current && current.attempt === record.attempt ? mimiRecord(current) : undefined;
    }
    return (await readSource(record.source)).find((current) => current.taskKey === record.taskKey);
  };

  const act = async (
    record: TaskInboxRecordV1,
    action: TaskAction,
    context?: TaskInboxActionContext,
  ): Promise<TaskInboxActionResult> => {
    if (action === "open") return { status: "ok", record };
    // Also protect direct adapter callers. Generic routing supplies another
    // authoritative read and revision check before entering this boundary.
    const current = await reread(record);
    if (!current)
      return { status: "unavailable", message: "The source task is no longer available" };
    if (current.sourceRevision !== record.sourceRevision)
      return { status: "stale", record: current };
    if (!current.capabilities.includes(action)) return { status: "unavailable", record: current };
    try {
      let ok = false;
      if (record.source === "session" && action === "cancel") {
        ok = (await deps.native.cancel(record.sourceId, context)) !== false;
      } else if (
        record.source === "external-runtime" &&
        action === "cancel" &&
        deps.external?.hasSession(record.sourceId)
      ) {
        await deps.external.interrupt(record.sourceId, context?.webContentsId);
        ok = true;
      } else if (record.source === "automation" && deps.automations) {
        ok =
          action === "pause"
            ? deps.automations.pause(record.sourceId)
            : action === "resume"
              ? deps.automations.resume(record.sourceId)
              : action === "retry"
                ? deps.automations.runNow(record.sourceId)
                : false;
      } else if (record.source === "mimi-delegation" && deps.mimi) {
        const result = await deps.mimi.control({
          taskId: record.sourceId,
          action: action === "verify" ? "resume" : (action as PetLongTaskControlRequest["action"]),
        });
        return result.ok
          ? { status: "ok", record: mimiRecord(result.task) }
          : {
              status:
                result.code === "not-found"
                  ? "unavailable"
                  : result.code === "invalid-state"
                    ? "rejected"
                    : "failed",
              message: result.message,
            };
      } else if (
        ["subagent", "background-shell", "background-job"].includes(record.source) &&
        action === "cancel" &&
        deps.background?.available()
      ) {
        const entry = (await background()).find((candidate) => {
          const mapped = backgroundRecord(candidate);
          return (
            mapped.taskKey === current.taskKey && mapped.sourceRevision === current.sourceRevision
          );
        });
        if (entry) ok = await deps.background.cancel(entry, context);
      }
      const updated = await reread(current);
      return { status: ok ? "ok" : "unavailable", ...(updated ? { record: updated } : {}) };
    } catch (error) {
      return { status: "failed", message: error instanceof Error ? error.message : String(error) };
    }
  };

  const sources: TaskSource[] = [
    "session",
    "legacy-run",
    "automation",
    "mimi-delegation",
    "subagent",
    "background-shell",
    "background-job",
    "external-runtime",
  ];
  return {
    readers: sources.map((source) => ({ source, read: () => readSource(source) })),
    adapters: sources.map((source) => ({ source, reread, act })),
  };
}

function sessionStatus(
  disk: DiskSessionMeta | undefined,
  live: DesktopPetSession | undefined,
  running: boolean,
  liveFresh: boolean,
): TaskStatus {
  if (liveFresh && live && live.pendingDecisionCount > 0) return "waiting";
  if (running) return "running";
  // A newer, normal live terminal boundary supersedes an old disk yield. A
  // background_wait/limit boundary deliberately has no ordinary completion.
  if (live?.terminal && !live.completionKind && (!disk || live.terminal.at >= disk.updatedAt)) {
    return statusOf(live.terminal.status);
  }
  if (disk?.completionKind === "background_wait" || live?.completionKind === "background_wait")
    return liveFresh ? "waiting" : "interrupted";
  if (
    disk?.completionKind === "goal_control_stop" ||
    disk?.completionKind === "limit_stop" ||
    live?.completionKind === "goal_control_stop" ||
    live?.completionKind === "limit_stop"
  )
    return "interrupted";
  if (live?.terminal && (!disk || live.terminal.at >= disk.updatedAt))
    return statusOf(live.terminal.status);
  if (disk?.status === "paused") return "paused";
  if (disk && TERMINAL.has(disk.status ?? "")) return statusOf(disk.status);
  return "interrupted";
}
