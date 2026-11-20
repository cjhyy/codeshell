import { dialog, Notification } from "electron";
import { dlog } from "./desktop-logger.js";
import {
  showNativeDesktopNotification,
  type DesktopNotificationText,
} from "./native-desktop-notification.js";

/** If the OS rejects delivery, the notice remains readable in the application. */
export function showSystemNotification(
  input: DesktopNotificationText & { sessionId?: string },
  openSession?: (sessionId: string) => void,
): boolean {
  if (!Notification.isSupported()) return false;
  showNativeDesktopNotification(input, {
    create: (text) => new Notification(text),
    openSession,
    fallback: ({ title, subtitle, body }) => {
      void dialog
        .showMessageBox({
          type: "info",
          title: "CodeShell",
          message: title,
          detail: [subtitle, body].filter(Boolean).join("\n"),
        })
        .catch((error) =>
          dlog("main", "desktop_notification.fallback.failed", { error: String(error) }),
        );
    },
  });
  return true;
}
