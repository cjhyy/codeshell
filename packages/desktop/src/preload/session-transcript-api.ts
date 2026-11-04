import type { IpcRenderer, IpcRendererEvent } from "electron";
import type {
  OutputHistoryRecoveryAcceptance,
  OutputHistoryRecoveryPlan,
  OutputHistoryRecoveryResult,
} from "@cjhyy/code-shell-core";

export interface SessionOutputRecoveryApi {
  onSessionOutputHistoryReset?(listener: (sessionId: string) => void): () => void;
  getSessionOutputRecoveryPlan?(sessionId: string): Promise<OutputHistoryRecoveryPlan>;
  applySessionOutputRecovery?(
    sessionId: string,
    acceptance: OutputHistoryRecoveryAcceptance,
  ): Promise<OutputHistoryRecoveryResult>;
}

/** Original session history stays behind the same validated Main IPC routes. */
export function createSessionTranscriptApi(
  ipc: Pick<IpcRenderer, "invoke" | "on" | "removeListener">,
) {
  return {
    onSessionOutputHistoryReset(listener: (sessionId: string) => void) {
      const handler = (_event: IpcRendererEvent, payload: { sessionId?: unknown }) => {
        if (typeof payload?.sessionId === "string") listener(payload.sessionId);
      };
      ipc.on("sessions:outputHistoryReset", handler);
      return () => ipc.removeListener("sessions:outputHistoryReset", handler);
    },
    getSessionOutputRecoveryPlan: (sessionId: string) =>
      ipc.invoke("sessions:outputRecoveryPlan", sessionId),
    applySessionOutputRecovery: (sessionId: string, acceptance: OutputHistoryRecoveryAcceptance) =>
      ipc.invoke("sessions:outputRecoveryApply", sessionId, acceptance),
    getSessionTranscript: (sessionId: string) => ipc.invoke("sessions:transcript", sessionId),
    getSessionOutputJournal: (
      sessionId: string,
      options?: import("@cjhyy/code-shell-core/internal").OutputJournalOptions,
    ) => ipc.invoke("sessions:outputJournal", sessionId, options),
    getSessionTranscriptPage: (sessionId: string, options?: { maxBytes?: number }) =>
      ipc.invoke("sessions:transcriptPage", sessionId, options),
    listDiskSessions: (opts?: { limit?: number; cursor?: string; parentSessionId?: string }) =>
      ipc.invoke("sessions:listDisk", opts ?? {}),
    /** Long-disconnect fallback after the live snapshot has evicted older events. */
    getSessionRawEvents: (sessionId: string, sinceId?: string) =>
      ipc.invoke("sessions:rawEvents", sessionId, sinceId),
  };
}
