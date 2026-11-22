import { expect, test } from "bun:test";
import { randomUUID, randomBytes } from "node:crypto";
import { MessageChannel } from "node:worker_threads";
import { CloudAccountStore } from "@cjhyy/code-shell-server/account";
import { fixtureCipher } from "../../../server/src/account/__fixtures__/native-account-fixture-store.js";
import { NativeRemoteClient } from "./desktop-host/remote-client.js";
import { bindRemoteServices } from "../host/remote/service.js";
import { nodePrivatePort } from "../host/native-peer.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDesktopRemoteServices } from "./desktop-remote-services.js";

test("remote composition scopes IPC and reads the computer directory without local enrollment", async () => {
  const root = mkdtempSync(join(tmpdir(), "desktop-remote-composition-"));
  const handlers = new Map<string, (...args: any[]) => any>();
  let starts = 0;
  let owned = true;
  const sender = { mainFrame: {}, isDestroyed: () => false, send: () => {} };
  const window = { webContents: sender, isDestroyed: () => false };
  const previousFetch = globalThis.fetch;
  const remote = new NativeRemoteClient();
  let host: ReturnType<typeof bindRemoteServices> | undefined;
  const cipher = fixtureCipher();
  let services: ReturnType<typeof createDesktopRemoteServices> | undefined;
  try {
    services = createDesktopRemoteServices({
      ipcMain: { handle: (name, handler) => void handlers.set(name, handler) },
      userDataDir: root,
      remote,
      windows: () => (owned ? [window as any] : []),
      safeStorage: {
        isAsyncEncryptionAvailable: async () => true,
        getSelectedStorageBackend: () => "gnome_libsecret",
        encryptStringAsync: async (value) => cipher.encrypt(value),
        decryptStringAsync: async (bytes) => ({
          result: cipher.decrypt(bytes),
          shouldReEncrypt: false,
        }),
      },
      openExternal: async () => {
        starts++;
      },
      host: {
        status: () => undefined,
        stop: async () => {},
        start: async () => {
          starts++;
        },
        onlineDeviceIds: () => [],
      } as any,
      tunnel: { stop: async () => {}, isRunning: () => false, isConnected: () => false } as any,
      binary: {} as any,
      passcode: { isSet: () => false } as any,
      cloudWindows: {
        open: async () => {
          throw new Error("unexpected Cloud window");
        },
        close: async () => {},
      },
      openLegacyCloud: async () => {
        throw new Error("unexpected legacy Cloud window");
      },
    });
    // 17 account/relay/cloud routes, plus explicit account resume and the eight
    // main-frame-owned account computer operations, fixed browser registration,
    // public feature snapshot and refresh.
    // Includes the two main-window account routes for browser sign-in and fixed management pages.
    expect(handlers.size).toBe(31);
    expect(handlers.has("cloudAccount:browser")).toBe(true);
    expect(handlers.has("cloudAccount:openManagement")).toBe(true);
    expect(handlers.has("cloudAccount:resume")).toBe(true);
    expect(handlers.has("cloudAccount:capabilities")).toBe(true);
    expect(handlers.has("cloudAccount:profile")).toBe(true);
    const event = { sender, senderFrame: sender.mainFrame };
    expect(handlers.get("cloudAccount:status")!(event)).toEqual({ state: "signed-out" });
    expect(handlers.get("mobileRemote:status")!(event)).toMatchObject({ running: false });
    expect(handlers.get("mobileRemote:relayStatus")!(event)).toMatchObject({ registered: false });
    // Account computer operations report refusals as `{ ok: false }` values instead
    // of throwing, so no custom Error crosses the context bridge.
    const deviceRoutes = [...handlers].filter(([name]) => name.startsWith("accountDevice:"));
    expect(deviceRoutes.length).toBe(8);
    const ownerRoutes = [...handlers].filter(([name]) => !name.startsWith("accountDevice:"));
    for (const [, handler] of ownerRoutes) {
      expect(() => handler({ ...event, senderFrame: {} }, {})).toThrow();
      expect(() => handler({ ...event, sender: { ...sender } }, {})).toThrow();
    }
    for (const [, handler] of deviceRoutes)
      expect(await handler({ ...event, senderFrame: {} }, {})).toMatchObject({ ok: false });
    owned = false;
    for (const [, handler] of ownerRoutes) expect(() => handler(event, {})).toThrow();
    for (const [, handler] of deviceRoutes)
      expect(await handler(event, {})).toMatchObject({ ok: false });
    expect(starts).toBe(0);

    // Real feature resolution: directory is ready for an account whose local
    // computer has no enrollment, while native dispatch remains pending.
    const origin = "https://account.fixture.invalid";
    const account = { id: randomUUID(), username: "fixture" };
    const features = {
      "devices.directory": { version: 1, enabled: true },
      "devices.dispatch": { version: 1, enabled: true },
    };
    const token = randomBytes(32).toString("base64url");
    new CloudAccountStore(join(root, "cloud-account", "session.enc"), cipher).save({
      origin,
      account,
      accessToken: token,
      refreshToken: randomBytes(32).toString("base64url"),
      sessionId: randomUUID(),
      accessTokenExpiresAt: Date.now() + 600_000,
      refreshTokenExpiresAt: Date.now() + 3_600_000,
    });
    services.cloudAccountManager.capabilities = async () => ({
      features,
      registrationAllowed: false,
      githubEnabled: false,
      relay: {
        enabled: true,
        directoryOrigin: origin,
        protocolVersion: 1,
        accountHandoffVersion: 1,
      },
    });
    services.cloudAccountManager.overview = async () => ({ account, features });
    const { port1, port2 } = new MessageChannel();
    host = bindRemoteServices(nodePrivatePort(port2), root);
    remote.bind(nodePrivatePort(port1));
    for (let i = 0; i < 200 && services.cloudAccountManager.status().state !== "signed-in"; i++)
      await new Promise((resolve) => setTimeout(resolve, 5));
    expect(services.cloudAccountManager.status()).toMatchObject({
      state: "signed-in",
      origin,
      account,
    });
    let directoryReads = 0;
    globalThis.fetch = (async (url: string, init: RequestInit) => {
      expect(url).toBe(`${origin}/api/v1/remote-hosts`);
      expect(init.method).toBe("GET");
      expect(init.redirect).toBe("error");
      expect(init.credentials).toBe("omit");
      expect(init.headers).toMatchObject({ Authorization: `Bearer ${token}` });
      directoryReads++;
      return Response.json({ hosts: [] });
    }) as typeof fetch;
    expect(await services.accountDeviceService.list()).toEqual([]);
    const snapshot = services.accountFeatures.snapshot();
    expect(snapshot["devices.directory"].state).toBe("ready");
    expect(snapshot["devices.dispatch"]).toMatchObject({
      state: "pending",
      reason: "device_not_registered",
    });
    const dispatch = await services.accountDeviceService.projects(1, { hostId: "host" }).then(
      () => undefined,
      (error: Error) => error.message,
    );
    expect(dispatch).toContain("尚未准备好");
    expect(directoryReads).toBe(1);
    expect(starts).toBe(0);
  } finally {
    globalThis.fetch = previousFetch;
    services?.accountDeviceService.retireIdentity();
    services?.accountFeatures.dispose();
    remote.disconnect();
    await host?.close();
    rmSync(root, { recursive: true, force: true });
  }
});
