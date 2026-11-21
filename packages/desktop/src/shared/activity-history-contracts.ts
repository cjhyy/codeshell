import type { UsageQuery, UsageSummary } from "@cjhyy/code-shell-core";
import type { CodeshellApi } from "../preload/types";
import type { createTraceHistoryService } from "../main/trace-history-service.js";

type View<K extends keyof CodeshellApi, P> = {
  params: P;
  result: CodeshellApi[K] extends (...args: any[]) => Promise<infer R> ? R : never;
};
export interface ActivityReads {
  "activity/titles": View<"listSessionTitles", Record<string, never>>;
  "activity/logTail": View<"tailLog", { bucket: "ui-ink" | "engine" | "desktop"; lines?: number }>;
  "activity/usage": { params: { query?: UsageQuery }; result: UsageSummary };
  "activity/runs": View<"listRuns", { includeSessions?: boolean }>;
  "activity/run": View<"getRun", { runId: string }>;
}
type History = ReturnType<typeof createTraceHistoryService>;
type Trace<K extends keyof History> = {
  input: Parameters<History[K]>[0];
  result: ReturnType<History[K]>;
};
type PrivateReads = {
  [K in keyof ActivityReads]: {
    input: ActivityReads[K]["params"];
    result: ActivityReads[K]["result"];
  };
};
export interface ActivityOperations extends PrivateReads {
  "activity/setTitle": { input: { id: string; title: string }; result: void };
  "trace/list": Trace<"list">;
  "trace/sessions": Trace<"sessions">;
  "trace/get": Trace<"get">;
  "trace/config": { input: undefined; result: ReturnType<History["getConfig"]> };
  "trace/setConfig": Trace<"setConfig">;
}
