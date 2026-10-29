import { expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, realpath, rm } from "node:fs/promises";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { resolvePanelAppBindingProjectPath, SettingsManager } from "@cjhyy/code-shell-core";
import { PanelBackgroundService } from "../../../server/src/panels/background-services.js";
import { BackgroundServiceStore } from "../../../server/src/panels/background-service-store.js";
import {
  PanelExecutionGate,
  panelExecutionProject,
} from "../../../server/src/panels/execution-gate.js";
import { PanelBridgeError } from "../../../server/src/panels/bridge-contract.js";
import { desktopPanelCapabilities } from "./panel-app-capabilities.js";
import { isPanelAppDescriptorSelected } from "./panel-app-project-packages.js";
import { PANEL_APP_API_VERSION } from "../shared/panel-apps.js";

// Run production Bridge methods without Electron's process-global module mocks.
// The coordinator, ownership lock, durable records and project package-pin checks
// are real. OS identity, Electron windows, package inspection and trust use adapters.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = [
  "getBackgroundService",
  "refreshBackgroundServiceContexts",
  "capabilitiesFor",
  "initializeMedia",
  "shutdownMedia",
  "bindGuest",
  "bindingFor",
  "contextFor",
  "dispatch",
  "dispatchBackgroundServices",
  "assertProjectBinding",
  "assertLiveProjectBinding",
  "requirePermission",
].map((name) => {
  const method = declaration.members.find(
    (node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name,
  );
  if (!method) throw new Error(`Missing production Bridge method: ${name}`);
  return method.getText(parsed);
});
const compiled = ts.transpileModule(`class Bridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

function barrier() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function fixture() {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-service-availability-")));
  const entered = barrier(),
    release = barrier();
  let fault = false,
    now = 0;
  const identity = {
    pid: process.pid,
    start: "fixture-start",
    boot: "fixture-boot",
    machine: "fixture-machine",
    host: hostname(),
  };
  const identities = { current: () => identity, status: () => "alive" as const };
  const gate = new PanelExecutionGate();
  class ScopedService extends PanelBackgroundService {
    constructor(options: any) {
      super({
        ...options,
        gate,
        identities,
        now: () => now,
        fault: (point) => {
          if (fault && point === "directory-fsync") throw new Error("N1_TEST_STORE_POISON");
        },
        spawn: async () => {
          throw new Error("This off-service capability fixture must never start native work");
        },
      });
    }
  }
  const selected = new Map<string, string>(),
    bound = new Set<string>();
  const owner = { id: 10, isDestroyed: () => false },
    sender = { id: 11 };
  const Bridge = runInNewContext(`${compiled}; Bridge`, {
    PanelBackgroundService: ScopedService,
    PanelBridgeError,
    desktopPanelCapabilities,
    resolvePanelAppBindingProjectPath,
    panelExecutionProject,
    installedPanelAppRevision: (value: any) => value.revision,
    isPanelAppDescriptorSelected,
    BrowserWindow: { fromWebContents: (value: unknown) => (value === sender ? owner : null) },
    app: { getPath: () => root },
    join,
    createHash,
    isDeepStrictEqual,
    PANEL_APP_API_VERSION,
    toolJobLimits: {},
    process,
    AbortController,
    revokePanelAppMediaReads() {},
    console: { warn() {} },
  });
  const bridge = new Bridge();
  const permissions = ["background.services", "process", "context.workspace", "context.session"];
  const installed = (projectPath: string) => ({
    revision: selected.get(projectPath),
    installPath: root,
    permissions,
    nativeEntries: { feed: { entry: "feed.mjs", sha256: "a".repeat(64) } },
    backgroundServices: {
      feed: {
        entry: "feed",
        channels: { quotes: { maxBytes: 1024 } },
        maxLifetimeMs: 60_000,
        idleGraceMs: 0,
      },
    },
  });
  const component = { initialize: async () => {}, shutdown: async () => {} };
  Object.assign(bridge, {
    options: {
      isPanelAppBound: (projectPath: string) => bound.has(projectPath),
      isWorkspaceTrusted: (path: string) => bound.has(path),
    },
    guests: new Map(),
    windowSourceListeners: new Map(),
    resourceTransfers: new Map(),
    modelTraces: { cancelOwner() {}, closeAll() {} },
    getResourceService: () => ({
      ...component,
      initialize: async () => {
        entered.resolve();
        await release.promise;
      },
      capabilities: () => ({}),
    }),
    getToolJobService: () => component,
    getMediaService: () => component,
    projectToolApps: (projectPath: string) => ({ get: async () => installed(projectPath) }),
    trustedWorkspaceRoot: async (binding: any) => binding.projectPath,
    assertTrustedHost(value: unknown) {
      if (value !== sender) throw new Error("Unknown Host sender");
    },
    revokeWindowSource() {},
  });
  const service: PanelBackgroundService = bridge.getBackgroundService();
  const pin = (projectPath: string, version: string, packageDigest: string) => {
    new SettingsManager(projectPath, "full").mutateSettingsForScope(
      "project",
      projectPath,
      (settings) => {
        settings.panelAppBindings = ["fixture"];
        settings.panelAppPins = {
          fixture: { version, packageDigest, pinnedAt: "2026-10-29T00:00:00.000Z" },
        };
      },
    );
  };
  const guest = async (id: number, projectName: string) => {
    const projectPath = join(root, projectName);
    await mkdir(projectPath, { recursive: true });
    selected.set(projectPath, "r1");
    pin(projectPath, "1.0.0", "a".repeat(64));
    bound.add(projectPath);
    const sent: any[] = [];
    let destroyed = false;
    const binding: any = {
      guest: {
        id,
        isDestroyed: () => destroyed,
        send: (_channel: string, event: unknown) => sent.push(event),
      },
      ownerWindowId: owner.id,
      projectPath,
      context: { appId: "fixture" },
      resource: {
        descriptor: {
          appId: "fixture",
          id: `descriptor-${id}`,
          revision: "r1",
          packagePinned: true,
          version: "1.0.0",
          packageDigest: "a".repeat(64),
          permissions,
          backgroundServices: installed(projectPath).backgroundServices,
        },
      },
    };
    bridge.guests.set(id, binding);
    expect(
      await bridge.bindGuest(sender, {
        guestId: id,
        appDescriptorId: binding.resource.descriptor.id,
        tabId: `tab-${id}`,
        bucket: `bucket-${id}`,
        projectPath,
        cwd: projectPath,
        sessionId: `session-${id}`,
        visible: true,
      }),
    ).toBe(true);
    return {
      binding,
      sent,
      projectPath,
      destroy: () => {
        destroyed = true;
      },
      contexts: () =>
        sent.filter((event) => event.event === "context.changed").map((e) => e.payload),
    };
  };
  return {
    root,
    bridge,
    service,
    guest,
    selected,
    pin,
    bound,
    identities,
    entered,
    release,
    poison: (value: boolean) => {
      fault = value;
    },
    clock: (value: number) => {
      now = value;
    },
    close: async () => {
      release.resolve();
      await bridge.shutdownMedia();
      await rm(root, { recursive: true, force: true });
    },
  };
}

function available(context: any): boolean {
  return context.availableMethods.includes("services.attach");
}

test("N1 real bind before initialization receives availability, with live context reads and scope isolation", async () => {
  const f = await fixture();
  try {
    const a = await f.guest(1, "project-a"),
      b = await f.guest(2, "project-b"),
      removed = await f.guest(3, "project-removed"),
      revoked = await f.guest(4, "project-revoked"),
      oldRevision = await f.guest(5, "project-updated"),
      destroyed = await f.guest(6, "project-destroyed");
    const cached = a.binding.context;
    expect(available(cached)).toBe(false);
    const initializing = f.bridge.initializeMedia();
    await f.entered.promise;
    expect(f.service.isAvailable()).toBe(false);
    f.bridge.guests.delete(removed.binding.guest.id);
    f.bound.delete(revoked.projectPath);
    f.selected.set(oldRevision.projectPath, "r2");
    f.pin(oldRevision.projectPath, "2.0.0", "b".repeat(64));
    expect(
      isPanelAppDescriptorSelected(
        oldRevision.binding.resource.descriptor,
        oldRevision.projectPath,
      ),
    ).toBe(false);
    expect(isPanelAppDescriptorSelected(a.binding.resource.descriptor, a.projectPath)).toBe(true);
    destroyed.destroy();
    f.release.resolve();
    await initializing;
    expect(f.service.isAvailable()).toBe(true);
    for (const current of [a, b]) {
      expect(current.contexts().map(available)).toEqual([false, true]);
      expect(current.contexts().at(-1)).toMatchObject({
        cwd: current.projectPath,
        sessionId: `session-${current.binding.guest.id}`,
      });
    }
    for (const stale of [removed, revoked, oldRevision, destroyed])
      expect(stale.contexts().map(available)).toEqual([false]);
    // A missed push cannot leave context.get on the cached capability snapshot.
    a.binding.context = cached;
    expect(available(await f.bridge.dispatch(a.binding, "context.get", {}))).toBe(true);
    expect(available(await f.bridge.contextFor(a.binding.guest))).toBe(true);
    expect(a.binding.context).toBe(cached);
    f.bridge.refreshBackgroundServiceContexts();
    const delivered = a.contexts().length;
    await f.service.tick();
    f.bridge.refreshBackgroundServiceContexts();
    expect(a.contexts()).toHaveLength(delivered);
    expect((f.service as any).availabilityListeners.size).toBe(1);
    await f.bridge.shutdownMedia();
    expect(a.contexts().at(-1).availableMethods).not.toContain("services.attach");
    expect(b.contexts().map(available)).toEqual([false, true, false]);
    expect((f.service as any).availabilityListeners.size).toBe(0);
    expect(f.bridge.unsubscribeBackgroundAvailability).toBeUndefined();
    for (const stale of [removed, revoked, oldRevision, destroyed])
      expect(stale.contexts().map(available)).toEqual([false]);
  } finally {
    await f.close();
  }
});

test("N1 real store poison/recovery updates bound contexts and never announces partial recovery", async () => {
  const f = await fixture();
  try {
    const a = await f.guest(1, "project-a"),
      b = await f.guest(2, "project-b");
    f.release.resolve();
    await f.bridge.initializeMedia();
    f.poison(true);
    await expect(
      f.bridge.dispatch(a.binding, "services.configure", {
        name: "feed",
        config: { fixture: "a" },
        expectedConfigRevision: 0,
        requestKey: "poison",
      }),
    ).rejects.toThrow("N1_TEST_STORE_POISON");
    for (const current of [a, b])
      expect(current.contexts().map(available)).toEqual([false, true, false]);
    await f.service.tick();
    expect(f.service.isAvailable()).toBe(false);
    expect(a.contexts().map(available)).toEqual([false, true, false]);
    f.poison(false);
    f.clock(5000);
    await f.service.tick();
    expect(f.service.isAvailable()).toBe(true);
    for (const current of [a, b]) {
      expect(current.contexts().map(available)).toEqual([false, true, false, true]);
      expect(current.contexts().at(-1).cwd).toBe(current.projectPath);
    }
  } finally {
    await f.close();
  }
});

test("N1 real coordinator lock retry refreshes guests and clears a past initialization error", async () => {
  const f = await fixture();
  const blocker = new BackgroundServiceStore(
    join(f.root, "panel-background-services"),
    undefined,
    f.identities,
  );
  blocker.acquire();
  try {
    const a = await f.guest(1, "project-a");
    f.release.resolve();
    await f.bridge.initializeMedia();
    expect(f.bridge.backgroundInitializationError).toContain("SERVICE_COORDINATOR_BUSY");
    expect(a.contexts().map(available)).toEqual([false]);
    blocker.release();
    f.clock(5000);
    await f.service.tick();
    expect(f.bridge.backgroundInitializationError).toBeUndefined();
    expect(a.contexts().map(available)).toEqual([false, true]);
  } finally {
    blocker.release();
    await f.close();
  }
});
