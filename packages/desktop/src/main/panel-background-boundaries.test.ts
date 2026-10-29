import { expect, test } from "bun:test";
import { readFile, mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import ts from "typescript";
import { PanelTaskCookieHost } from "../../../server/src/panels/task-cookie-host.js";
import { PanelBridgeError } from "../../../server/src/panels/bridge-contract.js";
import {
  backgroundServiceLimits,
  PanelBackgroundService,
} from "../../../server/src/panels/background-services.js";
import { PanelExecutionGate } from "../../../server/src/panels/execution-gate.js";
import { desktopPanelCapabilities } from "./panel-app-capabilities.js";

// Exercise the production Electron boundary without importing its global Electron
// mocks. Cookie persistence and the execution gate are real; only UI adapters and
// the coordinator availability state are supplied explicitly.
const source = await readFile(new URL("./panel-app-bridge.ts", import.meta.url), "utf8");
const parsed = ts.createSourceFile("bridge.ts", source, ts.ScriptTarget.Latest, true);
const declaration = parsed.statements.find(
  (node): node is ts.ClassDeclaration =>
    ts.isClassDeclaration(node) && node.name?.text === "PanelAppBridge",
)!;
const methods = [
  "initializeMedia",
  "dispatchBackgroundServices",
  "capabilitiesFor",
  "contextFor",
  "call",
  "requirePermission",
].map((name) =>
  declaration.members
    .find((node) => ts.isMethodDeclaration(node) && node.name.getText(parsed) === name)!
    .getText(parsed),
);
const compiled = ts.transpileModule(`class Bridge { ${methods.join("\n")} }`, {
  compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS },
}).outputText;
const permissions = ["background.services", "process", "context.workspace"];
const descriptor = {
  appId: "fixture",
  revision: "r1",
  permissions,
  backgroundServices: { feed: {} },
};
function fixture() {
  const Bridge = runInNewContext(`${compiled}; Bridge`, {
    process,
    console: { warn() {} },
    AggregateError,
    PanelBridgeError,
    backgroundServiceLimits,
    desktopPanelCapabilities,
    toolJobLimits: {},
    installedPanelAppRevision: (app: any) => app.revision,
    panelExecutionGate: new PanelExecutionGate(),
    RESOURCE_TRANSFER_METHODS: new Set(),
    jsonBytes: (value: unknown) => Buffer.byteLength(JSON.stringify(value)),
    MAX_PARAMS_BYTES: 128 * 1024,
    MAX_RESULT_BYTES: 128 * 1024,
    RATE_WINDOW_MS: 1000,
    MAX_CALLS_PER_WINDOW: 100,
    withTimeout: (value: Promise<unknown>) => value,
  });
  const bridge = new Bridge();
  const binding = {
    resource: { descriptor },
    projectPath: "/fixture",
    guest: { id: 1 },
    bucket: "ready",
    context: {},
    callTimes: [],
  };
  let available = false;
  const calls: string[] = [];
  const service = Object.fromEntries(
    ["get", "read", "attach", "detach", "setDesired", "configure", "control"].map((name) => [
      name,
      async () => {
        calls.push(name);
        return { value: name };
      },
    ]),
  );
  Object.assign(service, {
    initialize: async () => {
      available = true;
    },
    isAvailable: () => available,
  });
  const component = { initialize: async () => {}, capabilities: () => ({}) };
  Object.assign(bridge, {
    options: {},
    backgroundService: service,
    getBackgroundService: () => service,
    getResourceService: () => component,
    getToolJobService: () => component,
    getMediaService: () => component,
    projectToolApps: () => ({ get: async () => ({ revision: "r1", permissions }) }),
    trustedWorkspaceRoot: async () => "/fixture",
    assertLiveProjectBinding() {},
    assertProjectBinding() {},
    bindingFor: () => binding,
    waitForBoundGuest: async () => binding,
    dispatch: (bound: any, method: string, params: unknown) =>
      bridge.dispatchBackgroundServices(bound, method, params),
  });
  return {
    bridge,
    binding,
    calls,
    setAvailable: (value: boolean) => {
      available = value;
    },
  };
}

test("I6 real damaged Cookie key preserves its error but does not suppress service initialization", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-cookie-init-"));
  const cookieRoot = join(root, "cookies");
  await mkdir(cookieRoot);
  await writeFile(
    join(cookieRoot, "revision-key.json"),
    JSON.stringify({ version: 1, key: "damaged" }),
  );
  const cookies = new PanelTaskCookieHost({
    rootDirectory: cookieRoot,
    authorize: async () => {},
    credentials: async () => [],
  });
  const { bridge, binding, calls } = fixture();
  bridge.options.cookieCredentials = { taskCredentials: true };
  bridge.getTaskCookieHost = () => cookies;
  try {
    expect(bridge.contextFor(binding.guest).availableMethods).not.toContain("services.attach");
    await expect(bridge.initializeMedia()).rejects.toThrow("Invalid task Cookie Host key");
    expect(bridge.contextFor(binding.guest).availableMethods).toContain("services.attach");
    await bridge.dispatchBackgroundServices(binding, "services.attach", { name: "feed" });
    expect(calls).toEqual(["attach"]);
  } finally {
    await cookies.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});

test("I6 independent failures retain original errors, service retry availability refreshes existing context", async () => {
  const { bridge, binding, setAvailable } = fixture();
  const mediaError = new Error("media restore failed"),
    resourceError = new Error("resource restore failed");
  bridge.getResourceService = () => ({
    initialize: async () => {
      throw resourceError;
    },
    capabilities: () => ({}),
  });
  bridge.getMediaService = () => ({
    initialize: async () => {
      throw mediaError;
    },
  });
  bridge.getBackgroundService = () => ({
    initialize: async () => {
      throw new Error("SERVICE_COORDINATOR_BUSY");
    },
  });
  await expect(bridge.initializeMedia()).rejects.toMatchObject({
    errors: [resourceError, mediaError],
  });
  expect(bridge.backgroundInitializationError).toContain("SERVICE_COORDINATOR_BUSY");
  expect(bridge.contextFor(binding.guest).availableMethods).not.toContain("services.attach");
  await expect(
    bridge.dispatchBackgroundServices(binding, "services.attach", { name: "feed" }),
  ).rejects.toMatchObject({ code: "NOT_SUPPORTED" });
  setAvailable(true); // coordinator retry succeeds without clearing the first error text
  expect(bridge.contextFor(binding.guest).availableMethods).toContain("services.attach");
  setAvailable(false);
  expect(bridge.contextFor(binding.guest).availableMethods).not.toContain("services.attach");
});

test("I6 shutdown during a recovery await cannot initialize later components or advertise services", async () => {
  const { bridge, binding, calls } = fixture();
  let release!: () => void, entered!: () => void;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  bridge.getResourceService = () => ({
    initialize: async () => {
      entered();
      await barrier;
    },
    capabilities: () => ({}),
  });
  bridge.getToolJobService = () => {
    calls.push("tasks");
    return {};
  };
  const initializing = bridge.initializeMedia();
  await started;
  bridge.resourceTransfersStopping = true;
  release();
  await initializing;
  expect(calls).toEqual([]);
  expect(bridge.contextFor(binding.guest).availableMethods).not.toContain("services.attach");
});

test("I7 stale guests may read shared snapshots but cannot attach, detach or mutate the new revision", async () => {
  const { bridge, binding, calls, setAvailable } = fixture();
  setAvailable(true);
  bridge.projectToolApps = () => ({ get: async () => ({ revision: "r2", permissions }) });
  for (const method of ["attach", "detach", "setDesired", "configure", "control"]) {
    await expect(
      bridge.dispatchBackgroundServices(binding, `services.${method}`, {
        name: "feed",
        attachId: "old",
        desired: "always",
      }),
    ).rejects.toMatchObject({ code: "REVOKED" });
  }
  expect(calls).toEqual([]);
  for (const method of ["get", "read"])
    await bridge.dispatchBackgroundServices(binding, `services.${method}`, { name: "feed" });
  const fresh = { ...binding, resource: { descriptor: { ...descriptor, revision: "r2" } } };
  await bridge.dispatchBackgroundServices(fresh, "services.attach", { name: "feed" });
  expect(calls).toEqual(["get", "read", "attach"]);
});

test("I7 revocation while selected-package inspection awaits is rechecked before mutation", async () => {
  const { bridge, binding, calls, setAvailable } = fixture();
  setAvailable(true);
  let release!: (value: unknown) => void, entered!: () => void;
  const pending = new Promise((resolve) => {
    release = resolve;
  });
  const started = new Promise<void>((resolve) => {
    entered = resolve;
  });
  bridge.projectToolApps = () => ({
    get: () => {
      entered();
      return pending;
    },
  });
  const mutation = bridge.dispatchBackgroundServices(binding, "services.control", {
    name: "feed",
    action: "stop",
  });
  await started;
  bridge.assertLiveProjectBinding = () => {
    throw new PanelBridgeError("REVOKED", "Guest revoked");
  };
  release({ revision: "r1", permissions });
  await expect(mutation).rejects.toMatchObject({ code: "REVOKED" });
  expect(calls).toEqual([]);
});

test("Minor configure dispatch enforces its advertised 64 KiB plus envelope cap even under a larger generic limit", async () => {
  const { bridge, binding, calls, setAvailable } = fixture();
  setAvailable(true);
  bridge.options.limits = { maxParamsBytes: 1024 * 1024 };
  const limit = bridge.contextFor(binding.guest).capabilities.methodLimits["services.configure"]
    .maxParamsBytes;
  expect(limit).toBe(64 * 1024 + 4096);
  await bridge.call(binding.guest, "services.configure", {
    name: "feed",
    config: { value: "x".repeat(64 * 1024 - 32) },
  });
  await expect(
    bridge.call(binding.guest, "services.configure", {
      name: "feed",
      config: { value: "x".repeat(limit) },
    }),
  ).rejects.toMatchObject({ code: "PARAMS_TOO_LARGE" });
  expect(calls).toEqual(["configure"]);
});

test("I7 fresh guest detach uses the Host guest identity and cannot remove another guest's real attachment", async () => {
  const root = await mkdtemp(join(tmpdir(), "desktop-service-detach-"));
  // OS identity alone is injected for this private store. Admission, fsync,
  // attach/detach serialization and idempotent attachment lookup are real.
  const identity = {
    pid: process.pid,
    host: hostname(),
    boot: "fixture-boot",
    start: "fixture-start",
    machine: "fixture-machine",
  };
  const service = new PanelBackgroundService({
    rootDir: join(root, "store"),
    gate: new PanelExecutionGate(),
    identities: { current: () => identity, status: () => "alive" },
    describe: async () => ({
      revision: "r2",
      entry: "unused",
      executable: "/unused",
      sha256: "a".repeat(64),
      packageRoot: root,
      cwd: root,
      definition: {
        entry: "feed",
        channels: { quotes: { maxBytes: 1024 } },
        maxLifetimeMs: 60000,
        idleGraceMs: 0,
      },
    }),
    spawn: async () => {
      throw new Error("Off service must not launch a process");
    },
  });
  const { bridge, binding } = fixture();
  bridge.backgroundService = service;
  bridge.getBackgroundService = () => service;
  bridge.projectToolApps = () => ({ get: async () => ({ revision: "r2", permissions }) });
  const a = {
    ...binding,
    projectPath: root,
    resource: { descriptor: { ...descriptor, revision: "r2" } },
  };
  const b = { ...a, guest: { id: 2 } };
  const call = (guest: any, method: string, input: Record<string, unknown> = {}) =>
    bridge.dispatchBackgroundServices(guest, `services.${method}`, { name: "feed", ...input });
  try {
    await service.initialize();
    const first = await call(a, "attach"),
      second = await call(b, "attach");
    expect(first.attachId).not.toBe(second.attachId);
    await call(a, "detach", { attachId: second.attachId, guestId: 2 });
    expect((await call(b, "attach")).attachId).toBe(second.attachId);
    await call(a, "detach", { attachId: first.attachId });
    expect((await call(a, "attach")).attachId).not.toBe(first.attachId);
    expect((await call(b, "attach")).attachId).toBe(second.attachId);
  } finally {
    await service.shutdown();
    await rm(root, { recursive: true, force: true });
  }
});
