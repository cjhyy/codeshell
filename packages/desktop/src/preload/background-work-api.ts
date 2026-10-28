import type { IpcRenderer } from "electron";

/** Observed external-agent activity; never a heartbeat or completion estimate. */
export interface BackgroundJobProgress {
  lastActivityAt: number;
  eventCount: number;
  phase?: "starting" | "thinking" | "tool" | "responding";
  summary?: string;
  recentEvents?: Array<{ at: number; summary: string }>;
}

/** Background work goes through Main, which merges its own and the worker's
 * registries and re-checks owner and attempt before any control action. */
export function createBackgroundWorkApi<Info>(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    /** Unified background-work listing for the panel: shells + sub-agents + jobs. */
    listBackgroundWork: (sessionId: string, opts?: { scope?: "session" | "all" }) =>
      ipc.invoke("backgroundWork:list", sessionId, opts) as Promise<{ items: Info[] }>,
    cancelBackgroundJob: (sessionId: string, jobId: string, expectedStartedAt: number) =>
      ipc.invoke("backgroundWork:cancelJob", sessionId, jobId, expectedStartedAt) as Promise<{
        cancelled: boolean;
      }>,
    /** Resolve a task no live process reports; it is recorded as interrupted. */
    markBackgroundJobInterrupted: (sessionId: string, jobId: string, expectedStartedAt: number) =>
      ipc.invoke("backgroundWork:markInterrupted", sessionId, jobId, expectedStartedAt) as Promise<{
        marked: boolean;
      }>,
  };
}
