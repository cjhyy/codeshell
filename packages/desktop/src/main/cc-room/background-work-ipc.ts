import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type { TaskInboxSourcesDeps } from "../task-inbox/task-inbox-sources.js";

type BackgroundHost = NonNullable<TaskInboxSourcesDeps["background"]>;

/** Share the existing host-authorized controllers with the external task page. */
export function registerBackgroundWorkIpc(
  ipc: Pick<IpcMain, "handle">,
  windows: () => BrowserWindow[],
  host: BackgroundHost,
): void {
  const requireWindow = (event: IpcMainInvokeEvent) => {
    if (
      !windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) ||
      event.senderFrame !== event.sender.mainFrame
    )
      throw new Error("Background work requires an application window");
  };
  const requireId = (id: unknown): string => {
    if (typeof id !== "string" || !id.trim() || id.length > 1024)
      throw new Error("Invalid background work identity");
    return id;
  };
  ipc.handle(
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
  ipc.handle(
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
}

/** Called before a new resident CLI can take over a DriveAgent-owned session. */
export async function assertExternalSessionIdle(
  host: BackgroundHost,
  externalSessionId: unknown,
  kind: unknown,
): Promise<void> {
  if (typeof externalSessionId !== "string" || (kind !== "claude-code" && kind !== "codex"))
    throw new Error("Invalid external session target");
  const cli = kind === "claude-code" ? "claude" : "codex";
  const jobs = await host.list();
  const owned = jobs.some(
    (entry) =>
      entry.kind === "job" &&
      entry.externalSessionId === externalSessionId &&
      entry.cli === cli &&
      ["running", "cancelling", "unknown"].includes(entry.status),
  );
  if (owned)
    throw new Error(
      "This session is owned by a background task. Stop the task and wait for its exit before taking over; an unknown task status cannot confirm that it has exited.",
    );
}
