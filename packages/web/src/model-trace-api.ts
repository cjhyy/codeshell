import type {
  ModelTraceConfig,
  ModelTraceEvent,
  ModelTraceListQuery,
  ModelTracePage,
  ModelTraceSessionPage,
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
  ModelTraceSessionPage,
  ModelTraceRecord,
  ModelTraceStatus,
  ModelTraceSummary,
  ModelTraceSessionSummary,
} from "@cjhyy/code-shell-core/internal";

type RemoteModelTraceQuery = Omit<ModelTraceListQuery, "workspacePath" | "workspaceScopes">;

export interface RemoteModelTraceApi {
  list(query?: RemoteModelTraceQuery): Promise<ModelTracePage>;
  sessions(query?: RemoteModelTraceQuery): Promise<ModelTraceSessionPage>;
  get(id: string): Promise<{ record: ModelTraceRecord; events: ModelTraceEvent[] } | null>;
  getConfig(): Promise<ModelTraceConfig>;
}

/** Supply the client's existing authenticated, workspace-bound JSON requester. */
export function createRemoteModelTraceApi(options: {
  request: (path: string, init?: RequestInit) => Promise<unknown>;
}): RemoteModelTraceApi {
  const querySuffix = (query: RemoteModelTraceQuery) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) {
      if (["workspacePath", "workspaceScopes", "storageDir"].includes(key))
        throw new Error("Model history scope belongs to the Host");
      if (value !== undefined) params.set(key, String(value));
    }
    return params.size ? `?${params}` : "";
  };
  return {
    async list(query = {}) {
      return (await options.request(`/api/v1/model-traces${querySuffix(query)}`)) as ModelTracePage;
    },
    async sessions(query = {}) {
      return (await options.request(
        `/api/v1/model-traces/sessions${querySuffix(query)}`,
      )) as ModelTraceSessionPage;
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
