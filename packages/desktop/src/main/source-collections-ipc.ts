import type { SourceCollectionApi } from "../shared/source-collections.js";

interface CollectionIpcDeps {
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => any): void };
  open(event: any): { api: SourceCollectionApi; dispose(): void };
}

/** Per-invocation authority and cancellation belong to Main, never to renderer arguments. */
export function registerSourceCollectionIpc(deps: CollectionIpcDeps): void {
  for (const method of ["create", "get", "update", "pick", "delete"] as const) {
    deps.ipcMain.handle(`sources:collections:${method}`, async (event, ...args) => {
      const operation = deps.open(event);
      try {
        const invoke = operation.api[method] as (...parameters: any[]) => Promise<unknown>;
        return await invoke(...args);
      } finally {
        operation.dispose();
      }
    });
  }
}
