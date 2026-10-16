import React, { useMemo } from "react";
import { createRemoteModelTraceApi } from "../src/model-trace-api.js";
import { ModelTraceExplorer } from "../src/components/ModelTraceExplorer.js";
import { captureApiScope } from "./api-context.js";
import { api, ApiError } from "./auth.js";

export function HubModelTraces({
  onAuthLost,
  onOpenSession,
  sessionTitles,
}: {
  onAuthLost: () => void;
  onOpenSession: (id: string) => void;
  sessionTitles?: Readonly<Record<string, string>>;
}) {
  const traceApi = useMemo(() => {
    const scope = captureApiScope();
    return createRemoteModelTraceApi({
      request: async (path, init) => {
        try {
          return await api(path, init, scope);
        } catch (error) {
          if (error instanceof ApiError && error.status === 401) onAuthLost();
          throw error;
        }
      },
    });
  }, [onAuthLost]);
  return (
    <ModelTraceExplorer
      api={traceApi}
      sessionTitles={sessionTitles}
      onOpenSession={onOpenSession}
    />
  );
}
