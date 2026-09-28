import { expect, test } from "bun:test";
import { registerDeviceRelayIpc } from "./device-relay-ipc.js";
test("only live main frames can register/read/forget a computer, including completion-time ownership", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let destroyed = false;
  const sender = { isDestroyed: () => destroyed, mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame };
  let authorize: (() => boolean) | undefined;
  registerDeviceRelayIpc({
    ipcMain: {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    isMainWindow: (contents) => contents === (sender as any),
    controller: {
      relayStatus: () => ({ registered: false }),
      enroll: (_input, allowed) => {
        authorize = allowed;
      },
      forget: () => {},
    } as any,
  });
  for (const handler of handlers.values()) {
    expect(() => handler({ ...event, senderFrame: {} }, {})).toThrow();
    expect(() => handler({ ...event, sender: { ...sender } }, {})).toThrow();
  }
  handlers.get("mobileRemote:relayEnroll")!(event, {});
  expect(authorize!()).toBe(true);
  destroyed = true;
  expect(authorize!()).toBe(false);
  for (const handler of handlers.values()) expect(() => handler(event, {})).toThrow();
});
