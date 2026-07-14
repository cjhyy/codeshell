// Run through plugin-panel-protocol.test.ts in a fresh Bun process so Electron
// ESM mocks cannot collide with the rest of the repository's test modules.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  installPluginPanelElectronMock,
  pluginPanelElectronMock,
} from "../plugin-panel-electron-mock.js";

let api: typeof import("../../src/main/plugin-panel-protocol.js");
let PluginPanelBridge: typeof import("../../src/main/plugin-panel-bridge.js").PluginPanelBridge;

installPluginPanelElectronMock();

beforeAll(async () => {
  installPluginPanelElectronMock();
  api = await import("../../src/main/plugin-panel-protocol.js");
  ({ PluginPanelBridge } = await import("../../src/main/plugin-panel-bridge.js"));
});

afterAll(() => {
  mock.restore();
});

describe("csplugin protocol", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
    pluginPanelElectronMock.protocolHandler = null;
  });

  async function arrange(hostId: string) {
    root = mkdtempSync(join(tmpdir(), "csplugin-protocol-"));
    mkdirSync(join(root, "panels", "dashboard"), { recursive: true });
    writeFileSync(join(root, "panels", "dashboard", "index.html"), "<h1>safe</h1>");
    writeFileSync(join(root, "panels", "dashboard", "app.js"), "console.log('safe')");
    const descriptor = {
      id: `plugin:demo@local:${hostId}`,
      installKey: "demo@local",
      pluginName: "demo",
      panelId: hostId,
      title: "Demo",
      icon: "panel" as const,
      singleton: true,
      permissions: [],
      hostId,
    };
    api.replacePluginPanelResources([{ descriptor, root, entry: "panels/dashboard/index.html" }]);
    const prepared = await api.preparePluginPanel(descriptor.id);
    expect(pluginPanelElectronMock.protocolHandler).not.toBeNull();
    return prepared;
  }

  test("serves declared static assets with strict security headers", async () => {
    const prepared = await arrange("safehost");
    const html = await pluginPanelElectronMock.protocolHandler!(new Request(prepared.src));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("safe");
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    const script = await pluginPanelElectronMock.protocolHandler!(
      new Request("csplugin://safehost/panels/dashboard/app.js"),
    );
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
  });

  test("rejects traversal, query strings, dotfiles, and assets outside the panel tree", async () => {
    await arrange("rejecthost");
    const urls = [
      "csplugin://rejecthost/panels/dashboard/%2e%2e/secret.json",
      "csplugin://rejecthost/panels/dashboard/app.js?token=x",
      "csplugin://rejecthost/panels/dashboard/.secret.json",
      "csplugin://rejecthost/other/app.js",
    ];
    for (const url of urls) {
      const result = await pluginPanelElectronMock.protocolHandler!(new Request(url));
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("rejects a symlink escape even when the extension is allowed", async () => {
    await arrange("symlinkhost");
    const outside = join(root, "..", `outside-${process.pid}.json`);
    writeFileSync(outside, '{"secret":true}');
    symlinkSync(outside, join(root, "panels", "dashboard", "escape.json"));
    try {
      const result = await pluginPanelElectronMock.protocolHandler!(
        new Request("csplugin://symlinkhost/panels/dashboard/escape.json"),
      );
      expect(result.status).toBe(403);
    } finally {
      rmSync(outside, { force: true });
    }
  });
});

function fakeGuest(id: number) {
  const once = new Map<string, () => void>();
  return {
    id,
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => once.set(event, listener),
    on: () => undefined,
    setWindowOpenHandler: () => undefined,
    send: () => undefined,
    stop: () => undefined,
    destroyForTest: () => once.get("destroyed")?.(),
  };
}

function bridgeResource(permissions: string[] = []) {
  return {
    descriptor: {
      id: "plugin:demo@local:dashboard",
      installKey: "demo@local",
      pluginName: "demo",
      panelId: "dashboard",
      title: "Dashboard",
      icon: "panel" as const,
      singleton: true,
      permissions: permissions as any,
      hostId: "host",
    },
    root: "/plugin",
    entry: "panels/index.html",
  };
}

async function bindBridgeGuest(guestId: number, overrides: Record<string, unknown> = {}) {
  return pluginPanelElectronMock.ipcHandlers.get("plugin-panels:bind")!(
    { sender: pluginPanelElectronMock.trustedSender },
    {
      guestId,
      panelId: "plugin:demo@local:dashboard",
      tabId: `tab-${guestId}`,
      bucket: "repo::session-1",
      sessionId: "session-1",
      cwd: "/repo",
      visible: true,
      busy: false,
      theme: "dark",
      locale: "zh-CN",
      trusted: true,
      ...overrides,
    },
  );
}

describe("PluginPanelBridge", () => {
  test("binds scope from the trusted host and exposes only permitted context", async () => {
    const bridge = new PluginPanelBridge({
      isTrustedHost: (sender) => sender === pluginPanelElectronMock.trustedSender,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(7);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["context.session"]) as any,
    );

    await bindBridgeGuest(7, { busy: true });

    const context = (await pluginPanelElectronMock.ipcHandlers.get("plugin-panel:get-context")!({
      sender: guest,
    })) as Record<string, unknown>;
    expect(context).toMatchObject({
      panelId: "dashboard",
      pluginId: "demo@local",
      visible: true,
      busy: true,
      theme: "dark",
      locale: "zh-CN",
      apiVersion: 1,
    });
    expect(context.sessionId).toBe("session-1");
    expect(context.cwd).toBeUndefined();
  });

  test("defaults to zero call permissions and rejects an unbound sender", async () => {
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(8);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource() as any,
    );
    await bindBridgeGuest(8);

    await expect(
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "storage.get",
        { key: "x" },
      ),
    ).rejects.toThrow(/permission denied/);
    await expect(
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: fakeGuest(99) },
        "storage.get",
        { key: "x" },
      ),
    ).rejects.toThrow(/scope is not bound/);
  });

  test("enforces payload limits and revokes a destroyed guest", async () => {
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(9);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["storage"]) as any,
    );
    await bindBridgeGuest(9);

    await expect(
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "storage.get",
        { key: "x", padding: "x".repeat(70 * 1024) },
      ),
    ).rejects.toThrow(/too large/);
    guest.destroyForTest();
    expect(() =>
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:get-context")!({ sender: guest }),
    ).toThrow(/scope is not bound/);
  });

  test("rejects prompt submission while the trusted session scope is busy", async () => {
    let workerCalls = 0;
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      getAgentBridge: () =>
        ({
          requestWorker: async () => {
            workerCalls += 1;
            return { ok: true, result: {} };
          },
        }) as any,
    });
    bridge.registerIpc();
    const guest = fakeGuest(10);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "agent.submitPrompt"]) as any,
    );
    await bindBridgeGuest(10, { busy: true });

    await expect(
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "agent.submitPrompt",
        { prompt: "continue" },
      ),
    ).rejects.toThrow(/busy/);
    expect(workerCalls).toBe(0);
  });
});
