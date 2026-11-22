import { BrowserWindow, dialog, ipcMain } from "electron";
import type { IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { AppRendererNavigation } from "./app-renderer-navigation.js";
import { resolveNoRepoCwd } from "./agent-bridge.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { requireRendererOrSessionPath, type PtyStartRequest } from "./renderer-session-path.js";
import { ptyStart, ptyWrite, ptyResize, ptyKill, assertValidPtySessionId } from "./pty-service.js";
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

  // ── Terminal (pty) — interactive shell panel ───────────────────────────────
  // Output streams back to the requesting webContents via "pty:data"/"pty:exit".
  ipcMain.handle("pty:start", async (e, opts: PtyStartRequest) => {
    if (!opts) throw new Error("pty:start requires sessionId");
    assertValidPtySessionId(opts.sessionId);
    // A Session's managed worktree is authorized only through that Session.
    const cwd = await requireRendererOrSessionPath(
      opts.cwd ?? resolveNoRepoCwd(),
      opts.engineSessionId,
    );
    return ptyStart(e.sender, { ...opts, cwd });
  });
  ipcMain.handle("pty:write", (e, sessionId: string, data: string, reply?: unknown) => {
    assertValidPtySessionId(sessionId);
    if (typeof data !== "string" || data.length > 1024 * 1024) {
      throw new Error("invalid pty input");
    }
    ptyWrite(e.sender, sessionId, data, reply === true);
  });
  ipcMain.handle("pty:resize", (e, sessionId: string, cols: number, rows: number) => {
    assertValidPtySessionId(sessionId);
    ptyResize(e.sender, sessionId, cols, rows);
  });
  ipcMain.handle("pty:kill", (e, sessionId: string) => {
    assertValidPtySessionId(sessionId);
    ptyKill(e.sender, sessionId);
  });

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
