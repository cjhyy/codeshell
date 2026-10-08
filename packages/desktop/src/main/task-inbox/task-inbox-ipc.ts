import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import type {
  TaskInboxActionRequest,
  TaskInboxActionResult,
  TaskInboxListQuery,
  TaskInboxListResult,
  TaskInboxRecordV1,
  TaskInboxSnapshot,
} from "./task-inbox-types.js";

export interface TaskInboxIpcService {
  list(query?: TaskInboxListQuery): TaskInboxListResult;
  get(taskKey: string): TaskInboxRecordV1 | undefined;
  reconcile(): Promise<TaskInboxSnapshot>;
  subscribe(listener: (snapshot: TaskInboxSnapshot) => void): () => void;
  act(
    request: TaskInboxActionRequest,
    context: { webContentsId: number },
  ): Promise<TaskInboxActionResult>;
}

export { parseTaskInboxListQuery } from "./task-inbox-types.js";
export { parseTaskInboxActionRequest as parseTaskInboxAction } from "./task-inbox-types.js";
import {
  parseTaskInboxListQuery,
  parseTaskInboxActionRequest,
  checkedTaskText,
} from "./task-inbox-types.js";

/** Private local data and controls are available only to application top frames. */
export function registerTaskInboxIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  service: TaskInboxIpcService,
  enabled: () => boolean = () => true,
): () => void {
  const channels: string[] = [];
  const handle = (
    channel: string,
    action: (event: IpcMainInvokeEvent, input: unknown) => unknown,
  ) => {
    channels.push(channel);
    ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      if (
        !windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) ||
        event.senderFrame !== event.sender.mainFrame
      ) {
        throw new Error("Task inbox requires an application window");
      }
      if (!enabled()) throw new Error("Task inbox is disabled");
      if (args.length > 1) throw new Error("Invalid task inbox arguments");
      return action(event, args[0]);
    });
  };
  handle("taskInbox:list", async (_event, input) => {
    const query = parseTaskInboxListQuery(input);
    await service.reconcile();
    return service.list(query);
  });
  handle("taskInbox:get", (_event, input) => {
    const key = checkedTaskText(input, "key", 1100);
    return service.get(key) ?? null;
  });
  handle("taskInbox:act", (event, input) =>
    service.act(parseTaskInboxActionRequest(input), { webContentsId: event.sender.id }),
  );
  const unsubscribe = service.subscribe((snapshot) => {
    if (!enabled()) return;
    for (const window of windows()) {
      if (window.isDestroyed() || window.webContents.isDestroyed()) continue;
      try {
        window.webContents.send("taskInbox:changed", snapshot.version);
      } catch {
        // A closing window cannot make a task projection update fail.
      }
    }
  });
  return () => {
    unsubscribe();
    for (const channel of channels) ipc.removeHandler(channel);
  };
}
