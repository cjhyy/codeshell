import type { IpcMain } from "electron";
import { assertDesktopSessionId } from "./session-validation.js";
import { requireSessionFileRootForUi } from "./session-workspace-service.js";
import { requireRendererProjectRoot } from "./renderer-project-path.js";
import { readGitBlobVersion } from "./file-version-service.js";

interface FileVersionIpcDependencies {
  requireSessionRoot: typeof requireSessionFileRootForUi;
  requireProjectRoot: (projectId: string, rootId: string) => Promise<{ path: string }>;
  readVersion: typeof readGitBlobVersion;
}
export function registerFileVersionIpc(
  ipcMain: Pick<IpcMain, "handle">,
  dependencies: FileVersionIpcDependencies = {
    requireSessionRoot: requireSessionFileRootForUi,
    requireProjectRoot: requireRendererProjectRoot,
    readVersion: readGitBlobVersion,
  },
): void {
  ipcMain.handle(
    "fsSession:readFileVersion",
    async (_event, sessionId: string, rootId: string, ref: unknown) => {
      assertDesktopSessionId(sessionId);
      const root = await dependencies.requireSessionRoot(sessionId, rootId);
      return dependencies.readVersion(root, ref);
    },
  );
  ipcMain.handle(
    "fsRoot:readFileVersion",
    async (_event, projectId: string, rootId: string, ref: unknown) => {
      const root = await dependencies.requireProjectRoot(projectId, rootId);
      return dependencies.readVersion(root.path, ref);
    },
  );
}
