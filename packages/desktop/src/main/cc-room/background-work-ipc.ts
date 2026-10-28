import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import {
  findActiveBackgroundJobForExternalSession,
  markBackgroundJobInterruptedForUI,
} from "@cjhyy/code-shell-core/internal";
import { createTaskInboxBackgroundHost } from "../task-inbox/task-inbox-background-host.js";
import type { TaskInboxSourcesDeps } from "../task-inbox/task-inbox-sources.js";

type BackgroundHost = NonNullable<TaskInboxSourcesDeps["background"]>;

/** Share the existing host-authorized controllers with the external task page. */
export function registerBackgroundWorkIpc(
  ipcMain: Pick<IpcMain, "handle">,
  windows: Iterable<BrowserWindow>,
  worker: Parameters<typeof createTaskInboxBackgroundHost>[0]["worker"],
  deps: {
    host?: BackgroundHost;
    markInterrupted?: typeof markBackgroundJobInterruptedForUI;
  } = {},
): void {
  const host = deps.host ?? createTaskInboxBackgroundHost({ worker });
  const markInterrupted = deps.markInterrupted ?? markBackgroundJobInterruptedForUI;
  const requireWindow = (event: IpcMainInvokeEvent) => {
    if (
      ![...windows].some(
        (window) => !window.isDestroyed() && window.webContents === event.sender,
      ) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Background work requires an application window");
  };
  const requireId = (id: unknown): string => {
    if (typeof id !== "string" || !id.trim() || id.length > 1024)
      throw new Error("Invalid background work identity");
    return id;
  };
  ipcMain.handle(
    "backgroundWork:list",
    async (event, sessionId: unknown, options?: { scope?: unknown }) => {
      requireWindow(event);
      const owner = requireId(sessionId);
      if (options?.scope !== undefined && options.scope !== "all" && options.scope !== "session")
        throw new Error("Invalid background work scope");
      const items = await host.list();
      return {
        items: items
          .filter((entry) => options?.scope === "all" || entry.sourceSession.sessionId === owner)
          .map(({ executionOrigin: _origin, ...entry }) => ({
            ...entry,
            sourceSession: {
              ...entry.sourceSession,
              current: entry.sourceSession.sessionId === owner,
            },
          })),
      };
    },
  );
  ipcMain.handle(
    "backgroundWork:cancelJob",
    async (event, sessionId: unknown, jobId: unknown, expectedStartedAt: unknown) => {
      requireWindow(event);
      const owner = requireId(sessionId);
      const id = requireId(jobId);
      if (typeof expectedStartedAt !== "number" || !Number.isFinite(expectedStartedAt))
        throw new Error("Invalid background work attempt");
      const job = (await host.list()).find(
        (entry) =>
          entry.kind === "job" &&
          entry.jobId === id &&
          entry.sourceSession.sessionId === owner &&
          entry.startedAt === expectedStartedAt,
      );
      if (!job || job.kind !== "job" || job.status !== "running" || !job.canCancel)
        return { cancelled: false };
      return { cancelled: await host.cancel(job, { webContentsId: event.sender.id }) };
    },
  );
  ipcMain.handle(
    "backgroundWork:markInterrupted",
    async (event, sessionId: unknown, jobId: unknown, expectedStartedAt: unknown) => {
      requireWindow(event);
      const owner = requireId(sessionId);
      const id = requireId(jobId);
      if (typeof expectedStartedAt !== "number" || !Number.isFinite(expectedStartedAt))
        throw new Error("Invalid background work attempt");
      // host.list throws when the worker cannot answer, so a job only that
      // worker controls can never be resolved from a stale snapshot here.
      const job = (await host.list()).find(
        (entry) =>
          entry.kind === "job" &&
          entry.jobId === id &&
          entry.sourceSession.sessionId === owner &&
          entry.startedAt === expectedStartedAt,
      );
      if (!job || job.kind !== "job" || job.status !== "unknown") return { marked: false };
      return {
        marked: markInterrupted({ sessionId: owner, jobId: id, expectedStartedAt }),
      };
    },
  );
}

/** Called before a new resident CLI can take over a DriveAgent-owned session.
 * Every process persists its DriveAgent ownership, so this reads only local
 * state and never waits on the worker (CC room sends call it per message). */
export function assertExternalSessionIdle(
  externalSessionId: unknown,
  kind: unknown,
  find: typeof findActiveBackgroundJobForExternalSession = findActiveBackgroundJobForExternalSession,
): void {
  if (typeof externalSessionId !== "string" || (kind !== "claude-code" && kind !== "codex"))
    throw new Error("Invalid external session target");
  const owner = find(kind === "claude-code" ? "claude" : "codex", externalSessionId);
  if (!owner) return;
  throw new Error(
    owner.unknownReason === "orphaned-process"
      ? "This session's background task lost its controller, but its CLI process is still running. Open the task page and mark it ended once that process has exited."
      : owner.unknownReason === "other-process"
        ? "This session is owned by a background task in another CodeShell process. Wait for it to finish, or mark it ended from the task page if that process is gone."
        : "This session is owned by a background task. Stop the task and wait for its exit before taking over.",
  );
}
