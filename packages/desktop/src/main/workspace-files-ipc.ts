import { BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { AppRendererNavigation } from "./app-renderer-navigation.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import type { PtyStartRequest, TerminalCommands } from "../shared/pty.js";
import { registerLocalFilePreviewIpc } from "./local-file-preview-ipc.js";
import { registerProfilePluginExportIpc } from "./profile-plugin-export-ipc.js";
import {
  openExternal,
  revealInFinder,
  openPath,
  openInEditor,
} from "./desktop-services.js";
import { turnUndoState, undoTurn, redoTurn } from "./file-history-service.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";

export interface WorkspaceFilesIpcDeps {
  terminal(
    event: Electron.IpcMainInvokeEvent,
    method: keyof TerminalCommands,
    params: Record<string, unknown>,
  ): Promise<unknown>;
  appRendererNavigation: AppRendererNavigation;
  mainWindows: Set<BrowserWindow>;
  business: CallShellBusiness;
  documentSignal(event: IpcMainInvokeEvent): AbortSignal;
  assertRendererSessionAccess: (sessionId: unknown, senderWebContentsId: number) => string;
}

/** Shell open/reveal, file and turn undo, terminal (pty) routes. */
export function registerWorkspaceFilesIpc(deps: WorkspaceFilesIpcDeps) {
  const { appRendererNavigation, mainWindows, assertRendererSessionAccess } = deps;
  ipcMain.handle("shell:openExternal", async (event, url: string) => {
    appRendererNavigation.assertSender(event);
    if (typeof url !== "string" || !url || url.length > 16_384 || url.includes("\0")) {
      throw new Error("openExternal requires a bounded url");
    }
    await openExternal(url);
  });

  ipcMain.handle("shell:revealInFinder", async (_e, p: string, cwd?: string) => {
    if (typeof p !== "string" || !p || p.length > 32_768 || p.includes("\0")) {
      throw new Error("revealInFinder requires a bounded path");
    }
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
    await revealInFinder(p, authorizedCwd);
  });

  ipcMain.handle("shell:openPath", async (_e, p: string, cwd?: string) => {
    if (typeof p !== "string" || !p || p.length > 32_768 || p.includes("\0")) {
      throw new Error("openPath requires a bounded path");
    }
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
    return openPath(p, authorizedCwd);
  });

  ipcMain.handle("shell:openInEditor", async (_e, p: string, cwd?: string) => {
    if (typeof p !== "string" || !p || p.length > 32_768 || p.includes("\0")) {
      throw new Error("openInEditor requires a bounded path");
    }
    const authorizedCwd = cwd ? await requireRendererProjectPath(cwd) : undefined;
    return openInEditor(p, authorizedCwd);
  });

  ipcMain.handle("files:undo", (event, cwd: string, paths: string[]) =>
    deps.business("git/undoFiles", { cwd, paths }, deps.documentSignal(event)),
  );

  // Turn-level undo/redo via core FileHistory snapshots (keyed by sessionId, not
  // cwd). Always operates on the latest turn internally — see file-history-service.
  ipcMain.handle("files:turnUndoState", async (event, sessionId: unknown) => {
    return turnUndoState(assertRendererSessionAccess(sessionId, event.sender.id));
  });
  ipcMain.handle("files:undoTurn", async (event, sessionId: unknown) => {
    return undoTurn(assertRendererSessionAccess(sessionId, event.sender.id));
  });
  ipcMain.handle("files:redoTurn", async (event, sessionId: unknown) => {
    return redoTurn(assertRendererSessionAccess(sessionId, event.sender.id));
  });

  // Older/prefer-IPC workbenches still use the single Host-owned PTY registry.
  ipcMain.handle("pty:start", (event, input: PtyStartRequest) => {
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw Error("Invalid terminal options");
    return deps.terminal(event, "pty/start", { ...input });
  });
  ipcMain.handle("pty:write", (event, sessionId, data, reply) =>
    deps.terminal(event, "pty/write", { sessionId, data, reply: reply === true }),
  );
  ipcMain.handle("pty:resize", (event, sessionId, cols, rows) =>
    deps.terminal(event, "pty/resize", { sessionId, cols, rows }),
  );
  ipcMain.handle("pty:kill", (event, sessionId) => deps.terminal(event, "pty/kill", { sessionId }));

  // ── Filesystem reads — file-browser panel ──────────────────────────────────
  registerLocalFilePreviewIpc(ipcMain, (sender) =>
    [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
  );
  registerProfilePluginExportIpc(
    ipcMain,
    dialog,
    BrowserWindow,
    (sender) =>
      [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
    resolveRendererConfigurationTarget,
  );
}
