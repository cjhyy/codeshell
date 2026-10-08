import type { IpcRenderer, IpcRendererEvent } from "electron";
import type {
  TaskInboxRecordV1,
  TaskInboxQuery,
  TaskInboxListResult,
  TaskInboxAction,
  TaskInboxActionResult,
} from "../main/task-inbox/task-inbox-types";

export type {
  TaskInboxRecordV1,
  TaskInboxQuery,
  TaskInboxListResult,
  TaskInboxAction,
  TaskInboxActionResult,
  TaskSource,
  TaskStatus,
} from "../main/task-inbox/task-inbox-types";

export interface TaskInboxApi {
  list(query?: TaskInboxQuery): Promise<TaskInboxListResult>;
  get(taskKey: string): Promise<TaskInboxRecordV1 | null>;
  act(input: {
    taskKey: string;
    action: TaskInboxAction;
    expectedRevision: string;
  }): Promise<TaskInboxActionResult>;
  onChanged(listener: (version: number) => void): () => void;
}

export function createTaskInboxApi(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
): TaskInboxApi {
  return {
    list: (query) => ipc.invoke("taskInbox:list", query),
    get: (taskKey) => ipc.invoke("taskInbox:get", taskKey),
    act: (input) => ipc.invoke("taskInbox:act", input),
    onChanged(listener) {
      const handler = (_event: IpcRendererEvent, version: number) => {
        if (Number.isSafeInteger(version) && version >= 0) listener(version);
      };
      ipc.on("taskInbox:changed", handler);
      return () => ipc.removeListener("taskInbox:changed", handler);
    },
  };
}
