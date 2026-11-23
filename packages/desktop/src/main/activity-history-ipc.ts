import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { join } from "node:path";
import { sessionsRoot } from "@cjhyy/code-shell-core";
import { configureModelTracing } from "@cjhyy/code-shell-core/internal";
import { archiveDiskSession } from "@cjhyy/code-shell-server/storage";
import { getSessionCwdIndex } from "./session-cwd-index.js";
import { assertDesktopSessionId } from "./session-validation.js";
import { registerSessionTranscriptIpc } from "./session-transcript-ipc.js";
import { registerModelTraceIpc } from "./model-trace-ipc.js";

/** Activity history keeps its validation and store ownership outside the Desktop composition root. */
export function registerActivityHistoryIpc(
  ipcMain: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  archive: typeof archiveDiskSession | undefined,
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal },
) {
  configureModelTracing({ storageDir: join(sessionsRoot(), ".model-traces"), source: "desktop" });
  const { callBusiness, documentSignal } = host;
  ipcMain.handle("sessions:setArchived", async (_event, id: string, archived: boolean) => {
    assertDesktopSessionId(id);
    if (typeof archived !== "boolean") throw new Error("archived must be a boolean");
    await (archive ?? archiveDiskSession)(id, archived ? Date.now() : undefined);
    await getSessionCwdIndex().refresh(id);
  });
  ipcMain.handle("sessions:titles", (event) =>
    callBusiness("activity/titles", {}, documentSignal(event)),
  );
  ipcMain.handle("sessions:rename", (event, id, title) =>
    callBusiness("activity/setTitle", { id, title }, documentSignal(event)),
  );
  ipcMain.handle("logs:tail", (event, bucket, lines) =>
    callBusiness("activity/logTail", { bucket, lines }, documentSignal(event)),
  );
  ipcMain.handle("usage:summary", (event, query) =>
    callBusiness("activity/usage", { query }, documentSignal(event)),
  );
  ipcMain.handle("runs:list", (event, options) =>
    callBusiness(
      "activity/runs",
      { includeSessions: options?.includeSessions },
      documentSignal(event),
    ),
  );
  ipcMain.handle("runs:get", (event, runId) =>
    callBusiness("activity/run", { runId }, documentSignal(event)),
  );
  registerSessionTranscriptIpc(ipcMain);
  const traces = registerModelTraceIpc(ipcMain, windows, (event) => {
    const signal = documentSignal(event);
    return {
      list: (query) => callBusiness("trace/list", query, signal),
      sessions: (query) => callBusiness("trace/sessions", query, signal),
      get: (id) => callBusiness("trace/get", id, signal),
      getConfig: () => callBusiness("trace/config", undefined, signal),
      setConfig: (patch) => callBusiness("trace/setConfig", patch, signal),
    };
  });
  return {
    dispose: async () => {
      ipcMain.removeHandler("usage:summary");
      traces.dispose();
    },
  };
}
