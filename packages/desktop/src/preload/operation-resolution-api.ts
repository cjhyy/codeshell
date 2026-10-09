import type { IpcRenderer } from "electron";
import type {
  OperationResolutionInput,
  OperationResolutionResult,
  OperationResolutionReview,
} from "../shared/operation-resolution.js";

export function createOperationResolutionApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    review: (sessionId: string): Promise<OperationResolutionReview> =>
      ipc.invoke("operationResolution:review", { sessionId }),
    resolve: (input: OperationResolutionInput): Promise<OperationResolutionResult> =>
      ipc.invoke("operationResolution:resolve", input),
  };
}
