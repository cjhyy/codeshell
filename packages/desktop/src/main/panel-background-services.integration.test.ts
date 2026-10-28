import { expect, test } from "bun:test";
import { readFile, mkdtemp, realpath, mkdir, writeFile, rm, copyFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { createDesktopManagedRuntimeProvider } from "./managed-runtime-service.js";
import { PanelAppInspectionCache } from "./panel-app-inspection-cache.js";
import { PanelBackgroundService } from "../../../server/src/panels/background-services.js";
import {
  PanelExecutionGate,
  panelExecutionProject,
} from "../../../server/src/panels/execution-gate.js";
import { resolvePanelExecutable } from "../../../server/src/panels/process-service.js";
import { PanelBridgeError } from "../../../server/src/panels/bridge-contract.js";

// Execute production Desktop boundary methods with explicit Electron/trust adapters;
// the service, reviewed native entry, guardian, filesystem and lifecycle are real.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = [
  "getBackgroundService",
  "dispatchBackgroundServices",
  "initializeMedia",
  "shutdownMedia",
  "revokeGuest",
  "closeForPackageChange",
  "requirePermission",
].map((name) =>
  declaration.members
    .find((node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name)!
    .getText(parsed),
);
const compiled = ts.transpileModule(`class Bridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;

test("Desktop authorization/dispatch/events survive closing all guests and selected-revision upgrade", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-background-service-")));
  const pkg = join(root, "package");
  await mkdir(join(pkg, "app/tools"), { recursive: true });
  const native = `import{createInterface}from'node:readline';let n=0;createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.t==='drain')process.exit(0);if(x.t==='hello'||x.t==='poke'){console.log(JSON.stringify({t:'ready'}));console.log(JSON.stringify({t:'publish',channel:'quotes',value:{n:++n}}))}}).on('close',()=>process.exit(0));`;
  await writeFile(join(pkg, "app/tools/feed.mjs"), native);
  const permissions = ["background.services", "process", "context.workspace"];
  const installed: any = {
    id: "fixture",
    revision: "r1",
    permissions,
    installPath: pkg,
    nativeEntries: {
      feed: {
        entry: "app/tools/feed.mjs",
        sha256: createHash("sha256").update(native).digest("hex"),
      },
    },
    backgroundServices: {
      feed: {
        entry: "feed",
        channels: { quotes: { maxBytes: 262144 } },
        maxLifetimeMs: 60_000,
        idleGraceMs: 0,
      },
    },
  };
  // A system/user Node may be older or an unsupported major even when PATH has
  // a patched Node first. Services must use the verified app-owned provider.
  const runtimeRoot = join(root, "resources", "runtimes", "node");
  await mkdir(join(runtimeRoot, "bin"), { recursive: true });
  const safeNode = (await resolvePanelExecutable("node"))!;
  const managedNode = join(runtimeRoot, "bin", "node");
  await copyFile(safeNode, managedNode);
  await writeFile(
    join(runtimeRoot, "manifest.json"),
    JSON.stringify({
      schemaVersion: 1,
      id: "node",
      version: "fixture-safe-node",
      platform: process.platform,
      arch: process.arch,
      executable: "bin/node",
      sha256: createHash("sha256")
        .update(await readFile(managedNode))
        .digest("hex"),
      source: { url: "https://nodejs.org/dist/fixture.tar.gz", archiveSha256: "a".repeat(64) },
    }),
  );
  await mkdir(join(root, "bin"));
  await writeFile(join(root, "bin", "node"), "#!/bin/sh\necho v25.8.1\n", { mode: 0o755 });
  const provider = createDesktopManagedRuntimeProvider({
    isPackaged: true,
    resourcesPath: join(root, "resources"),
    appPath: root,
  });
  const resolutions: string[] = [];
  const gate = new PanelExecutionGate();
  // Desktop's shared singleton gate is supplied as an explicit boundary adapter.
  class ScopedService extends PanelBackgroundService {
    constructor(options: any) {
      super({ ...options, gate });
    }
  }
  const Bridge = runInNewContext(`${compiled}; Bridge`, {
    PanelBackgroundService: ScopedService,
    PanelBridgeError,
    app: { getPath: () => root },
    join,
    createHash,
    panelExecutionProject,
    panelExecutionGate: gate,
    installedPanelAppRevision: (value: any) => value.revision,

    process,
    Promise,
    Set,
    Map,
    revokePanelAppMediaReads() {},
  });
  const bridge = new Bridge();
  let bound = true;
  const noService = { initialize: async () => {}, shutdown: async () => {} };
  Object.assign(bridge, {
    options: {
      isPanelAppBound: () => bound,
      isWorkspaceTrusted: () => true,
      resolveBackgroundServiceNode: async () => {
        const runtime = await provider.resolve("node");
        if (runtime) resolutions.push(runtime.executablePath);
        return runtime?.executablePath ?? null;
      },
    },
    guests: new Map(),
    resourceTransfers: new Map(),
    windowSourceListeners: new Map(),
    pendingAgentToolCalls: new Map(),
    modelTraces: { cancelOwner() {}, closeAll() {} },
    processService: { revokeGuest() {} },
    agentTaskService: { cancelApp() {} },
    getResourceService: () => noService,
    getMediaService: () => noService,
    getToolJobService: () => noService,
    projectToolApps: () => ({ get: async () => installed }),
    managedBinDirectory: () => join(root, "bin"),
    trustedWorkspaceRoot: async () => root,
    revokeWindowSource() {},
  });
  const guest = (id: number) => {
    const sent: any[] = [];
    const binding = {
      guest: {
        id,
        isDestroyed: () => false,
        stop() {},
        send: (_channel: string, event: unknown) => sent.push(event),
      },
      projectPath: root,
      resource: {
        descriptor: {
          appId: "fixture",
          revision: installed.revision,
          permissions,
          backgroundServices: installed.backgroundServices,
        },
      },
    };
    bridge.guests.set(id, binding);
    return { binding, sent };
  };
  try {
    await bridge.initializeMedia();
    const service: any = bridge.getBackgroundService(),
      events: any[] = [],
      waits: Array<{ predicate: (event: any) => boolean; resolve: (event: any) => void }> = [];
    const forward = service.options.onEvent;
    service.options.onEvent = (scope: any, event: any) => {
      forward(scope, event);
      events.push(event);
      for (const waiter of waits.splice(0)) {
        if (waiter.predicate(event)) waiter.resolve(event);
        else waits.push(waiter);
      }
    };
    const next = (predicate: (event: any) => boolean) =>
      events.some(predicate)
        ? Promise.resolve(events.find(predicate))
        : new Promise<any>((resolve) => waits.push({ predicate, resolve }));
    const a = guest(1),
      b = guest(2),
      call = (binding: any, method: string, input: any = {}) =>
        bridge.dispatchBackgroundServices(binding, `services.${method}`, {
          name: "feed",
          ...input,
        });
    await Promise.all([call(a.binding, "attach"), call(b.binding, "attach")]);
    expect(resolutions).toEqual([]);
    await call(a.binding, "setDesired", {
      desired: "always",
      expectedRevision: 0,
      requestKey: "enable",
    });
    await next((event) => event.seq === 1);
    expect(resolutions).toEqual([managedNode]);
    expect(
      a.sent.some((event) => event.event === "services.changed" && event.payload.seq === 1),
    ).toBe(true);
    expect(
      b.sent.some((event) => event.event === "services.changed" && event.payload.seq === 1),
    ).toBe(true);
    bridge.revokeGuest(1);
    bridge.revokeGuest(2);
    expect(bridge.guests.size).toBe(0);
    const scope = { appId: "fixture", projectPath: root, name: "feed" };
    await service.control(scope, { action: "poke", requestKey: "no-guests" });
    await next((event) => event.seq === 2);
    const reopened = guest(3);
    expect(await call(reopened.binding, "read", { channel: "quotes" })).toMatchObject({
      generation: 1,
      seq: 2,
    });
    expect(resolutions).toEqual([managedNode]);
    const matches = (scope: any) => scope.appId === "fixture";
    await gate.mutate(
      matches,
      async () => {
        installed.revision = "r2";
      },
      () => bridge.closeForPackageChange("fixture", matches),
    );
    await service.tick();
    expect((await service.get(scope)).revision).toBe("r2");
    expect(resolutions).toEqual([managedNode, managedNode]);
    bound = false;
    await service.tick();
    expect(gate.blockers(matches)).toHaveLength(0);
    const record = [...service.records.values()][0] as any;
    expect(record.desired).toBe("off");
    expect(record.phase).toBe("revoked");
    await expect(
      call({ ...reopened.binding, resource: { descriptor: { permissions: [] } } }, "get"),
    ).rejects.toThrow("permission denied");
  } finally {
    await bridge.shutdownMedia();
    await rm(root, { recursive: true, force: true });
  }
});

test("C1 failed background initialization cannot prevent real Desktop task/media/cookie restore", async () => {
  const Bridge = runInNewContext(`${compiled}; Bridge`, { process, console: { warn() {} } });
  const bridge = new Bridge(),
    restored: string[] = [];
  const component = (name: string) => ({
    initialize: async () => {
      restored.push(name);
    },
  });
  Object.assign(bridge, {
    options: { cookieCredentials: { taskCredentials: true } },
    getResourceService: () => component("resources"),
    getToolJobService: () => component("tasks"),
    getMediaService: () => component("media"),
    getTaskCookieHost: () => component("cookies"),
    getBackgroundService: () => ({
      initialize: async () => {
        throw new Error("SERVICE_COORDINATOR_BUSY");
      },
    }),
  });
  await bridge.initializeMedia();
  expect(restored).toEqual(["resources", "tasks", "media", "cookies"]);
  expect(bridge.backgroundInitializationError).toContain("SERVICE_COORDINATOR_BUSY");
});

test("H-I3 actual Desktop describe and inspection cache distinguish IO absence from permission revocation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "desktop-service-inspection-")));
  try {
    const pkg = join(root, "package"),
      registry = join(root, "registry.json");
    await mkdir(pkg);
    await writeFile(join(pkg, "entry.mjs"), "");
    await writeFile(registry, "[]");
    let unavailable = true;
    const installed: any = {
      id: "fixture",
      installPath: pkg,
      permissions: ["process", "background.services", "context.workspace"],
      backgroundServices: {
        feed: {
          entry: "feed",
          channels: { quotes: { maxBytes: 1024 } },
          maxLifetimeMs: 60000,
          idleGraceMs: 0,
        },
      },
      nativeEntries: { feed: { entry: "entry.mjs", sha256: "a".repeat(64) } },
    };
    const cache = new PanelAppInspectionCache({
      prepare: async () => {
        if (unavailable) throw new Error("temporary registry I/O");
      },
      installPath: () => pkg,
      registryPath: () => registry,
      listInstalled: async () => [installed],
    });
    let captured: any;
    const Bridge = runInNewContext(`${compiled}; Bridge`, {
      PanelBackgroundService: class {
        constructor(options: any) {
          captured = options;
        }
      },
      PanelBridgeError,
      app: { getPath: () => root },
      join,
      createHash,
      panelExecutionProject,
      installedPanelAppRevision: () => "r1",
    });
    const bridge = new Bridge();
    Object.assign(bridge, {
      options: { isPanelAppBound: () => true, isWorkspaceTrusted: () => true },
      projectToolApps: () => cache,
      managedBinDirectory: () => root,
    });
    bridge.getBackgroundService();
    const scope = { appId: "fixture", projectPath: root, name: "feed" };
    await expect(captured.describe(scope)).rejects.toThrow(
      "SERVICE_PACKAGE_INSPECTION_UNAVAILABLE",
    );
    unavailable = false;
    const description = await captured.describe(scope);
    expect(description.revision).toBe("r1");
    // Discovery remains available; execution cannot silently use PATH if Main
    // cannot supply the hash-verified application runtime.
    await expect(description.executable()).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
    installed.permissions = [];
    await expect(captured.describe(scope)).rejects.toMatchObject({ code: "REVOKED" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
