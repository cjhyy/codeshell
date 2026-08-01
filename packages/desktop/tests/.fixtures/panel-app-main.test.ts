// Run through panel-app-protocol.test.ts in a fresh Bun process so Electron
// ESM mocks cannot collide with the rest of the repository's test modules.
import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import {
  chmodSync,
  mkdtempSync,
  mkdirSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { basename, join } from "node:path";
import { tmpdir } from "node:os";
import { installPanelAppElectronMock, panelAppElectronMock } from "../panel-app-electron-mock.js";

let api: typeof import("../../src/main/panel-app-protocol.js");
let PanelAppBridge: typeof import("../../src/main/panel-app-bridge.js").PanelAppBridge;

installPanelAppElectronMock();

beforeAll(async () => {
  installPanelAppElectronMock();
  api = await import("../../src/main/panel-app-protocol.js");
  ({ PanelAppBridge } = await import("../../src/main/panel-app-bridge.js"));
});

afterAll(() => {
  mock.restore();
});

describe("Panel App protocol", () => {
  let root = "";

  afterEach(() => {
    if (root) rmSync(root, { recursive: true, force: true });
    root = "";
    panelAppElectronMock.protocolHandler = null;
    panelAppElectronMock.dialogResponse = 1;
    panelAppElectronMock.openedUrls.length = 0;
  });

  async function arrange(hostId: string) {
    root = mkdtempSync(join(tmpdir(), "cspanel-protocol-"));
    mkdirSync(join(root, "panels", "dashboard"), { recursive: true });
    writeFileSync(join(root, "panels", "dashboard", "index.html"), "<h1>safe</h1>");
    writeFileSync(join(root, "panels", "dashboard", "app.js"), "console.log('safe')");
    const descriptor = {
      id: `panel-app:${hostId}`,
      appId: hostId,
      title: "Demo",
      version: "1.0.0",
      icon: "panel" as const,
      singleton: true,
      permissions: [],
      hostId,
      revision: hostId,
    };
    api.replacePanelAppResources([{ descriptor, root, entry: "panels/dashboard/index.html" }]);
    const prepared = await api.preparePanelApp(descriptor.id, "/repo/alpha");
    expect(panelAppElectronMock.protocolHandler).not.toBeNull();
    return prepared;
  }

  test("serves declared static assets with strict security headers", async () => {
    const prepared = await arrange("safehost");
    const html = await panelAppElectronMock.protocolHandler!(new Request(prepared.src));
    expect(html.status).toBe(200);
    expect(await html.text()).toContain("safe");
    expect(html.headers.get("content-security-policy")).toContain("connect-src 'none'");
    expect(html.headers.get("content-security-policy")).toContain("frame-src 'self'");
    expect(html.headers.get("x-content-type-options")).toBe("nosniff");

    const script = await panelAppElectronMock.protocolHandler!(
      new Request("cspanel://safehost/panels/dashboard/app.js"),
    );
    expect(script.status).toBe(200);
    expect(script.headers.get("content-type")).toContain("text/javascript");
  });

  test("rejects traversal, query strings, dotfiles, and assets outside the panel tree", async () => {
    await arrange("rejecthost");
    const urls = [
      "cspanel://rejecthost/panels/dashboard/%2e%2e/secret.json",
      "cspanel://rejecthost/panels/dashboard/app.js?token=x",
      "cspanel://rejecthost/panels/dashboard/.secret.json",
      "cspanel://rejecthost/other/app.js",
    ];
    for (const url of urls) {
      const result = await panelAppElectronMock.protocolHandler!(new Request(url));
      expect(result.status).toBeGreaterThanOrEqual(400);
    }
  });

  test("rejects a symlink escape even when the extension is allowed", async () => {
    await arrange("symlinkhost");
    const outside = join(root, "..", `outside-${process.pid}.json`);
    writeFileSync(outside, '{"secret":true}');
    symlinkSync(outside, join(root, "panels", "dashboard", "escape.json"));
    try {
      const result = await panelAppElectronMock.protocolHandler!(
        new Request("cspanel://symlinkhost/panels/dashboard/escape.json"),
      );
      expect(result.status).toBe(403);
    } finally {
      rmSync(outside, { force: true });
    }
  });

  test("uses separate WebView partitions for separate projects", async () => {
    const first = await arrange("scopedhost");
    const second = await api.preparePanelApp("panel-app:scopedhost", "/repo/beta");
    expect(first.partition).not.toBe(second.partition);
    expect(api.preparedPanelAppPartitionProjectPath("scopedhost", first.partition)).toBe(
      "/repo/alpha",
    );
    expect(api.preparedPanelAppPartitionProjectPath("scopedhost", second.partition)).toBe(
      "/repo/beta",
    );
  });
});

function fakeGuest(
  id: number,
  onSend?: (channel: string, payload: Record<string, unknown>) => void,
) {
  const once = new Map<string, () => void>();
  const sent: Array<{ channel: string; payload: Record<string, unknown> }> = [];
  return {
    id,
    isDestroyed: () => false,
    once: (event: string, listener: () => void) => once.set(event, listener),
    on: () => undefined,
    setWindowOpenHandler: () => undefined,
    send: (channel: string, payload: Record<string, unknown>) => {
      sent.push({ channel, payload });
      onSend?.(channel, payload);
    },
    stop: () => undefined,
    destroyForTest: () => once.get("destroyed")?.(),
    sent,
  };
}

function bridgeResource(
  permissions: string[] = [],
  agentTools: Array<{
    name: string;
    description: string;
    inputSchema: Record<string, unknown>;
    readOnly: boolean;
  }> = [],
) {
  return {
    descriptor: {
      id: "panel-app:demo",
      appId: "demo",
      title: "Dashboard",
      version: "1.0.0",
      icon: "panel" as const,
      singleton: true,
      permissions: permissions as any,
      ...(agentTools.length > 0 ? { agent: { tools: agentTools, skills: [] } } : {}),
      hostId: "host",
      revision: "revision-1",
    },
    root: "/plugin",
    entry: "panels/index.html",
  };
}

async function bindBridgeGuest(guestId: number, overrides: Record<string, unknown> = {}) {
  return panelAppElectronMock.ipcHandlers.get("panel-apps:bind")!(
    { sender: panelAppElectronMock.trustedSender },
    {
      guestId,
      appDescriptorId: "panel-app:demo",
      tabId: `tab-${guestId}`,
      bucket: "repo::session-1",
      sessionId: "session-1",
      projectPath: "/repo",
      cwd: "/repo",
      visible: true,
      busy: false,
      theme: "dark",
      locale: "zh-CN",
      ...overrides,
    },
  );
}

describe("PanelAppBridge", () => {
  afterEach(() => {
    panelAppElectronMock.ipcHandlers.clear();
    panelAppElectronMock.ipcListeners.clear();
  });

  test("fails closed before prepare and after a project binding is revoked", async () => {
    let bound = false;
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => bound,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    expect(() =>
      panelAppElectronMock.ipcHandlers.get("panel-apps:prepare")!(
        { sender: panelAppElectronMock.trustedSender },
        "panel-app:demo",
        "/repo",
      ),
    ).toThrow(/not bound/);

    bound = true;
    const guest = fakeGuest(30);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource() as any,
      "/repo",
    );
    await expect(bindBridgeGuest(30, { cwd: "/other" })).rejects.toThrow(/does not belong/);
    await bindBridgeGuest(30);
    bound = false;
    expect(() =>
      panelAppElectronMock.ipcHandlers.get("panel-app:get-context")!({ sender: guest }),
    ).toThrow(/no longer bound/);
  });

  test("invokes only declared Agent tools and accepts a response from the bound guest", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: (sender) => sender === panelAppElectronMock.trustedSender,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
      limits: { maxParamsBytes: 64 },
    });
    bridge.registerIpc();
    const guest = fakeGuest(24, (channel, payload) => {
      if (channel !== "panel-app:agent-tool-request") return;
      queueMicrotask(() => {
        panelAppElectronMock.ipcListeners.get("panel-app:agent-tool-response")?.(
          { sender: guest },
          {
            requestId: payload.requestId,
            ok: true,
            result: { echoed: payload.arguments },
          },
        );
      });
    });
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(
        [],
        [
          {
            name: "echo_design",
            description: "Echo a design request",
            inputSchema: {
              type: "object",
              properties: {
                node_id: { type: "string" },
                options: {
                  type: "object",
                  properties: {
                    mode: { type: "string", enum: ["inspect", "edit"] },
                  },
                  required: ["mode"],
                  additionalProperties: false,
                },
              },
              required: ["node_id"],
              additionalProperties: false,
            },
            readOnly: true,
          },
        ],
      ) as any,
      "/repo",
    );
    await bindBridgeGuest(24);

    const invoke = panelAppElectronMock.ipcHandlers.get("panel-apps:invoke-agent-tool")!;
    await expect(
      invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "missing_tool",
          arguments: {},
        },
      ),
    ).rejects.toThrow(/not declared/);
    await expect(
      invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "echo_design",
          arguments: {},
        },
      ),
    ).rejects.toThrow(/Missing required parameter: node_id/);
    await expect(
      invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "echo_design",
          arguments: { node_id: 42 },
        },
      ),
    ).rejects.toThrow(/must be a string/);
    await expect(
      invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "echo_design",
          arguments: { node_id: "hero", options: { mode: "delete" } },
        },
      ),
    ).rejects.toThrow(/enum/);
    await expect(
      invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "echo_design",
          arguments: { node_id: "hero", extra: true },
        },
      ),
    ).rejects.toThrow(/Unexpected parameter/);
    await expect(
      invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "echo_design",
          arguments: { node_id: "x".repeat(100) },
        },
      ),
    ).rejects.toThrow(/arguments are too large/);
    expect(
      await invoke(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "echo_design",
          arguments: { node_id: "hero" },
        },
      ),
    ).toEqual({ echoed: { node_id: "hero" } });
    expect(
      guest.sent.filter((message) => message.channel === "panel-app:agent-tool-request"),
    ).toHaveLength(1);
  });

  test("clears an Agent tool request when the guest send fails synchronously", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
      limits: { callTimeoutMs: 1_000 },
    });
    bridge.registerIpc();
    const guest = fakeGuest(28, (channel) => {
      if (channel === "panel-app:agent-tool-request") throw new Error("guest unavailable");
    });
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(
        [],
        [
          {
            name: "read_design",
            description: "Read a design",
            inputSchema: { type: "object" },
            readOnly: true,
          },
        ],
      ) as any,
      "/repo",
    );
    await bindBridgeGuest(28);

    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-apps:invoke-agent-tool")!(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "read_design",
          arguments: {},
        },
      ),
    ).rejects.toThrow(/guest unavailable/);
    expect((bridge as any).pendingAgentToolCalls.size).toBe(0);
  });

  test("ignores an Agent tool response from a different guest", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
      limits: { callTimeoutMs: 10 },
    });
    bridge.registerIpc();
    const attacker = fakeGuest(26);
    const guest = fakeGuest(25, (_channel, payload) => {
      queueMicrotask(() => {
        panelAppElectronMock.ipcListeners.get("panel-app:agent-tool-response")?.(
          { sender: attacker },
          { requestId: payload.requestId, ok: true, result: "spoofed" },
        );
      });
    });
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(
        [],
        [
          {
            name: "read_design",
            description: "Read a design",
            inputSchema: { type: "object" },
            readOnly: true,
          },
        ],
      ) as any,
      "/repo",
    );
    await bindBridgeGuest(25);
    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-apps:invoke-agent-tool")!(
        { sender: panelAppElectronMock.trustedSender },
        {
          appDescriptorId: "panel-app:demo",
          bucket: "repo::session-1",
          toolName: "read_design",
          arguments: {},
        },
      ),
    ).rejects.toThrow(/timed out/);
  });

  test("rejects an in-flight Agent tool immediately when its app is revoked", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
      limits: { callTimeoutMs: 1_000 },
    });
    bridge.registerIpc();
    const guest = fakeGuest(27);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(
        [],
        [
          {
            name: "read_design",
            description: "Read a design",
            inputSchema: { type: "object" },
            readOnly: true,
          },
        ],
      ) as any,
      "/repo",
    );
    await bindBridgeGuest(27);

    const invocation = panelAppElectronMock.ipcHandlers.get("panel-apps:invoke-agent-tool")!(
      { sender: panelAppElectronMock.trustedSender },
      {
        appDescriptorId: "panel-app:demo",
        bucket: "repo::session-1",
        toolName: "read_design",
        arguments: {},
      },
    ) as Promise<unknown>;
    await Promise.resolve();
    bridge.revokeAppId("demo");

    await expect(invocation).rejects.toThrow(/closed before its Agent tool completed/);
    expect(() =>
      panelAppElectronMock.ipcHandlers.get("panel-app:get-context")!({ sender: guest }),
    ).toThrow(/scope is not bound/);
  });

  test("binds scope from the trusted host and exposes only permitted context", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: (sender) => sender === panelAppElectronMock.trustedSender,
      isWorkspaceTrusted: (cwd) => cwd === "/repo",
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(7);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "context.workspace"]) as any,
      "/repo",
    );

    await bindBridgeGuest(7, { busy: true });

    const context = (await panelAppElectronMock.ipcHandlers.get("panel-app:get-context")!({
      sender: guest,
    })) as Record<string, unknown>;
    expect(context).toMatchObject({
      appId: "demo",
      visible: true,
      busy: true,
      theme: "dark",
      locale: "zh-CN",
      apiVersion: 2,
    });
    expect(context.sessionId).toBe("session-1");
    expect(context.cwd).toBe("/repo");
    expect(context.trusted).toBe(true);
  });

  test("defaults to zero call permissions and rejects an unbound sender", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(8);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource() as any,
      "/repo",
    );
    await bindBridgeGuest(8);

    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!({ sender: guest }, "storage.get", {
        key: "x",
      }),
    ).rejects.toThrow(/permission denied/);
    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
        { sender: fakeGuest(99) },
        "storage.get",
        { key: "x" },
      ),
    ).rejects.toThrow(/scope is not bound/);
  });

  test("denies workspace.info when the panel has not declared the permission", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(16);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource() as any,
      "/repo",
    );
    await bindBridgeGuest(16);
    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
        { sender: guest },
        "workspace.info",
        {},
      ),
    ).rejects.toThrow(/permission denied/);
  });

  test("denies notifications.send when the panel has not declared the permission", async () => {
    const shown: { title: string; body: string }[] = [];
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
      showNotification: (notification) => {
        shown.push(notification);
        return true;
      },
    });
    bridge.registerIpc();
    const guest = fakeGuest(17);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource() as any,
      "/repo",
    );
    await bindBridgeGuest(17);
    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
        { sender: guest },
        "notifications.send",
        { body: "should not show" },
      ),
    ).rejects.toThrow(/permission denied/);
    // Gating happens before the notification hook.
    expect(shown).toEqual([]);
  });

  test("enforces payload limits and revokes a destroyed guest", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(9);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["storage"]) as any,
      "/repo",
    );
    await bindBridgeGuest(9);

    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!({ sender: guest }, "storage.get", {
        key: "x",
        padding: "x".repeat(70 * 1024),
      }),
    ).rejects.toThrow(/too large/);
    guest.destroyForTest();
    expect(() =>
      panelAppElectronMock.ipcHandlers.get("panel-app:get-context")!({ sender: guest }),
    ).toThrow(/scope is not bound/);
  });

  test("rejects prompt submission while the trusted session scope is busy", async () => {
    let workerCalls = 0;
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
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
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "agent.submitPrompt"]) as any,
      "/repo",
    );
    await bindBridgeGuest(10, { busy: true });

    await expect(
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
        { sender: guest },
        "agent.submitPrompt",
        { prompt: "continue" },
      ),
    ).rejects.toThrow(/busy/);
    expect(workerCalls).toBe(0);
  });

  test("serializes storage mutations, persists atomically, and enforces quota", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cspanel-storage-"));
    panelAppElectronMock.userDataPath = storageRoot;
    try {
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: () => false,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
        limits: { storageQuotaBytes: 256 },
      });
      bridge.registerIpc();
      const guest = fakeGuest(11);
      bridge.registerGuest(
        guest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["storage"]) as any,
        "/repo",
      );
      await bindBridgeGuest(11);
      const call = (method: string, params: unknown) =>
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
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

      const otherProjectGuest = fakeGuest(29);
      bridge.registerGuest(
        otherProjectGuest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["storage"]) as any,
        "/repo/other",
      );
      await bindBridgeGuest(29, {
        projectPath: "/repo/other",
        cwd: "/repo/other",
      });
      expect(
        await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: otherProjectGuest },
          "storage.get",
          { key: "right" },
        ),
      ).toBeNull();

      await expect(call("storage.set", { key: "large", value: "x".repeat(512) })).rejects.toThrow(
        /quota/,
      );
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
      panelAppElectronMock.userDataPath = "/tmp/codeshell-panel-app-test";
    }
  });

  test("accepts a recovery snapshot larger than the generic call limit within storage quota", async () => {
    const storageRoot = mkdtempSync(join(tmpdir(), "cspanel-recovery-"));
    panelAppElectronMock.userDataPath = storageRoot;
    try {
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: () => false,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
        limits: { storageQuotaBytes: 96 * 1024 },
      });
      bridge.registerIpc();
      const guest = fakeGuest(23);
      bridge.registerGuest(
        guest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["storage"]) as any,
        "/repo",
      );
      await bindBridgeGuest(23);
      const call = (method: string, params: unknown) =>
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: guest },
          method,
          params,
        ) as Promise<unknown>;
      const recovery = { path: "designs/home.codesign.json", design: "x".repeat(70 * 1024) };
      expect(await call("storage.set", { key: "recovery", value: recovery })).toBe(true);
      expect(await call("storage.get", { key: "recovery" })).toEqual(recovery);
    } finally {
      rmSync(storageRoot, { recursive: true, force: true });
      panelAppElectronMock.userDataPath = "/tmp/codeshell-panel-app-test";
    }
  });

  test("confirms external URLs and rejects unsafe schemes", async () => {
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () => null,
    });
    bridge.registerIpc();
    const guest = fakeGuest(12);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["external.open"]) as any,
      "/repo",
    );
    await bindBridgeGuest(12);
    const call = (url: string) =>
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!({ sender: guest }, "external.open", {
        url,
      }) as Promise<unknown>;
    await expect(call("file:///etc/passwd")).rejects.toThrow(/https/);
    panelAppElectronMock.dialogResponse = 0;
    expect(await call("https://example.com/path")).toBe(true);
    expect(panelAppElectronMock.openedUrls).toEqual(["https://example.com/path"]);
  });

  // The rate/timeout/size limits are generic wrappers around dispatch(), so they
  // are exercised through a method that actually AWAITS its work. They must NOT
  // be tested through agent.submitPrompt: that call is fire-and-forget by design
  // (see the two tests below), so it can neither time out nor return a payload
  // big enough to trip maxResultBytes.
  test("enforces call rate, timeout, and result size independently", async () => {
    // A real directory is still needed: bindGuest validates the project path.
    // Its CONTENTS are irrelevant — workspaceReadText is stubbed below.
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cspanel-limits-"));
    try {
      let hang = false;
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: () => true,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
        limits: {
          maxCallsPerWindow: 3,
          rateWindowMs: 60_000,
          // Generous enough that only the deliberately-parked call can trip it.
          // A tight budget (20ms) raced real disk I/O: reading the oversized
          // fixture sometimes took longer, so the size assertion below saw
          // "timed out" instead — flaky for reasons unrelated to the limits.
          callTimeoutMs: 250,
          maxResultBytes: 64,
        },
      });
      // Stub the handler entirely: return an oversized payload instantly, or park
      // forever. No filesystem timing in the assertions.
      (bridge as any).workspaceReadText = async () =>
        hang ? new Promise<never>(() => undefined) : { path: "big.txt", text: "x".repeat(4096) };

      bridge.registerIpc();
      const guest = fakeGuest(13);
      bridge.registerGuest(
        guest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["workspace.read"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(13, { cwd: workspaceRoot, projectPath: workspaceRoot });
      const call = (path: string) =>
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: guest },
          "workspace.readText",
          { path },
        ) as Promise<unknown>;

      // 1st call: result exceeds the 64-byte cap.
      await expect(call("big.txt")).rejects.toThrow(/result is too large/);
      // 2nd call: never settles → the timeout wrapper rejects.
      hang = true;
      await expect(call("small.txt")).rejects.toThrow(/timed out/);
      hang = false;
      // 3rd call: size again — proves a timeout did not consume the size check.
      await expect(call("big.txt")).rejects.toThrow(/result is too large/);
      // 4th call: over maxCallsPerWindow=3 → rate limited regardless of outcome.
      await expect(call("small.txt")).rejects.toThrow(/rate limit/);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("agent.submitPrompt accepts immediately instead of awaiting the agent", async () => {
    // Contract: the Host call returns as soon as the worker has been handed the
    // run. Completion arrives over the session stream, NOT this RPC — so a
    // long-running agent must never block or time out the Panel App call.
    let workerParams: Record<string, unknown> | undefined;
    const neverSettles = new Promise<never>(() => undefined);
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () =>
        ({
          requestWorker: async (_method: string, params: Record<string, unknown>) => {
            workerParams = params;
            return neverSettles; // agent still running when the Host call returns
          },
          ingestExternalEvent: () => undefined,
        }) as any,
      limits: { callTimeoutMs: 50 },
    });
    bridge.registerIpc();
    const guest = fakeGuest(23);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "agent.submitPrompt"]) as any,
      "/repo",
    );
    await bindBridgeGuest(23);

    const accepted = (await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
      { sender: guest },
      "agent.submitPrompt",
      { prompt: "do the thing" },
    )) as { accepted: boolean; clientMessageId: string };

    expect(accepted.accepted).toBe(true);
    // A stable, panel-scoped id is what makes the submission idempotent upstream.
    expect(accepted.clientMessageId).toStartWith("panel:");
    expect(workerParams?.task).toBe("do the thing");
  });

  test("agent.submitPrompt reports a background worker failure into the session", async () => {
    // Because the Host call already returned, a later worker failure has only one
    // way to reach the user: an error event injected into the owning session.
    const ingested: Array<{ sessionId: string; event: unknown }> = [];
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
      getAgentBridge: () =>
        ({
          requestWorker: async () => ({ ok: false, message: "worker exited" }),
          ingestExternalEvent: (sessionId: string, event: unknown) =>
            ingested.push({ sessionId, event }),
        }) as any,
    });
    bridge.registerIpc();
    const guest = fakeGuest(24);
    bridge.registerGuest(
      guest as any,
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["context.session", "agent.submitPrompt"]) as any,
      "/repo",
    );
    await bindBridgeGuest(24);

    const accepted = (await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
      { sender: guest },
      "agent.submitPrompt",
      { prompt: "will fail" },
    )) as { accepted: boolean };
    // Accepted even though the run fails — the failure is asynchronous.
    expect(accepted.accepted).toBe(true);

    // Let the fire-and-forget continuation run.
    await new Promise((r) => setTimeout(r, 10));
    expect(ingested).toHaveLength(1);
    expect((ingested[0]!.event as { type: string }).type).toBe("error");
    expect((ingested[0]!.event as { error: string }).error).toContain("worker exited");
  });

  test("returns read-only workspace metadata with a best-effort git branch", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cspanel-workspace-"));
    mkdirSync(join(workspaceRoot, ".git"), { recursive: true });
    writeFileSync(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/feature/x\n");
    try {
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: (cwd) => cwd === workspaceRoot,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
      });
      bridge.registerIpc();
      const guest = fakeGuest(14);
      bridge.registerGuest(
        guest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["workspace.info"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(14, {
        projectPath: workspaceRoot,
        cwd: workspaceRoot,
      });
      const info = await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
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
      writeFileSync(join(workspaceRoot, ".git", "HEAD"), "ref: refs/heads/unsafe\tbranch\n");
      expect(
        await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: guest },
          "workspace.info",
          {},
        ),
      ).toMatchObject({ gitBranch: null });
      writeFileSync(join(workspaceRoot, ".git", "HEAD"), "x".repeat(4 * 1024 + 1));
      expect(
        await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: guest },
          "workspace.info",
          {},
        ),
      ).toMatchObject({ gitBranch: null });
      if (process.platform !== "win32") {
        rmSync(join(workspaceRoot, ".git"), { recursive: true, force: true });
        mkdirSync(join(workspaceRoot, "git-metadata"));
        writeFileSync(
          join(workspaceRoot, "git-metadata", "HEAD"),
          "ref: refs/heads/should-not-leak\n",
        );
        symlinkSync("git-metadata", join(workspaceRoot, ".git"));
        expect(
          await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
            { sender: guest },
            "workspace.info",
            {},
          ),
        ).toMatchObject({ gitBranch: null });
      }
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("reads, lists, and atomically writes allowlisted files in a trusted workspace", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cspanel-files-"));
    try {
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: (cwd) => cwd === workspaceRoot,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
      });
      bridge.registerIpc();
      const guest = fakeGuest(18);
      bridge.registerGuest(
        guest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["context.workspace", "workspace.read", "workspace.write"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(18, {
        projectPath: workspaceRoot,
        cwd: workspaceRoot,
      });
      const call = (method: string, params: unknown) =>
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: guest },
          method,
          params,
        ) as Promise<any>;

      const created = await call("workspace.writeText", {
        path: "designs/home.codesign.json",
        content: '{"version":1}\n',
        expectedModifiedAt: null,
      });
      expect(created.path).toBe("designs/home.codesign.json");
      expect(created.revision).toMatch(/^sha256:[0-9a-f]{64}$/);
      if (process.platform !== "win32") {
        for (const name of ["unsafe:name.json", "unsafe\\name.json", "unsafe\nname.json"]) {
          writeFileSync(join(workspaceRoot, "designs", name), "{}\n");
        }
      }
      const listing = await call("workspace.list", { path: "designs" });
      expect(listing.entries).toEqual([
        expect.objectContaining({
          name: "home.codesign.json",
          kind: "file",
        }),
      ]);
      if (process.platform !== "win32") {
        const safeNames = listing.entries.map((entry: { name: string }) => entry.name);
        expect(safeNames).not.toContain("unsafe:name.json");
        expect(safeNames).not.toContain("unsafe\\name.json");
        expect(safeNames).not.toContain("unsafe\nname.json");
      }
      const opened = await call("workspace.readText", {
        path: "designs/home.codesign.json",
      });
      expect(opened.content).toBe('{"version":1}\n');
      expect(opened.revision).toBe(created.revision);
      await expect(
        call("workspace.writeText", {
          path: "designs/home.codesign.json",
          content: '{"version":"blind"}\n',
        }),
      ).rejects.toThrow(/prevent blind overwrites/);

      const largeContent = "x".repeat(70 * 1024);
      await call("workspace.writeText", {
        path: "designs/large.json",
        content: largeContent,
        expectedModifiedAt: null,
      });
      expect((await call("workspace.readText", { path: "designs/large.json" })).content).toBe(
        largeContent,
      );

      const heavilyEscapedContent = '"'.repeat(300 * 1024);
      await call("workspace.writeText", {
        path: "designs/escaped.json",
        content: heavilyEscapedContent,
        expectedModifiedAt: null,
      });
      expect((await call("workspace.readText", { path: "designs/escaped.json" })).content).toBe(
        heavilyEscapedContent,
      );

      for (let index = 0; index < 205; index += 1) {
        writeFileSync(
          join(workspaceRoot, "designs", `ignored-${index.toString().padStart(3, "0")}.png`),
          "",
        );
      }
      writeFileSync(join(workspaceRoot, "designs", "z-visible.json"), "{}\n");
      expect(
        (await call("workspace.list", { path: "designs" })).entries.some(
          (entry: { name: string }) => entry.name === "z-visible.json",
        ),
      ).toBe(true);

      mkdirSync(join(workspaceRoot, "many"));
      for (let index = 0; index < 205; index += 1) {
        writeFileSync(join(workspaceRoot, "many", `${index.toString().padStart(3, "0")}.txt`), "");
      }
      const boundedListing = await call("workspace.list", { path: "many" });
      expect(boundedListing.entries).toHaveLength(200);
      expect(boundedListing.truncated).toBe(true);

      if (process.platform !== "win32") {
        const escapedDirectory = '"'.repeat(240);
        mkdirSync(join(workspaceRoot, escapedDirectory));
        for (let index = 0; index < 200; index += 1) {
          const escapedName = `${'"'.repeat(240)}${index.toString().padStart(3, "0")}.txt`;
          writeFileSync(join(workspaceRoot, escapedDirectory, escapedName), "");
        }
        const escapedListing = await call("workspace.list", { path: escapedDirectory });
        expect(escapedListing.entries).toHaveLength(200);
        expect(JSON.stringify(escapedListing).length).toBeGreaterThan(256 * 1024);
      }

      chmodSync(join(workspaceRoot, "designs", "home.codesign.json"), 0o600);
      await call("workspace.writeText", {
        path: "designs/home.codesign.json",
        content: '{"version":2}\n',
        expectedRevision: created.revision,
      });
      if (process.platform !== "win32") {
        expect(statSync(join(workspaceRoot, "designs", "home.codesign.json")).mode & 0o777).toBe(
          0o600,
        );
      }
      await expect(
        call("workspace.writeText", {
          path: "designs/home.codesign.json",
          content: '{"version":3}\n',
          expectedRevision: created.revision,
        }),
      ).rejects.toThrow(/changed since it was opened/);
      await expect(
        call("workspace.writeText", {
          path: "designs/home.codesign.json",
          content: '{"version":3}\n',
          expectedRevision: "not-a-revision",
        }),
      ).rejects.toThrow(/sha256 revision/);

      await Promise.all(
        Array.from({ length: 12 }, (_, index) =>
          call("workspace.writeText", {
            path: `reports/concurrent/result-${index}.json`,
            content: `${index}\n`,
            expectedModifiedAt: null,
          }),
        ),
      );
      expect((await call("workspace.list", { path: "reports/concurrent" })).entries).toHaveLength(
        12,
      );

      const competingCreates = await Promise.allSettled([
        call("workspace.writeText", {
          path: "reports/concurrent/same-target.json",
          content: "left\n",
          expectedModifiedAt: null,
        }),
        call("workspace.writeText", {
          path: "reports/concurrent/same-target.json",
          content: "right\n",
          expectedModifiedAt: null,
        }),
      ]);
      expect(competingCreates.filter((result) => result.status === "fulfilled")).toHaveLength(1);
      expect(competingCreates.filter((result) => result.status === "rejected")).toHaveLength(1);
      expect(
        ["left\n", "right\n"].includes(
          (
            await call("workspace.readText", {
              path: "reports/concurrent/same-target.json",
            })
          ).content,
        ),
      ).toBe(true);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("keeps workspace read and write permissions independent", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cspanel-file-permissions-"));
    writeFileSync(join(workspaceRoot, "readable.json"), "{}\n");
    try {
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: (cwd) => cwd === workspaceRoot,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
      });
      bridge.registerIpc();
      const readGuest = fakeGuest(21);
      bridge.registerGuest(
        readGuest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["context.workspace", "workspace.read"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(21, {
        projectPath: workspaceRoot,
        cwd: workspaceRoot,
      });
      expect(
        await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: readGuest },
          "workspace.readText",
          { path: "readable.json" },
        ),
      ).toMatchObject({ content: "{}\n" });
      await expect(
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: readGuest },
          "workspace.writeText",
          { path: "denied.json", content: "{}\n" },
        ),
      ).rejects.toThrow(/workspace.write/);

      const writeGuest = fakeGuest(22);
      bridge.registerGuest(
        writeGuest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["context.workspace", "workspace.write"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(22, {
        projectPath: workspaceRoot,
        cwd: workspaceRoot,
      });
      await expect(
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: writeGuest },
          "workspace.readText",
          { path: "readable.json" },
        ),
      ).rejects.toThrow(/workspace.read/);
      expect(
        await panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: writeGuest },
          "workspace.writeText",
          { path: "writable.json", content: "{}\n", expectedModifiedAt: null },
        ),
      ).toMatchObject({ path: "writable.json" });
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
    }
  });

  test("rejects traversing, hidden, binary, symlink, and untrusted workspace paths", async () => {
    const workspaceRoot = mkdtempSync(join(tmpdir(), "cspanel-files-safe-"));
    const outside = join(workspaceRoot, "..", `cspanel-outside-${process.pid}.json`);
    writeFileSync(outside, '{"secret":true}');
    writeFileSync(join(workspaceRoot, "invalid.json"), Buffer.from([0xff, 0xfe]));
    symlinkSync(outside, join(workspaceRoot, "linked.json"));
    mkdirSync(join(workspaceRoot, ".private"));
    writeFileSync(join(workspaceRoot, ".private", "secret.txt"), "inside secret");
    symlinkSync(join(workspaceRoot, ".private", "secret.txt"), join(workspaceRoot, "alias.txt"));
    mkdirSync(join(workspaceRoot, "visible-directory"));
    writeFileSync(join(workspaceRoot, "visible-directory", "safe.txt"), "safe");
    symlinkSync(join(workspaceRoot, "visible-directory"), join(workspaceRoot, "alias-directory"));
    try {
      const bridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: (cwd) => cwd === workspaceRoot,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
      });
      bridge.registerIpc();
      const guest = fakeGuest(19);
      bridge.registerGuest(
        guest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["context.workspace", "workspace.read", "workspace.write"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(19, {
        projectPath: workspaceRoot,
        cwd: workspaceRoot,
      });
      const call = (method: string, params: unknown) =>
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: guest },
          method,
          params,
        ) as Promise<unknown>;

      await expect(call("workspace.readText", { path: "../secret.json" })).rejects.toThrow(
        /safe relative/,
      );
      await expect(call("workspace.readText", { path: "C:/secret.json" })).rejects.toThrow(
        /safe relative/,
      );
      await expect(call("workspace.readText", { path: "C:secret.json" })).rejects.toThrow(
        /safe relative/,
      );
      await expect(call("workspace.readText", { path: "CON.txt" })).rejects.toThrow(
        /safe relative/,
      );
      await expect(call("workspace.readText", { path: "designs/AUX.data.json" })).rejects.toThrow(
        /safe relative/,
      );
      await expect(
        call("workspace.readText", { path: "designs/trailing./file.json" }),
      ).rejects.toThrow(/safe relative/);
      await expect(
        call("workspace.readText", { path: "designs/trailing /file.json" }),
      ).rejects.toThrow(/safe relative/);
      await expect(call("workspace.readText", { path: ".env" })).rejects.toThrow(/safe relative/);
      await expect(
        call("workspace.readText", { path: "NODE_MODULES/secret.json" }),
      ).rejects.toThrow(/safe relative/);
      await expect(call("workspace.readText", { path: "line\nbreak.json" })).rejects.toThrow(
        /safe relative/,
      );
      await expect(call("workspace.readText", { path: "image.png" })).rejects.toThrow(/file type/);
      await expect(call("workspace.readText", { path: "invalid.json" })).rejects.toThrow(/UTF-8/);
      await expect(call("workspace.readText", { path: "linked.json" })).rejects.toThrow(
        /symbolic link/,
      );
      await expect(call("workspace.readText", { path: "alias.txt" })).rejects.toThrow(
        /symbolic link/,
      );
      await expect(call("workspace.list", { path: "alias-directory" })).rejects.toThrow(
        /symbolic link/,
      );
      await expect(
        call("workspace.writeText", {
          path: "linked.json",
          content: "{}\n",
          expectedModifiedAt: null,
        }),
      ).rejects.toThrow(/regular file/);

      const untrustedBridge = new PanelAppBridge({
        isTrustedHost: () => true,
        isWorkspaceTrusted: () => false,
        isPanelAppBound: () => true,
        getAgentBridge: () => null,
      });
      untrustedBridge.registerIpc();
      const untrustedGuest = fakeGuest(20);
      untrustedBridge.registerGuest(
        untrustedGuest as any,
        panelAppElectronMock.ownerWindow as any,
        bridgeResource(["context.workspace", "workspace.read"]) as any,
        workspaceRoot,
      );
      await bindBridgeGuest(20, {
        projectPath: workspaceRoot,
        cwd: workspaceRoot,
      });
      await expect(
        panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
          { sender: untrustedGuest },
          "workspace.readText",
          { path: "safe.json" },
        ),
      ).rejects.toThrow(/trusted workspace/);
    } finally {
      rmSync(workspaceRoot, { recursive: true, force: true });
      rmSync(outside, { force: true });
    }
  });

  test("sends title-prefixed system notifications under a dedicated per-window cap", async () => {
    const shown: { title: string; body: string }[] = [];
    const bridge = new PanelAppBridge({
      isTrustedHost: () => true,
      isWorkspaceTrusted: () => false,
      isPanelAppBound: () => true,
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
      panelAppElectronMock.ownerWindow as any,
      bridgeResource(["notifications.send"]) as any,
      "/repo",
    );
    await bindBridgeGuest(15);
    const call = (params: unknown) =>
      panelAppElectronMock.ipcHandlers.get("panel-app:call")!(
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
