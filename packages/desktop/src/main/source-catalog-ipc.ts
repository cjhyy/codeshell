import type {
  IpcMain,
  IpcMainInvokeEvent,
  OpenDialogOptions,
  OpenDialogReturnValue,
} from "electron";
import type { SourceDefinition, WorkspaceSourceBinding } from "@cjhyy/code-shell-core";
import type { CallShellBusiness } from "../shared/shell-business-contracts.js";
import { requireRendererProjectPrimary } from "./renderer-project-path.js";
import {
  catalogList as listSourceCatalog,
  listScopes as listSourceScopes,
  workspaceAccess as workspaceSourceAccess,
} from "./sources-service.js";
export function registerSourceCatalogIpc(
  ipcMain: Pick<IpcMain, "handle">,
  host: { callBusiness: CallShellBusiness; documentSignal(event: IpcMainInvokeEvent): AbortSignal },
  pick: (options: OpenDialogOptions) => Promise<OpenDialogReturnValue>,
) {
  ipcMain.handle("sources:catalogList", async () => listSourceCatalog());
  ipcMain.handle("sources:catalogSave", async (event, definition: unknown) => {
    const signal = host.documentSignal(event);
    if (typeof definition !== "object" || definition === null || Array.isArray(definition)) {
      throw new Error("sources:catalogSave requires definition");
    }
    return host.callBusiness(
      "sources/save",
      { definition: definition as SourceDefinition },
      signal,
    );
  });
  ipcMain.handle("sources:catalogDelete", async (event, id: string) => {
    const signal = host.documentSignal(event);
    if (typeof id !== "string" || !id) throw new Error("sources:catalogDelete requires id");
    return host.callBusiness("sources/delete", { id }, signal);
  });
  ipcMain.handle("sources:projectAccess", async (_e, projectId: string) => {
    const { path } = await requireRendererProjectPrimary(projectId);
    return workspaceSourceAccess(path);
  });
  ipcMain.handle("sources:bindProject", async (event, projectId: string, binding: unknown) => {
    const signal = host.documentSignal(event);
    if (typeof binding !== "object" || binding === null || Array.isArray(binding)) {
      throw new Error("sources:bindProject requires binding");
    }
    return host.callBusiness(
      "sources/bind",
      { projectId, binding: binding as WorkspaceSourceBinding },
      signal,
    );
  });
  ipcMain.handle("sources:unbindProject", async (event, projectId: string, sourceId: string) => {
    const signal = host.documentSignal(event);
    if (typeof sourceId !== "string" || !sourceId) {
      throw new Error("sources:unbindProject requires sourceId");
    }
    return host.callBusiness("sources/unbind", { projectId, sourceId }, signal);
  });
  ipcMain.handle("sources:listScopes", async (_e, sourceId: string) => {
    if (typeof sourceId !== "string" || !sourceId) {
      throw new Error("sources:listScopes requires sourceId");
    }
    return listSourceScopes(sourceId);
  });
  ipcMain.handle("sources:pickAndUploadProject", async (event, projectId: string) => {
    const signal = host.documentSignal(event);
    await requireRendererProjectPrimary(projectId);
    const result = await pick({
      title: "选择数据源文件",
      properties: ["openFile", "multiSelections"],
    });
    if (result.canceled || result.filePaths.length === 0) return [];
    return host.callBusiness(
      "sources/uploadPicked",
      { projectId, files: result.filePaths },
      signal,
    );
  });
  ipcMain.handle("sources:deleteProjectUpload", async (event, projectId: string, name: string) => {
    const signal = host.documentSignal(event);
    if (typeof name !== "string" || !name) {
      throw new Error("sources:deleteProjectUpload requires name");
    }
    return host.callBusiness("sources/deleteUpload", { projectId, name }, signal);
  });
}
