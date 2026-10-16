import type { IpcRenderer } from "electron";
import type {
  ModelTraceConfig,
  ModelTraceConfigPatch,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTracePage,
  ModelTraceRecord,
} from "@cjhyy/code-shell-core/internal";
export type {
  ModelTraceAttempt,
  ModelTraceConfig,
  ModelTraceConfigPatch,
  ModelTraceContentState,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTraceOutput,
  ModelTracePage,
  ModelTraceRecord,
  ModelTraceStatus,
  ModelTraceSummary,
} from "@cjhyy/code-shell-core/internal";

export interface ModelTraceApi {
  list(query?: ModelTraceListQuery): Promise<ModelTracePage>;
  get(id: string): Promise<{ record: ModelTraceRecord; events: ModelTraceEvent[] } | null>;
  getConfig(): Promise<ModelTraceConfig>;
  setConfig(patch: ModelTraceConfigPatch): Promise<ModelTraceConfig>;
}

export function createModelTraceApi(ipc: Pick<IpcRenderer, "invoke">): ModelTraceApi {
  return {
    list: (query) => ipc.invoke("modelTraces:list", query),
    get: (id) => ipc.invoke("modelTraces:get", id),
    getConfig: () => ipc.invoke("modelTraces:getConfig"),
    setConfig: (patch) => ipc.invoke("modelTraces:setConfig", patch),
  };
}
