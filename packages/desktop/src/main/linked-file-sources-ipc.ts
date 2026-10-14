import type { LinkedFileSourceApi } from "../shared/linked-file-sources.js";

/** Each invocation captures its own Main window/frame lifetime before resolving the project. */
export function registerLinkedFileSourceIpc(deps: {
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => any): void };
  open(event: any): { api: LinkedFileSourceApi; dispose(): void };
}): void {
  for (const method of ["snapshot", "add"] as const) {
    deps.ipcMain.handle(`sources:linkedFiles:${method}`, async (event, ...args) => {
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
