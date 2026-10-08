import type { IpcRenderer } from "electron";

/** Original session history stays behind the same validated Main IPC routes. */
export function createSessionTranscriptApi(ipc: Pick<IpcRenderer, "invoke">) {
  return {
    getSessionTranscript: (sessionId: string) => ipc.invoke("sessions:transcript", sessionId),
    getSessionTranscriptPage: (sessionId: string, options?: { maxBytes?: number }) =>
      ipc.invoke("sessions:transcriptPage", sessionId, options),
    listDiskSessions: (opts?: { limit?: number; cursor?: string; parentSessionId?: string }) =>
      ipc.invoke("sessions:listDisk", opts ?? {}),
    /** Long-disconnect fallback after the live snapshot has evicted older events. */
    getSessionRawEvents: (sessionId: string, sinceId?: string) =>
      ipc.invoke("sessions:rawEvents", sessionId, sinceId),
  };
}
