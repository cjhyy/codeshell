import { isValidDesktopNotificationSessionId } from "./desktop-notifier.js";

interface NativeNotification {
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
  input: { title: string; body: string; sessionId?: string },
  dependencies: {
    create(options: { title: string; body: string }): NativeNotification;
    openSession(sessionId: string): void;
  },
): void {
  const notification = dependencies.create({ title: input.title, body: input.body });
  const sessionId = input.sessionId;
  if (sessionId !== undefined && isValidDesktopNotificationSessionId(sessionId)) {
    notification.on("click", () => dependencies.openSession(sessionId));
  }
  notification.show();
}
