import { ipcMain, type BrowserWindow, type IpcMainInvokeEvent } from "electron";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { registerProfileMemoryPromotionIpc } from "./profile-memory-promotion-ipc.js";

export function registerMemoryIpc({
  mainWindows,
  host,
}: {
  mainWindows: Set<BrowserWindow>;
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal };
}) {
  const { callBusiness, documentSignal } = host;
  ipcMain.handle("memory:list", (event, level, scope, cwd, profileName) =>
    callBusiness("memory/list", { level, scope, cwd, profileName }, documentSignal(event)),
  );
  ipcMain.handle("memory:read", (event, level, scope, name, cwd, profileName) =>
    callBusiness("memory/read", { level, scope, name, cwd, profileName }, documentSignal(event)),
  );
  ipcMain.handle("memory:pending:list", (event) =>
    callBusiness("memory/pending", {}, documentSignal(event)),
  );
  ipcMain.handle("memory:save", (event, input) =>
    callBusiness("memory/save", input, documentSignal(event)),
  );
  ipcMain.handle("memory:delete", (event, level, scope, name, cwd, profileName) =>
    callBusiness("memory/delete", { level, scope, name, cwd, profileName }, documentSignal(event)),
  );
  ipcMain.handle("memory:pending:approve", (event, name) =>
    callBusiness("memory/approve", { name }, documentSignal(event)),
  );
  ipcMain.handle("memory:pending:demote", (event, name) =>
    callBusiness("memory/demote", { name }, documentSignal(event)),
  );
  ipcMain.handle("memory:pending:reject", (event, name) =>
    callBusiness("memory/reject", { name }, documentSignal(event)),
  );
  ipcMain.handle("memory:promote", (event, cwd, name) =>
    callBusiness("memory/promote", { cwd, name }, documentSignal(event)),
  );
  ipcMain.handle("memory:dream", (event, level, cwd) =>
    callBusiness("memory/dream", { level, cwd }, documentSignal(event)),
  );
  registerProfileMemoryPromotionIpc(
    ipcMain,
    (sender) =>
      [...mainWindows].some((window) => !window.isDestroyed() && window.webContents === sender),
    requireRendererProjectPath,
    {
      documentSignal,
      preview: (owner, value, signal) =>
        callBusiness("memory/previewProfilePromotion", { owner, value }, signal),
      commit: (owner, value, signal) =>
        callBusiness("memory/commitProfilePromotion", { owner, value }, signal),
      clearOwner: (owner) => {
        void callBusiness("memory/discardProfilePromotion", { owner }).catch(() => {});
      },
    },
  );
}
