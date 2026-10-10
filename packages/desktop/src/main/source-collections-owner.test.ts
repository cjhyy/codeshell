import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { captureSourceCollectionOwner } from "./source-collections-owner.js";
import { registerSourceCollectionIpc } from "./source-collections-ipc.js";

function fixture() {
  const frame = { processId: 1, routingId: 2, isDestroyed: () => false };
  const sender = Object.assign(new EventEmitter(), { mainFrame: frame, isDestroyed: () => false });
  const owner = { isDestroyed: () => false };
  return { frame, sender, owner };
}
test("collection ownership rejects child/replaced frame and non-main window", () => {
  const f = fixture();
  expect(() =>
    captureSourceCollectionOwner({ ...f, frame: { ...f.frame }, isMainWindow: () => true }),
  ).toThrow();
  expect(() => captureSourceCollectionOwner({ ...f, isMainWindow: () => false })).toThrow();
  expect(f.sender.eventNames()).toHaveLength(0);
  const lease = captureSourceCollectionOwner({ ...f, isMainWindow: () => true });
  f.sender.mainFrame = { ...f.frame };
  expect(lease.assertCurrent).toThrow();
  lease.dispose();
  expect(f.sender.eventNames()).toHaveLength(0);
});
test("main-frame navigation, render crash and destruction abort outstanding work", () => {
  for (const event of ["did-start-navigation", "render-process-gone", "destroyed"]) {
    const f = fixture(),
      lease = captureSourceCollectionOwner({ ...f, isMainWindow: () => true });
    f.sender.emit(event, {}, "https://example.invalid", false, true);
    expect(lease.signal.aborted).toBe(true);
    expect(lease.assertCurrent).toThrow();
    lease.dispose();
    expect(f.sender.eventNames()).toHaveLength(0);
  }
});
test("child navigation does not cancel owner; routing and process identity cannot change", () => {
  const f = fixture(),
    lease = captureSourceCollectionOwner({ ...f, isMainWindow: () => true });
  f.sender.emit("did-start-navigation", {}, "https://example.invalid", false, false);
  expect(lease.signal.aborted).toBe(false);
  lease.assertCurrent();
  f.frame.routingId++;
  expect(lease.assertCurrent).toThrow();
  lease.dispose();
});
test("IPC closes invocation leases on success and on failure", async () => {
  const handlers = new Map<string, (...args: any[]) => Promise<unknown>>();
  let disposed = 0;
  registerSourceCollectionIpc({
    ipcMain: {
      handle: (name, fn) => {
        handlers.set(name, fn);
      },
    },
    open: () => ({
      api: {
        get: async (id: string) => {
          if (id === "bad") throw new Error("failure");
          return id;
        },
      } as any,
      dispose: () => {
        disposed++;
      },
    }),
  });
  expect(handlers.size).toBe(5);
  expect(await handlers.get("sources:collections:get")!({}, "good")).toBe("good");
  await expect(handlers.get("sources:collections:get")!({}, "bad")).rejects.toThrow("failure");
  expect(disposed).toBe(2);
});
