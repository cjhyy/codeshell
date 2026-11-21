interface SingleInstanceApp {
  requestSingleInstanceLock(): boolean;
  quit(): void;
}

/** Acquire Electron's process-wide ownership before any shared-session startup GC. */
export function acquireDesktopInstanceLock(app: SingleInstanceApp): boolean {
  const acquired = app.requestSingleInstanceLock();
  if (!acquired) app.quit();
  return acquired;
}

/**
 * Keep the destructive cleanup behind the same ownership decision even when
 * startup orchestration is refactored. A non-owner must never touch qchat data.
 */
export async function runOwnedQuickChatStartupCleanup(
  ownsDesktopInstance: boolean,
  cleanup: () => Promise<string[]>,
): Promise<string[]> {
  if (!ownsDesktopInstance) return [];
  return cleanup();
}

interface FocusableWindow {
  isDestroyed(): boolean;
  isMinimized(): boolean;
  restore(): void;
  show(): void;
  focus(): void;
}

export function focusWorkbench(window: FocusableWindow): void {
  if (window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
}

/** Register exactly one first-instance handler that foregrounds its live window. */
export function registerSecondInstanceFocus(
  register: (handler: () => void) => void,
  getWindows: () => FocusableWindow[],
  openMissing?: () => void,
): void {
  register(() => {
    const window = getWindows().find((candidate) => !candidate.isDestroyed());
    if (!window) {
      openMissing?.();
      return;
    }
    focusWorkbench(window);
  });
}

/** Dock/second-instance requests share one in-flight main-window creation. */
export function createMainWindowRestorer<T>(
  getWindow: () => T | undefined | null,
  create: () => Promise<T>,
): () => Promise<T> {
  let pending: Promise<T> | undefined;
  return () => {
    const existing = getWindow();
    if (existing) return Promise.resolve(existing);
    if (!pending)
      pending = create().finally(() => {
        pending = undefined;
      });
    return pending;
  };
}
