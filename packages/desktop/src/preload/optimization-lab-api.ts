import type { IpcRenderer } from "electron";
import type { OptimizationLabApi } from "../shared/optimization-lab";
export type { OptimizationLabApi } from "../shared/optimization-lab";

export function createOptimizationLabApi(ipc: Pick<IpcRenderer, "invoke">): OptimizationLabApi {
  return {
    adopt: (input) => ipc.invoke("optimizationLab:adopt", input),
    previewEvidence: (input) => ipc.invoke("optimizationLab:previewEvidence", input),
    importEvidence: (input) => ipc.invoke("optimizationLab:importEvidence", input),
    query: (type, input) => ipc.invoke("optimizationLab:query", type, input),
    authorize: (input) => ipc.invoke("optimizationLab:authorize", input),
    exportFile: (input) => ipc.invoke("optimizationLab:exportFile", input),
    importGrading: (input) => ipc.invoke("optimizationLab:importGrading", input),
    importDataset: (input) => ipc.invoke("optimizationLab:importDataset", input),
    exportDataset: (input) => ipc.invoke("optimizationLab:exportDataset", input),
  };
}
