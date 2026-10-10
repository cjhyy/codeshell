import type { SourceCollectionApi } from "../shared/source-collections.js";

interface CollectionIpcDeps {
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => any): void };
  open(event: any): { api: SourceCollectionApi; dispose(): void };
}

/** Per-invocation authority and cancellation belong to Main, never to renderer arguments. */
export function registerSourceCollectionIpc(deps: CollectionIpcDeps): void {
  const listener =
    (method: keyof SourceCollectionApi) =>
    async (event: any, ...args: any[]) => {
      const operation = deps.open(event);
      try {
        const invoke = operation.api[method] as (...parameters: any[]) => Promise<unknown>;
        return await invoke(...args);
      } finally {
        operation.dispose();
      }
    };
  deps.ipcMain.handle("sources:collections:create", listener("create"));
  deps.ipcMain.handle("sources:collections:get", listener("get"));
  deps.ipcMain.handle("sources:collections:update", listener("update"));
  deps.ipcMain.handle("sources:collections:pick", listener("pick"));
  deps.ipcMain.handle("sources:collections:delete", listener("delete"));
}
