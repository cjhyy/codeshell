import type { App, BrowserWindow } from "electron";
import type { CloudAccountStatus } from "../shared/cloud-account.js";
import type { DesktopRelayStatus } from "../shared/device-relay.js";

/** Restore account binding after safeStorage is ready, and retry when connectivity returns. */
export function bindDesktopAccountLifecycle(
  app: Pick<App, "on" | "once" | "whenReady">,
  account: {
    status(): CloudAccountStatus;
    resume(authorized?: () => boolean): Promise<CloudAccountStatus>;
  },
  relay: { relayStatus(): DesktopRelayStatus },
  windows: () => Iterable<BrowserWindow>,
  retryDelayMs = 30_000,
) {
  let ready = false;
  let disposed = false;
  let running: Promise<void> | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  const retry = (force = false) => {
    if (!ready || disposed || running) return running ?? Promise.resolve();
    const status = account.status();
    if (status.state !== "signed-in" || !status.account || !status.origin) return Promise.resolve();
    const local = relay.relayStatus();
    if (!force) {
      // A remote revocation needs a new sign-in, not silent re-enrollment.
      if (local.state === "unauthorized") return Promise.resolve();
      const bound =
        local.registered &&
        local.accountId === status.account.id &&
        local.relayOrigin === status.origin;
      if (bound && (!local.remoteAccessEnabled || ["ready", "connecting"].includes(local.state)))
        return Promise.resolve();
    }
    const pending = account
      .resume(() => !disposed)
      .then(
        () => {},
        () => {},
      )
      .finally(() => {
        if (running === pending) running = undefined;
      });
    running = pending;
    return pending;
  };
  app.on("browser-window-focus", (_event, window) => {
    if ([...windows()].includes(window)) void retry();
  });
  void app.whenReady().then(() => {
    if (disposed) return;
    ready = true;
    void retry(true);
    timer = setInterval(() => void retry(), retryDelayMs);
    timer.unref?.();
  });
  app.once("will-quit", () => {
    disposed = true;
    clearInterval(timer);
  });
  return { retry };
}
