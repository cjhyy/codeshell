import {
  DESKTOP_HOST_REQUEST_LIMIT_MESSAGE,
  DesktopHostErrors,
} from "../../shared/desktop-host-protocol";

// Electron's context bridge preserves the RPC message, but can strip the numeric code.
// Other worker errors can use -32001 too.
const busyMessage = `${DESKTOP_HOST_REQUEST_LIMIT_MESSAGE} (${DesktopHostErrors.requestLimit})`;

function waitForRetry(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    signal.throwIfAborted();
    const cancel = () => {
      clearTimeout(timer);
      reject(signal.reason);
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", cancel);
      resolve();
    }, ms);
    signal.addEventListener("abort", cancel, { once: true });
  });
}

/** Wait for an admission slot while this project is selected. Only retry read-only calls. */
export async function readWhenHostBusy<T>(read: () => Promise<T>, signal: AbortSignal): Promise<T> {
  let delay = 250;
  for (;;) {
    signal.throwIfAborted();
    try {
      const result = await read();
      signal.throwIfAborted();
      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message !== busyMessage && message !== `Error: ${busyMessage}`) throw error;
      await waitForRetry(delay, signal);
      delay = Math.min(delay * 2, 4_000);
    }
  }
}
