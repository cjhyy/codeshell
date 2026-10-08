import {
  parseTaskInboxActionRequest,
  parseTaskInboxRecord,
  type TaskAction,
  type TaskInboxActionContext,
  type TaskInboxActionRequest,
  type TaskInboxActionResult,
  type TaskInboxRecordV1,
  type TaskSource,
} from "./task-inbox-types.js";
import type { TaskInboxProjector } from "./task-inbox-projector.js";

export interface TaskInboxActionAdapter {
  source: TaskSource;
  reread(
    record: TaskInboxRecordV1,
    context?: TaskInboxActionContext,
  ): TaskInboxRecordV1 | undefined | Promise<TaskInboxRecordV1 | undefined>;
  act(
    record: TaskInboxRecordV1,
    action: TaskAction,
    context?: TaskInboxActionContext,
  ): TaskInboxActionResult | Promise<TaskInboxActionResult>;
}
export interface TaskInboxActionsOptions {
  projector: Pick<TaskInboxProjector, "get" | "ingest">;
  adapters: TaskInboxActionAdapter[];
  onProjectionError?: (error: unknown) => void;
}
export class TaskInboxActions {
  private readonly adapters: Map<TaskSource, TaskInboxActionAdapter>;
  private readonly pending = new Map<string, Promise<TaskInboxActionResult>>();
  private readonly inflight = new Map<string, Promise<TaskInboxActionResult>>();
  private readonly completed = new Map<string, TaskInboxActionResult>();
  constructor(private readonly options: TaskInboxActionsOptions) {
    this.adapters = new Map(options.adapters.map((adapter) => [adapter.source, adapter]));
    if (this.adapters.size !== options.adapters.length)
      throw new Error("Duplicate task action adapter");
  }
  act(
    value: TaskInboxActionRequest,
    context?: TaskInboxActionContext,
  ): Promise<TaskInboxActionResult> {
    let request: TaskInboxActionRequest;
    try {
      request = parseTaskInboxActionRequest(value);
      if (context && (!Number.isSafeInteger(context.webContentsId) || context.webContentsId < 1))
        throw new Error("Invalid task action caller");
    } catch {
      return Promise.resolve({ status: "rejected", message: "Invalid task action request" });
    }
    const operationKey = JSON.stringify([
      request.taskKey,
      request.action,
      request.expectedRevision,
      context?.webContentsId,
    ]);
    const duplicate = this.inflight.get(operationKey);
    if (duplicate) return duplicate;
    const previous =
      this.pending.get(request.taskKey) ??
      Promise.resolve({ status: "ok" } as TaskInboxActionResult);
    const work = previous
      .catch(() => ({ status: "failed" }) as TaskInboxActionResult)
      .then(() => this.perform(request, context));
    this.pending.set(request.taskKey, work);
    this.inflight.set(operationKey, work);
    void work
      .finally(() => {
        if (this.pending.get(request.taskKey) === work) this.pending.delete(request.taskKey);
        if (this.inflight.get(operationKey) === work) this.inflight.delete(operationKey);
      })
      .catch(() => undefined);
    return work;
  }
  private async perform(
    request: TaskInboxActionRequest,
    context?: TaskInboxActionContext,
  ): Promise<TaskInboxActionResult> {
    try {
      const projected = this.options.projector.get(request.taskKey);
      if (!projected) return { status: "unavailable", message: "Task no longer exists" };
      const adapter = this.adapters.get(projected.source);
      if (!adapter || (projected.source === "legacy-run" && request.action !== "open"))
        return { status: "unavailable", message: "Source does not support this action" };
      const raw =
        (await adapter.reread(projected, context)) ??
        (request.action === "open" && projected.capabilities.includes("open")
          ? projected
          : undefined);
      if (!raw) return { status: "unavailable", message: "Task controller is unavailable" };
      const current = parseTaskInboxRecord(raw);
      if (
        current.taskKey !== projected.taskKey ||
        current.sourceId !== projected.sourceId ||
        current.source !== projected.source
      )
        return { status: "rejected", message: "Task identity changed" };
      this.publish(current);
      if (current.sourceRevision !== request.expectedRevision)
        return { status: "stale", message: "Task changed; refresh before acting", record: current };
      if (!current.capabilities.includes(request.action))
        return {
          status: "unavailable",
          message: "Action is unavailable in the current task state",
          record: current,
        };
      const operationKey = JSON.stringify([
        request.taskKey,
        request.action,
        request.expectedRevision,
        context?.webContentsId,
      ]);
      // Prevent queued double-clicks from issuing the same destructive operation
      // twice when a controller accepts work before updating its visible state.
      if (
        request.action !== "open" &&
        request.action !== "retry" &&
        this.completed.has(operationKey)
      )
        return structuredClone(this.completed.get(operationKey)!);
      const result = await adapter.act(current, request.action, context);
      if (!["ok", "stale", "unavailable", "rejected", "failed"].includes(result.status))
        return { status: "failed", message: "Invalid task controller response" };
      if (result.record) {
        const record = parseTaskInboxRecord(result.record);
        const nextAttempt =
          request.action === "retry" &&
          record.source === current.source &&
          record.sourceId === current.sourceId &&
          (record.attempt ?? 0) > (current.attempt ?? 0);
        if (record.taskKey !== current.taskKey && !nextAttempt)
          return { status: "failed", message: "Task controller returned a different task" };
        this.publish(record);
      }
      if (request.action !== "open" && request.action !== "retry" && result.status === "ok") {
        this.completed.set(operationKey, structuredClone(result));
        if (this.completed.size > 500) this.completed.delete(this.completed.keys().next().value!);
      }
      return result;
    } catch {
      return { status: "failed", message: "Task action failed" };
    }
  }
  private publish(record: TaskInboxRecordV1): void {
    try {
      this.options.projector.ingest(record);
    } catch (error) {
      // Projection is expendable. A failed cache write must not cancel or repeat
      // an accepted authoritative operation.
      try {
        this.options.onProjectionError?.(error);
      } catch {
        /* Diagnostics only. */
      }
    }
  }
}
export function createTaskInboxActions(options: TaskInboxActionsOptions): TaskInboxActions {
  return new TaskInboxActions(options);
}
