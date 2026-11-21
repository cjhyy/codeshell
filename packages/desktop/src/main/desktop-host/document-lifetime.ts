import type { IpcMainEvent, WebContents } from "electron";

/** One listener set per window, shared by all pending Main-approved calls.
 * A navigation to the same URL still invalidates the old document's writes. */
export function documentLifetimes(
  assertSender: (event: Pick<IpcMainEvent, "sender" | "senderFrame">) => void,
) {
  const windows = new WeakMap<WebContents, { controller: AbortController; navigating: boolean }>();
  return (event: Pick<IpcMainEvent, "sender" | "senderFrame">) => {
    assertSender(event);
    const contents = event.sender;
    let state = windows.get(contents);
    if (!state) {
      const record = { controller: new AbortController(), navigating: false };
      windows.set(contents, record);
      const revoke = () => {
        record.navigating = true;
        record.controller.abort();
      };
      const renew = () => {
        if (record.navigating) {
          record.controller = new AbortController();
          record.navigating = false;
        }
      };
      contents.on("did-start-navigation", (navigation) => {
        if (navigation.isMainFrame && !navigation.isSameDocument) revoke();
      });
      contents.on("did-navigate", renew);
      contents.on("did-stop-loading", renew);
      contents.on("render-process-gone", revoke);
      contents.once("destroyed", revoke);
      state = record;
    }
    state.controller.signal.throwIfAborted();
    return state.controller.signal;
  };
}
