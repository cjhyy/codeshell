import { BrowserWindow, dialog, ipcMain } from "electron";
import { AppRendererNavigation } from "./app-renderer-navigation.js";
import { resolveNoRepoCwd } from "./agent-bridge.js";
import { requireRendererProjectPath, requireRendererProjectRoot } from "./renderer-project-path.js";
import { requireRendererOrSessionPath, type PtyStartRequest } from "./renderer-session-path.js";
import { ptyStart, ptyWrite, ptyResize, ptyKill, assertValidPtySessionId } from "./pty-service.js";
import { readDirectory, readFile as fsReadFile, fileExists as fsFileExists } from "./fs-service.js";
import { registerFileVersionIpc } from "./file-version-ipc.js";
import { registerLocalFilePreviewIpc } from "./local-file-preview-ipc.js";
import { registerProfilePluginExportIpc } from "./profile-plugin-export-ipc.js";
import {
  openExternal,
  revealInFinder,
  openPath,
  openInEditor,
  undoFiles,
  type UndoFilesResult,
} from "./desktop-services.js";
import { turnUndoState, undoTurn, redoTurn } from "./file-history-service.js";
import { assertDesktopSessionId } from "./session-validation.js";
import {
  readSessionDirectoryForUi,
  readSessionFileForUi,
  sessionFileExistsForUi,
} from "./session-fs-service.js";
import { resolveRendererConfigurationTarget } from "./renderer-configuration-authority.js";

export interface WorkspaceFilesIpcDeps {
  appRendererNavigation: AppRendererNavigation;
  mainWindows: Set<BrowserWindow>;
  assertRendererSessionAccess: (sessionId: unknown, senderWebContentsId: number) => string;
}

/** Shell open/reveal, file and turn undo, terminal (pty) and project/Session file-read routes. */
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

  ipcMain.handle(
    "files:undo",
    async (_e, cwd: string, paths: string[]): Promise<UndoFilesResult[]> => {
      cwd = await requireRendererProjectPath(cwd);
      if (
        !Array.isArray(paths) ||
        paths.length === 0 ||
        paths.length > 100 ||
        paths.some(
          (path) => typeof path !== "string" || path.length > 32_768 || path.includes("\0"),
        )
      ) {
        throw new Error("files:undo requires non-empty paths");
      }
      return undoFiles(cwd, paths);
    },
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
  ipcMain.handle("pty:write", (e, sessionId: string, data: string) => {
    assertValidPtySessionId(sessionId);
    if (typeof data !== "string" || data.length > 1024 * 1024) {
      throw new Error("invalid pty input");
    }
    ptyWrite(e.sender, sessionId, data);
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
  registerFileVersionIpc(ipcMain);
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
  ipcMain.handle("fsRoot:readDir", async (_e, projectId: string, rootId: string, dir?: string) => {
    const root = await requireRendererProjectRoot(projectId, rootId);
    return readDirectory(root.path, typeof dir === "string" && dir ? dir : root.path);
  });
  ipcMain.handle("fsRoot:readFile", async (_e, projectId: string, rootId: string, path: string) => {
    const root = await requireRendererProjectRoot(projectId, rootId);
    if (typeof path !== "string" || !path) throw new Error("fsRoot:readFile requires path");
    return fsReadFile(root.path, path);
  });
  ipcMain.handle("fsRoot:exists", async (_e, projectId: string, rootId: string, path: string) => {
    const root = await requireRendererProjectRoot(projectId, rootId).catch(() => null);
    if (!root || typeof path !== "string" || !path) return false;
    return fsFileExists(root.path, path);
  });
  ipcMain.handle(
    "fsSession:readDir",
    async (_e, sessionId: string, rootId: string, dir?: string) => {
      assertDesktopSessionId(sessionId);
      return readSessionDirectoryForUi(sessionId, rootId, dir);
    },
  );
  ipcMain.handle(
    "fsSession:readFile",
    async (_e, sessionId: string, rootId: string, path: string) => {
      assertDesktopSessionId(sessionId);
      return readSessionFileForUi(sessionId, rootId, path);
    },
  );
  ipcMain.handle(
    "fsSession:exists",
    async (_e, sessionId: string, rootId: string, path: string) => {
      assertDesktopSessionId(sessionId);
      return sessionFileExistsForUi(sessionId, rootId, path);
    },
  );
}
