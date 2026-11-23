import { isValidDesktopNotificationSessionId } from "./desktop-notifier.js";

export type DesktopNotificationText = { title: string; body?: string; subtitle?: string };

interface NativeNotification {
  once(event: "failed", listener: () => void): unknown;
  on(event: "click", listener: () => void): unknown;
  show(): void;
}

/** A live session must keep the window that owns its worker/approval route. */
export function findNotificationWindow<
  T extends { isDestroyed(): boolean; isFocused(): boolean; webContents: { id: number } },
>(windows: Iterable<T>, ownerWebContentsId?: number): T | undefined {
  const live = [...windows].filter((window) => !window.isDestroyed());
  return (
    live.find((window) => window.webContents.id === ownerWebContentsId) ??
    live.find((window) => window.isFocused()) ??
    live[0]
  );
}

/** Bind navigation to the notification instance, never to mutable active-session state. */
export function showNativeDesktopNotification(
  input: DesktopNotificationText & { sessionId?: string },
  dependencies: {
    create(options: DesktopNotificationText): NativeNotification;
    fallback(options: DesktopNotificationText): void;
    openSession?(sessionId: string): void;
  },
): void {
  const { sessionId, title, body, subtitle } = input;
  const text = { title, body, subtitle };
  let usedFallback = false;
  const fallback = () => {
    if (usedFallback) return;
    usedFallback = true;
    dependencies.fallback(text);
  };
  try {
    const notification = dependencies.create(text);
    notification.once("failed", fallback);
    if (dependencies.openSession && isValidDesktopNotificationSessionId(sessionId)) {
      notification.on("click", () => dependencies.openSession?.(sessionId));
    }
    notification.show();
  } catch {
    fallback();
  }
}
