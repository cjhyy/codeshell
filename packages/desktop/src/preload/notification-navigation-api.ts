import type { IpcRendererEvent } from "electron";

export const NOTIFICATION_OPEN_SESSION_CHANNEL = "notification:open-session";

/** Preload starts listening before React mounts, including when a click creates a window. */
export function createNotificationNavigationApi(ipc: {
  on(channel: string, listener: (event: IpcRendererEvent, payload: unknown) => void): unknown;
}) {
  const listeners = new Set<(sessionId: string) => void>();
  let pendingSessionId: string | undefined;
  ipc.on(NOTIFICATION_OPEN_SESSION_CHANNEL, (_event, payload) => {
    if (typeof payload !== "string" || payload.length === 0) return;
    if (listeners.size === 0) {
      pendingSessionId = payload;
      return;
    }
    pendingSessionId = undefined;
    for (const listener of listeners) listener(payload);
  });
  return {
    onNotificationOpenSession(listener: (sessionId: string) => void): () => void {
      listeners.add(listener);
      if (pendingSessionId !== undefined) {
        // StrictMode may unsubscribe and remount an effect in the same turn.
        // Deliver to the surviving subscriber so its navigation is not discarded.
        queueMicrotask(() => {
          if (pendingSessionId === undefined || listeners.size === 0) return;
          const sessionId = pendingSessionId;
          pendingSessionId = undefined;
          for (const current of listeners) current(sessionId);
        });
      }
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
