// Run through plugin-panel-protocol.test.ts in a fresh Bun process so Electron
// ESM mocks cannot collide with the rest of the repository's test modules.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
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
    pluginPanelElectronMock.dialogResponse = 1;
    pluginPanelElectronMock.openedUrls.length = 0;
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
      revision: hostId,
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
      revision: "revision-1",
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
      ...overrides,
    },
  );
}

describe("PluginPanelBridge", () => {
  test("binds scope from the trusted host and exposes only permitted context", async () => {
    const bridge = new PluginPanelBridge({
      isTrustedHost: (sender) => sender === pluginPanelElectronMock.trustedSender,
      isWorkspaceTrusted: (cwd) => cwd === "/repo",
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(7);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "context.workspace"]) as any,
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
    expect(context.cwd).toBe("/repo");
    expect(context.trusted).toBe(true);
  });

  test("defaults to zero call permissions and rejects an unbound sender", async () => {
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
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
      isWorkspaceTrusted: () => false,
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
      isWorkspaceTrusted: () => false,
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

  test("serializes storage mutations, persists atomically, and enforces quota", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "csplugin-storage-"));
    pluginPanelElectronMock.userDataPath = storageRoot;
    try {
      const bridge = new PluginPanelBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: () => false,
        getAgentBridge: () => null,
        limits: { storageQuotaBytes: 256 },
      });
      bridge.registerIpc();
      const guest = fakeGuest(11);
      bridge.registerGuest(
        guest as any,
        pluginPanelElectronMock.ownerWindow as any,
        bridgeResource(["storage"]) as any,
      );
      await bindBridgeGuest(11);
      const call = (method: string, params: unknown) =>
        pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
          { sender: guest },
          method,
          params,
        ) as Promise<unknown>;

      await Promise.all([
        call("storage.set", { key: "left", value: 1 }),
        call("storage.set", { key: "right", value: 2 }),
      ]);
      expect(await call("storage.get", { key: "left" })).toBe(1);
      expect(await call("storage.get", { key: "right" })).toBe(2);
      expect(await call("storage.delete", { key: "left" })).toBe(true);
      await expect(call("storage.set", { key: "large", value: "x".repeat(512) })).rejects.toThrow(
        /quota/,
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
      pluginPanelElectronMock.userDataPath = "/tmp/codeshell-plugin-panel-test";
    }
  });

  test("confirms external URLs and rejects unsafe schemes", async () => {
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(12);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["external.open"]) as any,
    );
    await bindBridgeGuest(12);
    const call = (url: string) =>
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "external.open",
        { url },
      ) as Promise<unknown>;
    await expect(call("file:///etc/passwd")).rejects.toThrow(/https/);
    pluginPanelElectronMock.dialogResponse = 0;
    expect(await call("https://example.com/path")).toBe(true);
    expect(pluginPanelElectronMock.openedUrls).toEqual(["https://example.com/path"]);
  });

  test("enforces call rate, timeout, and result size independently", async () => {
    const pending = new Promise<never>(() => undefined);
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      getAgentBridge: () =>
        ({
          requestWorker: async (_method: string, params: Record<string, unknown>) =>
            params.task === "hang" ? pending : { ok: true, result: { text: "x".repeat(256) } },
        }) as any,
      limits: {
        maxCallsPerWindow: 3,
        rateWindowMs: 60_000,
        callTimeoutMs: 5,
        maxResultBytes: 64,
      },
    });
    bridge.registerIpc();
    const guest = fakeGuest(13);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "agent.submitPrompt"]) as any,
    );
    await bindBridgeGuest(13);
    const call = (prompt: string) =>
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "agent.submitPrompt",
        { prompt },
      ) as Promise<unknown>;
    await expect(call("large")).rejects.toThrow(/result is too large/);
    await expect(call("hang")).rejects.toThrow(/timed out/);
    await expect(call("large-again")).rejects.toThrow(/result is too large/);
    await expect(call("rate")).rejects.toThrow(/rate limit/);
  });

  test("returns read-only workspace metadata with a best-effort git branch", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "csplugin-workspace-"));
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    try {
      const bridge = new PluginPanelBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: (cwd) => cwd === workspaceRoot,
        getAgentBridge: () => null,
      });
      bridge.registerIpc();
      const guest = fakeGuest(14);
      bridge.registerGuest(
        guest as any,
        pluginPanelElectronMock.ownerWindow as any,
        bridgeResource(["workspace.info"]) as any,
      );
      await bindBridgeGuest(14, { cwd: workspaceRoot });
      const info = await pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "workspace.info",
        {},
      );
      expect(info).toEqual({
        name: basename(workspaceRoot),
        root: workspaceRoot,
        trusted: true,
        gitBranch: "feature/x",
      });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("sends title-prefixed system notifications under a dedicated per-window cap", async () => {
    const shown: { title: string; body: string }[] = [];
    const bridge = new PluginPanelBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      getAgentBridge: () => null,
      showNotification: (notification) => {
        shown.push(notification);
        return true;
      },
      limits: { maxNotificationsPerWindow: 2, rateWindowMs: 60_000 },
    });
    bridge.registerIpc();
    const guest = fakeGuest(15);
    bridge.registerGuest(
      guest as any,
      pluginPanelElectronMock.ownerWindow as any,
      bridgeResource(["notifications.send"]) as any,
    );
    await bindBridgeGuest(15);
    const call = (params: unknown) =>
      pluginPanelElectronMock.ipcHandlers.get("plugin-panel:call")!(
        { sender: guest },
        "notifications.send",
        params,
      ) as Promise<unknown>;

    expect(await call({ body: "build finished" })).toBe(true);
    expect(await call({ title: "CI", body: "build finished" })).toBe(true);
    // The panel title always prefixes the notification: no app impersonation.
    expect(shown).toEqual([
      { title: "Dashboard", body: "build finished" },
      { title: "Dashboard: CI", body: "build finished" },
    ]);
    await expect(call({ body: "third" })).rejects.toThrow(/notification limit/);
    await expect(call({ body: "" })).rejects.toThrow(/non-empty body/);
  });
});
