import type { IpcRenderer, IpcRendererEvent } from "electron";
import type {
  TaskInboxRecordV1,
  TaskInboxQuery,
  TaskInboxListResult,
  TaskInboxAction,
  TaskInboxActionResult,
  TaskInboxIntent,
  TaskInboxIntentResult,
} from "../main/task-inbox/task-inbox-types";

export type {
  TaskInboxRecordV1,
  TaskInboxQuery,
  TaskInboxListResult,
  TaskInboxAction,
  TaskInboxActionResult,
  TaskInboxIntent,
  TaskInboxIntentResult,
  TaskInboxVisibility,
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
  intent(input: TaskInboxIntent): Promise<TaskInboxIntentResult>;
  onChanged(listener: (version: number) => void): () => void;
}

export function createTaskInboxApi(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
  reads: Partial<Pick<TaskInboxApi, "list" | "get">> = {},
): TaskInboxApi {
  return {
    list: reads.list ?? ((query) => ipc.invoke("taskInbox:list", query)),
    get: reads.get ?? ((taskKey) => ipc.invoke("taskInbox:get", taskKey)),
    intent: (input) => ipc.invoke("taskInbox:intent", input),
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
