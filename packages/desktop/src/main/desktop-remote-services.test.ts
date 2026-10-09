import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopRemoteServices } from "./desktop-remote-services.js";

test("remote composition registers owner-scoped IPC without starting cloud or local transports", () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-remote-composition-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  let starts = 0;
  let owned = true;
  const sender = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
  const window = { webContents: sender, isDestroyed: () => false };
  try {
    createDesktopRemoteServices({
      ipcMain: { handle: (name, handler) => void handlers.set(name, handler) },
      userDataDir: root,
      environmentDir: root,
      windows: () => (owned ? [window as any] : []),
      safeStorage: {
        isEncryptionAvailable: () => false,
        getSelectedStorageBackend: () => "basic_text",
        encryptString: () => {
          throw new Error("unexpected encryption before sign-in");
        },
        decryptString: () => {
          throw new Error("unexpected decryption before sign-in");
        },
      },
      openExternal: async () => {
        starts++;
      },
      host: {
        status: () => undefined,
        start: async () => {
          starts++;
        },
        onlineDeviceIds: () => [],
      } as any,
      tunnel: { isRunning: () => false, isConnected: () => false } as any,
      binary: {} as any,
      passcode: { isSet: () => false } as any,
    });
    expect(handlers.size).toBe(14);
    const event = { sender, senderFrame: sender.mainFrame };
    expect(handlers.get("cloudAccount:status")!(event)).toEqual({ state: "signed-out" });
    expect(handlers.get("mobileRemote:status")!(event)).toMatchObject({ running: false });
    expect(handlers.get("mobileRemote:relayStatus")!(event)).toMatchObject({ registered: false });
    for (const handler of handlers.values()) {
      expect(() => handler({ ...event, senderFrame: {} }, {})).toThrow();
      expect(() => handler({ ...event, sender: { ...sender } }, {})).toThrow();
    }
    owned = false;
    for (const handler of handlers.values()) expect(() => handler(event, {})).toThrow();
    expect(starts).toBe(0);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
