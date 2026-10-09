import { expect, test } from "bun:test";
import { registerCloudAccountIpc } from "./cloud-account-ipc.js";

test("cloud account IPC rejects non-main frames and rechecks ownership after login/OAuth responses", () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  let destroyed = false;
  let authorized: (() => boolean) | undefined;
  const sender = { mainFrame: {}, isDestroyed: () => destroyed };
  const event = { sender, senderFrame: sender.mainFrame };
  registerCloudAccountIpc({
    ipcMain: {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
    },
    isMainWindow: (contents) => contents === (sender as any),
    manager: {
      status: () => ({ state: "signed-out" }),
      signIn: (_kind, _input, allowed) => {
        authorized = allowed;
      },
      signInWithGitHub: (_input, allowed) => {
        authorized = allowed;
      },
      linkGitHub: (allowed) => {
        authorized = allowed;
      },
      logout: () => {},
      cancelSignIn: () => {},
    } as any,
  });
  for (const handler of handlers.values()) {
    expect(() => handler({ ...event, senderFrame: {} }, {})).toThrow();
    expect(() => handler({ ...event, sender: { ...sender } }, {})).toThrow();
  }
  for (const name of ["login", "register", "github", "linkGitHub"]) {
    handlers.get(`cloudAccount:${name}`)!(event, {});
    expect(authorized!()).toBe(true);
  }
  destroyed = true;
  expect(authorized!()).toBe(false);
  for (const handler of handlers.values()) expect(() => handler(event, {})).toThrow();
});
