import type {
  ModelTraceConfig,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTracePage,
  ModelTraceRecord,
} from "@cjhyy/code-shell-core/internal";
export type {
  ModelTraceAttempt,
  ModelTraceConfig,
  ModelTraceContentState,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTraceOutput,
  ModelTracePage,
  ModelTraceRecord,
  ModelTraceStatus,
  ModelTraceSummary,
} from "@cjhyy/code-shell-core/internal";

export interface RemoteModelTraceApi {
  list(query?: Omit<ModelTraceListQuery, "workspacePath">): Promise<ModelTracePage>;
  get(id: string): Promise<{ record: ModelTraceRecord; events: ModelTraceEvent[] } | null>;
  getConfig(): Promise<ModelTraceConfig>;
}

/** Supply the client's existing authenticated, workspace-bound JSON requester. */
export function createRemoteModelTraceApi(options: {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}): RemoteModelTraceApi {
  return {
    async list(query = {}) {
      const params = new URLSearchParams();
      for (const [key, value] of Object.entries(query)) {
        if (key === "workspacePath" || key === "storageDir")
          throw new Error("Model history scope belongs to the Host");
        if (value !== undefined) params.set(key, String(value));
      }
      const suffix = params.size ? `?${params}` : "";
      return (await options.request(`/api/v1/model-traces${suffix}`)) as ModelTracePage;
    },
    async get(id) {
      if (!/^[A-Za-z0-9_-]{1,128}$/.test(id)) throw new Error("Invalid model trace id");
      try {
        return (await options.request(`/api/v1/model-traces/${encodeURIComponent(id)}`)) as {
          record: ModelTraceRecord;
          events: ModelTraceEvent[];
        } | null;
      } catch (error) {
        if ((error as { status?: unknown })?.status === 404) return null;
        throw error;
      }
    },
    async getConfig() {
      return (await options.request("/api/v1/model-traces/config")) as ModelTraceConfig;
    },
  };
}
