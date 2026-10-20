import type { BrowserWindow, IpcMain } from "electron";
import { join } from "node:path";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { configureModelTracing } from "@cjhyy/code-shell-core/internal";
import { archiveDiskSession, listSessions } from "@cjhyy/code-shell-server/storage";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { listTitles, setTitle } from "./session-titles-store.js";
import { tailLog, type LogBucket } from "./logs-service.js";
import { readUsageHistory } from "./usage-history-service.js";
import { listRunsForUi, getRunHistory } from "./run-history-service.js";
import { registerSessionTranscriptIpc } from "./session-transcript-ipc.js";
import { registerModelTraceIpc } from "./model-trace-ipc.js";

/** Activity history keeps its validation and store ownership outside the Desktop composition root. */
export function registerActivityHistoryIpc(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
) {
  configureModelTracing({ storageDir: join(sessionsRoot(), ".model-traces"), source: "desktop" });
  ipcMain.handle("sessions:setArchived", async (_event, id: string, archived: boolean) => {
    assertDesktopSessionId(id);
    if (typeof archived !== "boolean") throw new Error("archived must be a boolean");
    await archiveDiskSession(id, archived ? Date.now() : undefined);
    await getSessionCwdIndex().refresh(id);
  });
  ipcMain.handle("sessions:list", async () => listSessions());
  ipcMain.handle("sessions:titles", async () => listTitles());
  ipcMain.handle("sessions:rename", async (_e, id: string, title: string) => {
    assertDesktopSessionId(id);
    if (typeof title !== "string" || title.length > 1_024 || title.includes("\0")) {
      throw new Error("title must be a bounded string");
    }
    await setTitle(id, title);
  });

  ipcMain.handle("logs:tail", async (_e, bucket: LogBucket, lines?: number) => {
    if (bucket !== "ui-ink" && bucket !== "engine" && bucket !== "desktop") {
      throw new Error("invalid bucket");
    }
    const boundedLines =
      typeof lines === "number" && Number.isSafeInteger(lines) && lines > 0
        ? Math.min(lines, 10_000)
        : undefined;
    return tailLog(bucket, boundedLines);
  });

  ipcMain.handle("usage:summary", async (_e, query) => readUsageHistory(query));

  ipcMain.handle("runs:list", async (_e, options?: { includeSessions?: boolean }) =>
    listRunsForUi(options),
  );
  ipcMain.handle("runs:get", async (_e, runId: string) => {
    if (typeof runId !== "string") throw new Error("runId required");
    return getRunHistory(runId);
  });
  registerSessionTranscriptIpc(ipcMain);
  return registerModelTraceIpc(ipcMain, windows);
}
