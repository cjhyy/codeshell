import { expect, test } from "bun:test";
import type { BrowserWindow, IpcMainInvokeEvent } from "electron";
import { createQuotaApi } from "../preload/quota-api.js";
import { registerQuotaIpc } from "./quota-ipc.js";
import { createLegacyQuotaQuery, UsageProviderService } from "./usage-provider-service.js";

function fixture() {
  const requested: string[] = [];
  const handlers = new Map<string, (event: IpcMainInvokeEvent, input?: unknown) => unknown>();
  const sender = { mainFrame: {} };
  const event = { sender, senderFrame: sender.mainFrame } as unknown as IpcMainInvokeEvent;
  const window = { isDestroyed: () => false, webContents: sender } as unknown as BrowserWindow;
  const service = new UsageProviderService({
    adapters: [
      {
        id: "cli:fixture",
        displayName: "Fixture",
        binary: "fixture",
        quota: {
          supported: true,
          provider: "fixture",
          queryCost: "none",
          query: async () => {
            requested.push("fixture");
            return { provider: "fixture", windows: [] };
          },
        },
      },
    ],
    findExecutable: () => "/fixture/bin",
    modelConnections: () => [],
    catalog: () => [],
  });
  const registration = registerQuotaIpc(
    {
      handle: (name, handler) => {
        handlers.set(name, handler);
      },
      removeHandler: (name) => {
        handlers.delete(name);
      },
    },
    () => [window],
    service,
    createLegacyQuotaQuery(async (providers) => {
      requested.push(...providers);
      return Object.fromEntries(providers.map((provider) => [provider, { provider, windows: [] }]));
    }),
  );
  const api = createQuotaApi({ invoke: async (name, input) => handlers.get(name)!(event, input) });
  return { api, handlers, event, requested, registration };
}

test("production preload reaches provider discovery and selected quota IPC, with legacy compatibility", async () => {
  const f = fixture();
  expect(await f.api.listProviders()).toEqual([
    {
      id: "cli:fixture",
      displayName: "Fixture",
      source: "cli",
      quota: { supported: true, queryCost: "none" },
    },
  ]);
  expect(f.requested).toEqual([]);
  expect(await f.api.query("cli:fixture")).toEqual({ provider: "fixture", windows: [] });
  expect(await f.api.get("codex")).toEqual({ codex: { provider: "codex", windows: [] } });
  expect(f.requested).toEqual(["fixture", "codex"]);
  await expect(f.handlers.get("quota:query")!(f.event)).rejects.toThrow("Invalid usage provider");
  await expect(f.handlers.get("quota:query")!(f.event, "both")).rejects.toThrow("unsupported");
  await expect(f.handlers.get("quota:get")!(f.event, "cli:fixture")).rejects.toThrow(
    "Invalid quota",
  );
  expect(f.requested).toEqual(["fixture", "codex"]);
  f.registration.dispose();
  expect(f.handlers.size).toBe(0);
});

test("unrelated windows and embedded frames cannot discover providers or read credentials", () => {
  const f = fixture();
  for (const handler of f.handlers.values()) {
    expect(() =>
      handler({ ...f.event, senderFrame: {} } as IpcMainInvokeEvent, "cli:fixture"),
    ).toThrow("application window");
    expect(() =>
      handler(
        { ...f.event, sender: { mainFrame: f.event.senderFrame } } as unknown as IpcMainInvokeEvent,
        "cli:fixture",
      ),
    ).toThrow("application window");
  }
  expect(f.requested).toEqual([]);
});
