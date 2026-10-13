import type { IpcRenderer } from "electron";
import type {
  OperationBatchInput,
  OperationBatchOptions,
  OperationBatchResult,
} from "../shared/operation-batch.js";
export function createOperationBatchApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    options: (sessionId: string): Promise<OperationBatchOptions> =>
      ipc.invoke("operationBatch:options", { sessionId }),
    start: (input: OperationBatchInput): Promise<OperationBatchResult> =>
      ipc.invoke("operationBatch:start", input),
  };
}
