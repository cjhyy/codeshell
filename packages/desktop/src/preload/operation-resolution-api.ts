import type { IpcRenderer } from "electron";
import type {
  OperationResolutionInput,
  OperationResolutionResult,
  OperationResolutionReview,
  OperationReadResult,
} from "../shared/operation-resolution.js";

export function createOperationResolutionApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    review: (sessionId: string): Promise<OperationResolutionReview> =>
      ipc.invoke("operationResolution:review", { sessionId }),
    resolve: (input: OperationResolutionInput): Promise<OperationResolutionResult> =>
      ipc.invoke("operationResolution:resolve", input),
    reconcile: (input: OperationResolutionInput): Promise<OperationReadResult> =>
      ipc.invoke("operationResolution:reconcile", input),
  };
}
