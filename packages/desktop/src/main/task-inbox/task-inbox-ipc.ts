import type { BrowserWindow, IpcMain, IpcMainInvokeEvent } from "electron";
import { createTaskInboxPages } from "./task-inbox-pages.js";
import type {
  TaskInboxIntent, TaskInboxIntentResult, TaskInboxVisibility,
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
  applyIntent(input: TaskInboxIntent, assertCurrent: () => void): Promise<TaskInboxIntentResult>;
  reconcile(visibility?: TaskInboxVisibility): Promise<TaskInboxSnapshot>;
  subscribe(listener: (snapshot: TaskInboxSnapshot) => void): () => void;
  act(
    request: TaskInboxActionRequest,
    context: { webContentsId: number; assertCurrent?: () => void },
  ): Promise<TaskInboxActionResult>;
}

export { parseTaskInboxListQuery } from "./task-inbox-types.js";
export { parseTaskInboxActionRequest as parseTaskInboxAction } from "./task-inbox-types.js";
import {
  parseTaskInboxListQuery,
  parseTaskInboxActionRequest,
  checkedTaskText, parseTaskInboxIntent,
} from "./task-inbox-types.js";

/** Private local data and controls are available only to application top frames. */
export function registerTaskInboxIpc(
  ipc: Pick<IpcMain, "handle" | "removeHandler">,
  windows: () => BrowserWindow[],
  service: TaskInboxIpcService,
  enabled: () => boolean = () => true,
  validateFrame?: (event: IpcMainInvokeEvent) => void,
  withCaller: <T>(event: IpcMainInvokeEvent, work: () => T) => T = (_event, work) => work(),
): () => void {
  const channels: string[] = [];
  const pages = createTaskInboxPages((visibility) => service.reconcile(visibility));
  const assertSender = (event: IpcMainInvokeEvent) => {
    if (!event.senderFrame || !windows().some((window) => !window.isDestroyed() && window.webContents === event.sender) ||
        event.senderFrame !== event.sender.mainFrame || event.senderFrame.detached) {
      throw new Error("Task inbox requires an application window");
    }
    validateFrame?.(event);
    if (!enabled()) throw new Error("Task inbox is disabled");
  };
  const handle = (
    channel: string,
    action: (event: IpcMainInvokeEvent, input: unknown) => unknown,
  ) => {
    channels.push(channel);
    ipc.handle(channel, (event: IpcMainInvokeEvent, ...args: unknown[]) => {
      assertSender(event);
      if (args.length > 1) throw new Error("Invalid task inbox arguments");
      return action(event, args[0]);
    });
  };
  handle("taskInbox:list", (event, input) =>
    pages.list(event.senderFrame!, parseTaskInboxListQuery(input), () => assertSender(event)),
  );
  handle("taskInbox:intent", (event, input) =>
    withCaller(event, () => service.applyIntent(parseTaskInboxIntent(input), () => assertSender(event))),
  );
  handle("taskInbox:get", (_event, input) => {
    const key = checkedTaskText(input, "key", 1100);
    return service.get(key) ?? null;
  });
  handle("taskInbox:act", (event, input) =>
    service.act(parseTaskInboxActionRequest(input), { webContentsId: event.sender.id, assertCurrent: () => assertSender(event) }),
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
    pages.clear();
    unsubscribe();
    for (const channel of channels) ipc.removeHandler(channel);
  };
}
