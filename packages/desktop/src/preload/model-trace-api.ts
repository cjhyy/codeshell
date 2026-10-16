import type { IpcRenderer } from "electron";
import type {
  ModelTraceConfig,
  ModelTraceConfigPatch,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTracePage,
  ModelTraceSessionPage,
  ModelTraceRecord,
} from "@cjhyy/code-shell-core/internal";
export type {
  ModelTraceAttempt,
  ModelTraceCallType,
  ModelTraceConfig,
  ModelTraceConfigPatch,
  ModelTraceContentState,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTraceOutput,
  ModelTracePage,
  ModelTraceSessionPage,
  ModelTraceRecord,
  ModelTraceStatus,
  ModelTraceSummary,
  ModelTraceSessionSummary,
} from "@cjhyy/code-shell-core/internal";

export interface ModelTraceApi {
  list(query?: ModelTraceListQuery): Promise<ModelTracePage>;
  sessions(query?: ModelTraceListQuery): Promise<ModelTraceSessionPage>;
  get(id: string): Promise<{ record: ModelTraceRecord; events: ModelTraceEvent[] } | null>;
  getConfig(): Promise<ModelTraceConfig>;
  setConfig(patch: ModelTraceConfigPatch): Promise<ModelTraceConfig>;
}

export function createModelTraceApi(ipc: Pick<IpcRenderer, "invoke">): ModelTraceApi {
  return {
    list: (query) => ipc.invoke("modelTraces:list", query),
    sessions: (query) => ipc.invoke("modelTraces:sessions", query),
    get: (id) => ipc.invoke("modelTraces:get", id),
    getConfig: () => ipc.invoke("modelTraces:getConfig"),
    setConfig: (patch) => ipc.invoke("modelTraces:setConfig", patch),
  };
}
