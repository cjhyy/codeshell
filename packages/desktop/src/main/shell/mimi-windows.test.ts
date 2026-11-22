import { expect, test } from "bun:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { mimiWindowIpc, trustedMimiWindows } from "./mimi-windows.js";

function surface(alive = true) {
  return { isDestroyed: () => !alive, webContents: { mainFrame: {} } } as unknown as BrowserWindow;
}

test("only live authorized documents receive Mimi broadcasts", () => {
  const workbench = surface(),
    companion = surface(),
    navigated = surface(),
    closed = surface(false);
  const checked: unknown[] = [];
  const navigation = {
    assertSender(event: Pick<IpcMainInvokeEvent, "sender" | "senderFrame">) {
      checked.push(event.sender);
      expect(event.senderFrame).toBe(event.sender.mainFrame);
      if (event.sender === navigated.webContents) throw Error("navigation");
    },
  };
  expect(trustedMimiWindows([workbench, closed, navigated, companion], navigation)).toEqual([
    workbench,
    companion,
  ]);
  expect(checked).toEqual([workbench.webContents, navigated.webContents, companion.webContents]);
});

test("a pending Mimi request belongs to the originating document and live window after hydration", async () => {
  const workbench = surface(),
    overlay = surface(),
    unrelated = surface();
  let active = [workbench, overlay];
  const documents = new Map([
    [workbench.webContents, new AbortController()],
    [overlay.webContents, new AbortController()],
  ]);
  const hydration = Promise.withResolvers<void>();
  const listeners = new Map<string, (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown>();
  const ipc = mimiWindowIpc(
    {
      handle(channel, listener) {
        listeners.set(channel, listener);
      },
      removeHandler(channel) {
        listeners.delete(channel);
      },
    },
    () => active,
    (event) => {
      if (event.senderFrame !== event.sender.mainFrame) throw Error("untrusted frame");
      return documents.get(event.sender)!.signal;
    },
    hydration.promise,
  );
  let calls = 0;
  ipc.handle("fixture", () => ++calls);
  const invoke = (window: BrowserWindow, frame = window.webContents.mainFrame) =>
    listeners.get("fixture")!({
      sender: window.webContents,
      senderFrame: frame,
    } as IpcMainInvokeEvent) as Promise<number>;
  await expect(invoke(unrelated)).rejects.toThrow("requires");
  await expect(invoke(workbench, {} as Electron.WebFrameMain)).rejects.toThrow("untrusted frame");
  const pending = Promise.allSettled([invoke(workbench), invoke(overlay)]);
  documents.get(workbench.webContents)!.abort(Error("document changed"));
  active = [workbench];
  hydration.resolve();
  expect(await pending).toEqual([
    { status: "rejected", reason: Error("document changed") },
    { status: "rejected", reason: Error("Mimi window is no longer available") },
  ]);
  expect(calls).toBe(0);
  documents.set(workbench.webContents, new AbortController());
  expect(await invoke(workbench)).toBe(1);
  ipc.removeHandler("fixture");
  expect(listeners.size).toBe(0);
});
