import {
  showNativeDesktopNotification,
  type DesktopNotificationText,
} from "./native-desktop-notification.js";
import { Notification, type IpcMain, type IpcMainEvent } from "electron";
import {
  fallbackNotice,
  fallbackReady,
  type NotificationFallback,
} from "../shared/notification-fallback.js";

const pending: NotificationFallback[] = [];
let flush: (() => void) | undefined;

/** A failed OS notice may precede the first workbench mount, or arrive with all windows closed. */
export function registerNotificationFallback(
  ipc: Pick<IpcMain, "on">,
  targetId: (sessionId?: string) => number | undefined,
  documentSignal: (event: IpcMainEvent) => AbortSignal,
) {
  const receivers = new Map<number, (notice: NotificationFallback) => void>();
  flush = () => {
    for (const notice of [...pending]) {
      const id = targetId(notice.sessionId);
      if (id === undefined) continue;
      const send = receivers.get(id);
      if (!send) continue;
      try {
        send(notice);
        pending.splice(pending.indexOf(notice), 1);
      } catch {
        receivers.delete(id);
      }
    }
  };
  ipc.on(fallbackReady, (event) => {
    const frame = event.senderFrame;
    if (!frame) return;
    try {
      const signal = documentSignal(event);
      const id = event.sender.id;
      if (!receivers.has(id)) {
        receivers.set(id, (notice) => frame.send(fallbackNotice, notice));
        signal.addEventListener("abort", () => receivers.delete(id), { once: true });
      }
      flush?.();
    } catch {
      // Auxiliary or expired documents cannot receive desktop notification text.
    }
  });
}

function reportFallback({
  title,
  subtitle,
  body,
  sessionId,
}: DesktopNotificationText & { sessionId?: string }) {
  pending.push({ message: title, detail: [subtitle, body].filter(Boolean).join("\n"), sessionId });
  if (pending.length > 100) pending.shift();
  flush?.();
}

/** If the OS rejects delivery, the notice remains readable in the application. */
export function showSystemNotification(
  input: DesktopNotificationText & { sessionId?: string },
  openSession?: (sessionId: string) => void,
): boolean {
  if (!Notification.isSupported()) {
    reportFallback(input);
    return false;
  }
  showNativeDesktopNotification(input, {
    create: (text) => new Notification(text),
    openSession,
    fallback: () => reportFallback(input),
  });
  return true;
}
