import type { LinkedFileSourceApi } from "../shared/linked-file-sources.js";

type LinkedFileSourceMethod = "snapshot" | "add";

/** Each invocation captures its own Main window/frame lifetime before resolving the project. */
export function registerLinkedFileSourceIpc(deps: {
  ipcMain: { handle(channel: string, listener: (event: any, ...args: any[]) => any): void };
  open(event: any): { api: LinkedFileSourceApi; dispose(): void };
}): void {
  const run = async (event: any, method: LinkedFileSourceMethod, args: unknown[]) => {
    const operation = deps.open(event);
    try {
      const invoke = operation.api[method] as (...parameters: unknown[]) => Promise<unknown>;
      return await invoke(...args);
    } finally {
      operation.dispose();
    }
  };
  // Literal channel names keep every route visible to the static preload/main
  // IPC contract and the architecture route budget.
  deps.ipcMain.handle("sources:linkedFiles:snapshot", (event, ...args) =>
    run(event, "snapshot", args),
  );
  deps.ipcMain.handle("sources:linkedFiles:add", (event, ...args) => run(event, "add", args));
}
