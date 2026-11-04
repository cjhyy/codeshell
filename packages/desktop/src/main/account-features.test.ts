import { expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import {
  accountLocalConditions,
  bindAccountFeatureLifecycle,
  registerAccountFeatureIpc,
} from "./account-features.js";
const account = {
  state: "signed-in" as const,
  origin: "https://a.example",
  account: { id: "same-id", username: "user" },
};
test("feature lifecycle waits for Electron ready and only refreshes focused main windows", async () => {
  let ready!: () => void;
  const app = Object.assign(new EventEmitter(), {
    whenReady: () =>
      new Promise<void>((resolve) => {
        ready = resolve;
      }),
  });
  const window = {};
  const refreshes: unknown[][] = [];
  let disposed = 0;
  bindAccountFeatureLifecycle(
    app as any,
    {
      refresh: async (...args: any[]) => {
        refreshes.push(args);
        return {} as any;
      },
      dispose: () => {
        disposed++;
      },
    },
    () => [window] as any,
  );
  expect(refreshes).toEqual([]);
  ready();
  await Promise.resolve();
  expect(refreshes).toEqual([[]]);
  app.emit("browser-window-focus", {}, {});
  expect(refreshes).toHaveLength(1);
  app.emit("browser-window-focus", {}, window);
  expect(refreshes[1]).toEqual([undefined, 60_000]);
  app.emit("before-quit");
  expect(disposed).toBe(0);
  app.emit("browser-window-focus", {}, window);
  expect(refreshes).toHaveLength(3);
  app.emit("will-quit");
  app.emit("will-quit");
  expect(disposed).toBe(1);
});
test("local relay readiness binds both origin and account and leaves setup actionable", () => {
  const relay = {
    state: "ready" as const,
    registered: true,
    relayOrigin: account.origin,
    accountId: account.account.id,
  };
  expect(accountLocalConditions(account, relay)?.["devices.dispatch"]?.ready).toBe(true);
  for (const changed of [
    { ...relay, relayOrigin: "https://b.example" },
    { ...relay, accountId: "other" },
  ]) {
    const local = accountLocalConditions(account, changed);
    expect(local?.["devices.dispatch"]).toEqual({ ready: false, reason: "device_not_registered" });
    expect(local?.["relay.phone"]?.ready).toBe(false);
  }
  const connecting = accountLocalConditions(account, { ...relay, state: "connecting" });
  expect(connecting?.["devices.dispatch"]).toEqual({ ready: false, reason: "relay_connecting" });
  expect(connecting?.["relay.phone"]?.ready).toBe(true);
});
test("feature IPC restricts snapshots, refresh and push to live main windows", async () => {
  const handlers = new Map<string, (...args: any[]) => any>();
  const frame = {};
  let destroyed = false;
  const sent: unknown[] = [];
  const sender = {
    isDestroyed: () => destroyed,
    mainFrame: frame,
    send: (...args: any[]) => sent.push(args),
  };
  let publish!: (value: any) => void;
  let reads = 0;
  let refreshes = 0;
  const service = {
    snapshot: () => {
      reads++;
      return {};
    },
    refresh: async () => {
      refreshes++;
      return {};
    },
    onChanged: (cb: any) => {
      publish = cb;
      return () => {};
    },
  };
  const binding = registerAccountFeatureIpc({
    ipcMain: {
      handle: (name, handler) => handlers.set(name, handler),
      removeHandler: (name) => {
        handlers.delete(name);
      },
    },
    service: service as any,
    windows: () => [{ isDestroyed: () => destroyed, webContents: sender }] as any,
  });
  const event = { sender, senderFrame: frame };
  for (const [name, handler] of handlers) {
    expect(() => handler({ ...event, senderFrame: {} })).toThrow();
    expect(() => handler({ ...event, sender: { ...sender } })).toThrow();
    await handler(event);
    expect(name.startsWith("accountFeatures:")).toBe(true);
  }
  expect([reads, refreshes]).toEqual([1, 1]);
  publish({});
  expect(sent).toHaveLength(1);
  destroyed = true;
  publish({});
  expect(sent).toHaveLength(1);
  binding.dispose();
  expect(handlers.size).toBe(0);
});
