import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir, hostname } from "node:os";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
  BackgroundServiceStore,
  identityStatus,
  groupStatus,
  type ServiceIdentityInspector,
} from "./background-service-store.js";
import { PanelBackgroundService, type BackgroundServiceOptions } from "./background-services.js";
import { PanelExecutionGate } from "./execution-gate.js";
import { PanelBridgeError } from "./bridge-contract.js";
import { probeServiceRuntime, safeServiceNodeVersion } from "./background-service-process.js";

// Only OS inspection and native process events are injected. The coordinator,
// immutable-owner lock, fsync record and execution gate are the production code.
const identity = {
  pid: process.pid,
  host: hostname(),
  start: "test-os-start",
  boot: "test-os-boot",
  machine: "test-local-machine",
};
const identities: ServiceIdentityInspector = {
  current: () => identity,
  status: (value) => {
    try {
      process.kill(value.pid, 0);
    } catch (error) {
      return (error as NodeJS.ErrnoException).code === "ESRCH" ? "dead" : "unknown";
    }
    return value.boot === identity.boot && value.start === identity.start ? "alive" : "dead";
  },
};
const roots: string[] = [],
  instances: PanelBackgroundService[] = [];
afterEach(async () => {
  for (const service of instances.splice(0)) await service.shutdown();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function fixture(extra: Partial<BackgroundServiceOptions> = {}) {
  const root = await mkdtemp(join(tmpdir(), "panel-service-repair-"));
  roots.push(root);
  let now = 100_000,
    transient: Error | undefined,
    failedEntry: string | undefined;
  const processes: any[] = [],
    events: any[] = [];
  const gate = new PanelExecutionGate();
  const scope = { appId: "fixture", projectPath: root, name: "feed" };
  const describe: BackgroundServiceOptions["describe"] = async (requested) => {
    if (transient) throw transient;
    return {
      revision: "r1",
      entry: requested.name,
      packageRoot: root,
      cwd: root,
      executable: "/unused-test-node",
      sha256: "a".repeat(64),
      definition: {
        entry: requested.name,
        channels: { a: { maxBytes: 1024 }, b: { maxBytes: 1024 } },
        maxLifetimeMs: 21_600_000,
        idleGraceMs: 0,
      },
    };
  };
  const spawn: NonNullable<BackgroundServiceOptions["spawn"]> = async (input) => {
    if (input.entry === failedEntry) throw new Error("TEST_NATIVE_START_FAILED");
    const exited = barrier(),
      terminated = barrier();
    const actual = {
      identity: {
        pid: 90_000_000 + processes.length,
        host: hostname(),
        boot: "fixture",
        machine: "test-local-machine",
        start: "fixture",
      },
      onLine: input.onLine,
      exit: () => {
        actual.running = false;
        exited.resolve();
        input.onExit("fixture exit");
      },
      running: false,
      terminated: terminated.promise,
      exited: exited.promise,
      prepare: async () => actual.identity,
      send: (_message: unknown) => {},
      activate: (_hello: unknown) => {
        actual.running = true;
        input.onLine({ t: "ready" });
      },
      terminate: async (_ms: number) => {
        actual.running = false;
        terminated.resolve();
        exited.resolve();
        return true;
      },
    };
    processes.push(actual);
    return actual;
  };
  const options: BackgroundServiceOptions = {
    rootDir: join(root, "store"),
    identities,
    groupStatus: (identity) => groupStatus(identity.pid),
    gate,
    now: () => now,
    describe,
    spawn,
    onEvent: (_scope, event) => events.push(event),
    ...extra,
  };
  const service = new PanelBackgroundService(options);
  instances.push(service);
  await service.initialize();
  const start = (target = scope) =>
    service.setDesired(target, { desired: "always", expectedRevision: 0, requestKey: "enable" });
  return {
    root,
    scope,
    service,
    options,
    processes,
    events,
    gate,
    start,
    clock: (value: number) => {
      now = value;
    },
    transient: (value?: Error) => {
      transient = value;
    },
    failedEntry: (value?: string) => {
      failedEntry = value;
    },
  };
}

test("C1 one persisted scope fails startup while healthy workers retain custody, gate and timer", async () => {
  const f = await fixture();
  const bad = { ...f.scope, name: "broken", projectPath: join(f.root, "other") };
  await f.start();
  await f.start(bad);
  await f.service.shutdown();
  f.failedEntry("broken");
  const restored = new PanelBackgroundService(f.options);
  instances.push(restored);
  await restored.initialize();
  expect(await restored.get(bad)).toMatchObject({
    desired: "always",
    phase: "backoff",
    restarts: 1,
  });
  expect(await restored.get(f.scope)).toMatchObject({ desired: "always", phase: "running" });
  expect(f.gate.blockers(() => true)).toHaveLength(1);
  expect(f.processes.filter((value) => value.running)).toHaveLength(1);
  await restored.control(f.scope, { action: "stop", requestKey: "stop-after-partial-init" });
  expect(f.processes.filter((value) => value.running)).toHaveLength(0);
});

test("starting phase is published after durable admission before a blocked spawn completes", async () => {
  const entered = barrier(),
    release = barrier();
  const f = await fixture({
    onEvent: (_scope, event) => {
      if (event.state.phase === "starting") entered.resolve();
    },
  });
  const original = f.options.spawn!;
  f.options.spawn = async (input) => {
    await release.promise;
    return original(input);
  };
  const start = f.start();
  await entered.promise;
  expect(f.processes).toHaveLength(0);
  release.resolve();
  await start;
});

test("C2 same-second PID reuse compares kernel unique identity; legacy timestamps remain unknown", () => {
  const current = { ...identity, start: "darwin-unique:456:1" };
  expect(identityStatus({ ...current, start: "darwin-unique:455:1" }, () => current)).toBe("dead");
  expect(identityStatus(current, () => current)).toBe("alive");
  expect(identityStatus({ ...current, start: "Wed Oct 28 10:00:00 2026" }, () => current)).toBe(
    "unknown",
  );
  expect(identityStatus({ ...current, boot: "previous-boot" }, () => current)).toBe("dead");
  expect(identityStatus(current, () => null)).toBe("unknown");
});

test("C2 exact owner token with reused live PID is reclaimed using different OS start identity", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-owner-reuse-"));
  roots.push(root);
  const old = new BackgroundServiceStore(root, undefined, identities);
  old.acquire();
  const lock = join(root, "coordinator.lock"),
    [token] = await readdir(lock);
  await writeFile(
    join(lock, token!),
    JSON.stringify({ ...identity, start: "previous-process-start" }),
  );
  const replacement = new BackgroundServiceStore(root, undefined, identities);
  replacement.acquire();
  expect(await readdir(lock)).not.toEqual([token]);
  expect(() => process.kill(process.pid, 0)).not.toThrow();
  old.release(); // exact old token release must not remove the new owner's lock
  expect(await readdir(lock)).toHaveLength(1);
  replacement.release();
});

test("C2 unavailable OS identity refuses takeover, and a live owner never expires", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-owner-unknown-"));
  roots.push(root);
  const owner = new BackgroundServiceStore(root, undefined, identities);
  owner.acquire();
  const unknown = new BackgroundServiceStore(root, undefined, {
    ...identities,
    status: () => "unknown",
  });
  expect(() => unknown.acquire()).toThrow("SERVICE_COORDINATOR_BUSY");
  const live = new BackgroundServiceStore(root, undefined, identities);
  expect(() => live.acquire()).toThrow("SERVICE_COORDINATOR_BUSY");
  owner.release();
});

test("H-I1 multi-channel old pending value cannot acquire a new processRef generation", async () => {
  const entered = barrier(),
    release = barrier(),
    published = barrier();
  let calls = 0;
  const f = await fixture({
    beforePublish: async () => {
      if (++calls === 1) {
        entered.resolve();
        await release.promise;
      }
    },
    onEvent: (_scope, event) => {
      if (event.channel === "b") published.resolve();
    },
  });
  await f.start();
  f.processes[0].onLine({ t: "publish", channel: "a", value: "old" });
  await entered.promise;
  f.processes[0].exit();
  await f.service.tick();
  f.clock(200_000);
  await f.service.tick();
  f.processes[1].onLine({ t: "publish", channel: "b", value: "new" });
  release.resolve();
  await published.promise;
  expect(await f.service.read(f.scope, "a")).toMatchObject({ seq: 0, value: null });
  expect(await f.service.read(f.scope, "b")).toMatchObject({ generation: 2, seq: 1, value: "new" });
});

for (const boundary of ["write", "file-fsync", "rename", "directory-fsync"] as const) {
  test(`H-I2 ${boundary} failure stops owned executor before disk recovery and retains stop intent`, async () => {
    let armed = false;
    const f = await fixture({
      fault: (point) => {
        if (armed && point === boundary) throw new Error("TEST_DISK_FULL");
      },
    });
    await f.start();
    await f.service.get(f.scope); // drain the ready commit before injecting the stop failure
    armed = true;
    await expect(
      f.service.control(f.scope, { action: "stop", requestKey: "stop-during-full-disk" }),
    ).rejects.toThrow("TEST_DISK_FULL");
    await f.processes[0].terminated;
    expect(f.processes[0].running).toBe(false);
    expect(await f.service.get(f.scope)).toMatchObject({ phase: "stop-unconfirmed" });
    armed = false;
    await f.service.tick();
    expect(await f.service.get(f.scope)).toMatchObject({
      desired: "off",
      phase: "stopped",
      generation: 1,
    });
    const files = (await readdir(f.options.rootDir)).filter((name) => name.endsWith(".json"));
    const durable = JSON.parse(await readFile(join(f.options.rootDir, files[0]!), "utf8"));
    expect(durable.activeGeneration).toBeNull();
    expect(durable.process).toBeNull();
    expect(durable.controls.some((item: any) => item.requestKey === "stop-during-full-disk")).toBe(
      true,
    );
  });
}

test("H-I2 malformed recovery record remains quarantined until repaired", async () => {
  let armed = false;
  const f = await fixture({
    fault: () => {
      if (armed) throw new Error("disk failure");
    },
  });
  await f.start();
  await f.service.get(f.scope);
  armed = true;
  await expect(
    f.service.control(f.scope, { action: "stop", requestKey: "failed-stop" }),
  ).rejects.toThrow();
  await f.processes[0].terminated;
  armed = false;
  const file = (await readdir(f.options.rootDir)).find((name) => name.endsWith(".json"))!;
  const path = join(f.options.rootDir, file),
    valid = await readFile(path, "utf8");
  await writeFile(path, JSON.stringify({ ...JSON.parse(valid), generation: -1 }));
  await f.service.tick();
  f.clock(200_000);
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "stop-unconfirmed" });
  expect(f.processes).toHaveLength(1);
  await writeFile(path, valid);
  f.clock(300_000);
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({ desired: "off", phase: "stopped" });
});

test("H-I3 transient describe error preserves always; only explicit permission revocation switches it off", async () => {
  const f = await fixture();
  await f.start();
  f.transient(new Error("catalog not yet ready"));
  await f.service.tick();
  f.transient();
  expect(await f.service.get(f.scope)).toMatchObject({ desired: "always", phase: "backoff" });
  f.clock(200_000);
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({
    desired: "always",
    phase: "running",
    generation: 2,
  });
  f.transient(new PanelBridgeError("REVOKED", "binding revoked"));
  await f.service.tick();
  f.transient();
  expect(await f.service.get(f.scope)).toMatchObject({ desired: "off", phase: "revoked" });
});

test("H-I3 failed stop remains stop-unconfirmed after temporary description failure", async () => {
  const f = await fixture();
  await f.start();
  await f.service.get(f.scope);
  f.processes[0].terminate = async () => false;
  f.transient(new Error("temporary catalog error"));
  await f.service.tick();
  f.transient();
  expect(await f.service.get(f.scope)).toMatchObject({
    phase: "stop-unconfirmed",
    desired: "always",
  });
  // The fixture PID is now provably absent. A tick must promptly release custody.
  f.clock(200_000);
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "running", generation: 2 });
});

test("H-I4 startup errors back off with bounded attempts; healthy running interval resets consecutive failures", async () => {
  const f = await fixture();
  f.failedEntry("feed");
  await expect(f.start()).rejects.toThrow("TEST_NATIVE_START_FAILED");
  for (let i = 0; i < 5; i++) await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({
    generation: 1,
    restarts: 1,
    phase: "backoff",
  });
  f.failedEntry();
  f.clock(200_000);
  await f.service.tick();
  f.clock(260_001);
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "running", restarts: 0 });
  f.processes[0].exit();
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "backoff", restarts: 1 });
});

test("H-I4 rejects experimental/EOL runtime versions and caches asynchronous failed probes", async () => {
  for (const value of ["v20.20.0", "v22.23.3", "v24.22.0", "v25.8.1", "v26.12.0", "v27.0.0"])
    expect(safeServiceNodeVersion(value)).toBe(false);
  for (const value of ["v22.23.4", "v24.22.1", "v26.12.1"])
    expect(safeServiceNodeVersion(value)).toBe(true);
  const root = await mkdtemp(join(tmpdir(), "panel-runtime-probe-"));
  roots.push(root);
  const executable = join(root, "node-old"),
    count = join(root, "count");
  await writeFile(executable, `#!/bin/sh\necho probe >> '${count}'\necho v20.0.0\n`, {
    mode: 0o700,
  });
  await expect(probeServiceRuntime(executable)).rejects.toThrow(
    "SERVICE_NODE_SECURITY_VERSION_REQUIRED",
  );
  await expect(probeServiceRuntime(executable)).rejects.toThrow(
    "SERVICE_NODE_SECURITY_VERSION_REQUIRED",
  );
  expect((await readFile(count, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("H-I4 a stalled runtime probe yields the event loop and shares its in-flight failure", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-probe-barrier-"));
  roots.push(root);
  const fifo = join(root, "barrier"),
    ready = join(root, "ready"),
    executable = join(root, "node-probe"),
    count = join(root, "count");
  await promisify(execFile)("/usr/bin/mkfifo", [fifo, ready]);
  await writeFile(
    executable,
    `#!/bin/sh\necho probe >> '${count}'\necho ready > '${ready}'\nread release < '${fifo}'\necho v20.0.0\n`,
    { mode: 0o700 },
  );
  const entered = readFile(ready, "utf8");
  const pending = probeServiceRuntime(executable).catch((error) => error);
  const duplicate = probeServiceRuntime(executable).catch((error) => error);
  // A blocking probe cannot service this real two-way IPC barrier.
  expect((await entered).trim()).toBe("ready");
  await writeFile(fifo, "release\n");
  expect((await pending).message).toContain("SERVICE_NODE_SECURITY_VERSION_REQUIRED");
  expect((await duplicate).message).toContain("SERVICE_NODE_SECURITY_VERSION_REQUIRED");
  expect((await readFile(count, "utf8")).trim().split("\n")).toHaveLength(1);
});

test("H-I5 authorized mutation drains service before changing catalog", async () => {
  const f = await fixture();
  await f.start();
  let mutationRan = false;
  await f.gate.mutate(
    (scope) => scope.appId === f.scope.appId,
    async () => {
      expect(f.processes[0].running).toBe(false);
      expect(f.gate.blockers(() => true)).toHaveLength(0);
      mutationRan = true;
      f.transient(new PanelBridgeError("REVOKED", "removed"));
    },
    () => f.gate.drainServices((scope) => scope.appId === f.scope.appId),
  );
  await f.service.tick();
  f.transient();
  expect(mutationRan).toBe(true);
  expect(await f.service.get(f.scope)).toMatchObject({ desired: "off", phase: "revoked" });
});

test("H-I6 get/read are disk-pure and cold stopped records compact without reusing counters or receipts", async () => {
  const f = await fixture();
  const before = await readdir(f.options.rootDir);
  for (let i = 0; i < 140; i++) {
    const scope = { ...f.scope, name: `read-${i}` };
    await f.service.get(scope);
    await f.service.read(scope, "a");
  }
  expect(await readdir(f.options.rootDir)).toEqual(before);
  await f.start();
  await f.service.control(f.scope, { action: "stop", requestKey: "first-stop" });
  for (let i = 0; i < 130; i++)
    await f.service.configure(
      { ...f.scope, name: `configured-${i}` },
      { config: { i }, expectedConfigRevision: 0, requestKey: `configure-${i}` },
    );
  expect(await f.service.get(f.scope)).toMatchObject({ generation: 1, desiredRevision: 2 });
  expect(
    (await f.service.control(f.scope, { action: "stop", requestKey: "first-stop" }))
      .desiredRevision,
  ).toBe(2);
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 2,
    requestKey: "new-start",
  });
  expect((await f.service.get(f.scope)).generation).toBe(2);
});

test("H-I6 real maxPerScope rejects another service while other project can use remaining app slot", async () => {
  const f = await fixture();
  await f.start();
  await expect(f.start({ ...f.scope, name: "another" })).rejects.toMatchObject({
    code: "SERVICE_CAPACITY",
  });
  const other = { ...f.scope, projectPath: join(f.root, "other-project") };
  await f.start(other);
  expect(f.processes.filter((value) => value.running)).toHaveLength(2);
});

test("shutdown preserves paused, revoked and failed phases when no executor remains", async () => {
  const f = await fixture();
  await f.start();
  await f.service.control(f.scope, { action: "pause", requestKey: "pause" });
  await f.service.shutdown();
  const restored = new PanelBackgroundService(f.options);
  instances.push(restored);
  await restored.initialize();
  expect(await restored.get(f.scope)).toMatchObject({ phase: "paused", desired: "always" });
});

test("I-1 delayed group death counts one unexpected exit and preserves its backoff", async () => {
  let groupAlive = true;
  const f = await fixture({ groupStatus: () => (groupAlive ? "alive" : "dead") });
  await f.start();
  await f.service.get(f.scope);
  f.processes[0].exit();
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({
    phase: "stop-unconfirmed",
    restarts: 1,
    lastError: "fixture exit",
    generation: 1,
  });
  // A second close notification before group disappearance must not double count.
  f.processes[0].exit();
  await f.service.tick();
  expect((await f.service.get(f.scope)).restarts).toBe(1);
  groupAlive = false;
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({
    phase: "backoff",
    restarts: 1,
    generation: 1,
    lastError: "fixture exit",
  });
  f.clock(104_999);
  await f.service.tick();
  expect(f.processes).toHaveLength(1);
  f.clock(105_000);
  await f.service.tick();
  expect(f.processes).toHaveLength(2);
  // A former pause/stop phase must never bleed into a later generation's exit.
  await f.service.control(f.scope, { action: "pause", requestKey: "pause" });
  await f.service.control(f.scope, { action: "resume", requestKey: "resume" });
  f.processes[2].exit();
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({
    phase: "backoff",
    restarts: 1,
    generation: 3,
  });
});

test("I-2 queued ready and publication cannot replace the first failed durable stop", async () => {
  let armed = false;
  const publishEntered = barrier(),
    publishRelease = barrier(),
    terminateEntered = barrier(),
    terminateRelease = barrier();
  const f = await fixture({
    fault: (point) => {
      if (armed && point === "directory-fsync") throw new Error("STOP_DIR_FSYNC_FAILED");
    },
    beforePublish: async () => {
      publishEntered.resolve();
      await publishRelease.promise;
    },
  });
  const spawn = f.options.spawn!;
  f.options.spawn = async (input) => {
    const actual: any = await spawn({
      ...input,
      onLine: (message) => {
        if (message.t !== "ready") input.onLine(message);
      },
    });
    actual.onLine = input.onLine;
    actual.terminate = async () => {
      terminateEntered.resolve();
      await terminateRelease.promise;
      return true;
    };
    return actual;
  };
  await f.start();
  f.processes[0].onLine({ t: "publish", channel: "a", value: "late" });
  await publishEntered.promise;
  armed = true;
  await expect(
    f.service.control(f.scope, { action: "stop", requestKey: "durable-stop" }),
  ).rejects.toThrow("STOP_DIR_FSYNC_FAILED");
  await terminateEntered.promise;
  f.processes[0].onLine({ t: "ready" });
  publishRelease.resolve();
  await f.service.get(f.scope); // drains the ready callback while store is poisoned
  const candidate = [...(f.service as any).failedCommits.values()][0];
  try {
    expect(candidate.desired).toBe("off");
    expect(candidate.controls.some((item: any) => item.requestKey === "durable-stop")).toBe(true);
  } finally {
    armed = false;
    terminateRelease.resolve();
  }
  await f.service.tick();
  expect(await f.service.get(f.scope)).toMatchObject({
    desired: "off",
    phase: "stopped",
    generation: 1,
  });
  f.clock(300_000);
  await f.service.tick();
  expect(f.processes).toHaveLength(1);
  expect(await f.service.read(f.scope, "a")).toMatchObject({ seq: 0, value: null });
});

test("I-3 inactive records never describe on tick and enabling clears previous failure budget", async () => {
  const f = await fixture();
  await f.service.configure(f.scope, {
    config: {},
    expectedConfigRevision: 0,
    requestKey: "create-off",
  });
  let calls = 0;
  const describe = f.options.describe;
  f.options.describe = async (scope) => {
    calls++;
    return describe(scope);
  };
  f.transient(new Error("offline catalog"));
  for (let n = 0; n < 6; n++) {
    f.clock(100_000 + n * 300_000);
    await f.service.tick();
  }
  expect(calls).toBe(0);
  f.transient();
  await f.start();
  await f.service.control(f.scope, { action: "pause", requestKey: "pause" });
  calls = 0;
  f.transient(new Error("offline catalog"));
  await f.service.tick();
  expect(calls).toBe(0);
  f.transient();
  await f.service.control(f.scope, { action: "resume", requestKey: "resume" });
  for (let n = 0; n < 5; n++) {
    f.processes.at(-1).exit();
    await f.service.tick();
    f.clock(2_000_000 + n * 300_000);
    await f.service.tick();
  }
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "failed", restarts: 5 });
  calls = 0;
  f.transient(new Error("offline catalog"));
  await f.service.tick();
  expect(calls).toBe(0);
  f.transient();
  const current = await f.service.get(f.scope);
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: current.desiredRevision,
    requestKey: "explicit-enable",
  });
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "running", restarts: 0 });
  await f.service.revoke(f.scope.appId);
  calls = 0;
  f.transient(new Error("removed catalog"));
  await f.service.tick();
  expect(calls).toBe(0);
});

test("I-5 initialization retries lock availability with bounded backoff and coalesces attempts", async () => {
  const root = await mkdtemp(join(tmpdir(), "service-init-retry-"));
  roots.push(root);
  let clock = 0,
    calls = 0;
  const blocker = new BackgroundServiceStore(root, undefined, identities);
  blocker.acquire();
  const service = new PanelBackgroundService({
    rootDir: root,
    now: () => clock,
    identities: {
      ...identities,
      current: (pid) => {
        calls++;
        return identities.current(pid);
      },
    },
    describe: async () => {
      throw new Error("no records");
    },
  });
  instances.push(service);
  await expect(service.initialize()).rejects.toThrow("SERVICE_COORDINATOR_BUSY");
  expect(service.isAvailable()).toBe(false);
  expect(calls).toBe(1);
  await expect(service.tick()).rejects.toThrow("SERVICE_COORDINATOR_BUSY");
  expect(calls).toBe(1);
  clock = 5000;
  const attempts = await Promise.allSettled([
    service.initialize(),
    service.initialize(),
    service.tick(),
  ]);
  expect(attempts.every((value) => value.status === "rejected")).toBe(true);
  expect(calls).toBe(2);
  blocker.release();
  clock = 14_999;
  await expect(service.tick()).rejects.toThrow();
  expect(calls).toBe(2);
  clock = 15_000;
  await service.tick();
  expect(calls).toBe(3);
  expect(service.isAvailable()).toBe(true);
  const challenger = new BackgroundServiceStore(root, undefined, identities);
  expect(() => challenger.acquire()).toThrow("SERVICE_COORDINATOR_BUSY");
});

for (const phase of ["paused", "failed", "revoked"] as const)
  test(`storage recovery retains inactive ${phase} phase and counters`, async () => {
    let armed = false;
    const f = await fixture({
      fault: () => {
        if (armed) throw new Error("TEST_RECOVERY_FAULT");
      },
    });
    await f.start();
    if (phase === "paused")
      await f.service.control(f.scope, { action: "pause", requestKey: "pause" });
    else if (phase === "revoked") await f.service.revoke(f.scope.appId);
    else
      for (let n = 0; n < 5; n++) {
        f.processes.at(-1).exit();
        await f.service.tick();
        f.clock(1_000_000 + n * 300_000);
        await f.service.tick();
      }
    const before = await f.service.get(f.scope);
    expect(before.phase).toBe(phase);
    armed = true;
    await expect(
      f.service.configure(f.scope, {
        config: { marker: phase },
        expectedConfigRevision: before.configRevision,
        requestKey: "failed-config",
      }),
    ).rejects.toThrow("TEST_RECOVERY_FAULT");
    armed = false;
    await f.service.tick();
    expect(await f.service.get(f.scope)).toMatchObject({
      phase,
      restarts: before.restarts,
      generation: before.generation,
    });
  });

test("initialization racing shutdown never activates native code or releases existing custody early", async () => {
  const f = await fixture();
  await f.start();
  await f.service.shutdown();
  const entered = barrier(),
    release = barrier();
  let activated = 0;
  const original = f.options.spawn!;
  f.options.spawn = async (input) => {
    entered.resolve();
    await release.promise;
    const actual = await original(input);
    const activate = actual.activate;
    actual.activate = (hello) => {
      activated++;
      activate(hello);
    };
    return actual;
  };
  const restored = new PanelBackgroundService(f.options);
  instances.push(restored);
  const initializing = restored.initialize();
  await entered.promise;
  const stopping = restored.shutdown();
  expect(restored.isAvailable()).toBe(false);
  const challenger = new BackgroundServiceStore(f.options.rootDir, undefined, identities);
  expect(() => challenger.acquire()).toThrow("SERVICE_COORDINATOR_BUSY");
  release.resolve();
  await initializing;
  await stopping;
  expect(activated).toBe(0);
  expect(restored.isAvailable()).toBe(false);
  challenger.acquire();
  challenger.release();
});

test("package drain starts all owned stops together and retains inactive paused state", async () => {
  const f = await fixture();
  await f.start();
  const other = { ...f.scope, projectPath: join(f.root, "other") };
  await f.start(other);
  const entered = barrier(),
    release = barrier();
  let stopping = 0;
  for (const actual of f.processes) {
    const terminate = actual.terminate;
    actual.terminate = async () => {
      stopping++;
      entered.resolve();
      await release.promise;
      return terminate(0);
    };
  }
  const draining = f.service.drain(() => true);
  await entered.promise;
  try {
    expect(stopping).toBe(2);
  } finally {
    release.resolve();
    await draining;
  }
  await f.service.control(f.scope, { action: "pause", requestKey: "pause-without-worker" });
  await f.service.drain(() => true);
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "paused", desired: "always" });
});

test("fifth internal failure with delayed group exit settles failed while explicit stop still wins", async () => {
  let live = false;
  const f = await fixture({ groupStatus: () => (live ? "alive" : "dead") });
  await f.start();
  for (let n = 1; n <= 5; n++) {
    live = true;
    f.processes.at(-1).terminate = async () => false;
    f.transient(new Error("temporary describe failure"));
    await f.service.tick();
    f.transient();
    expect(await f.service.get(f.scope)).toMatchObject({ phase: "stop-unconfirmed", restarts: n });
    live = false;
    await f.service.tick();
    expect(await f.service.get(f.scope)).toMatchObject({
      phase: n === 5 ? "failed" : "backoff",
      restarts: n,
    });
    f.clock(100_000 + n * 300_000);
    await f.service.tick();
  }
  expect(f.processes).toHaveLength(5);
  expect((await f.service.get(f.scope)).lastError).toContain("temporary describe failure");
  await f.service.control(f.scope, { action: "stop", requestKey: "explicit-off" });
  expect(await f.service.get(f.scope)).toMatchObject({
    phase: "stopped",
    desired: "off",
    restarts: 5,
  });
});

test("legacy cross-boot custody without machine proof remains explicit and never restarts", async () => {
  const f = await fixture({ groupStatus: () => "unknown" });
  await f.start();
  await f.service.get(f.scope);
  const [key, record] = [...(f.service as any).records.entries()][0];
  (f.service as any).commit(key, (next: any) => {
    delete next.process.machine;
    delete next.worker.machine;
  });
  f.processes[0].exit();
  await f.service.get(f.scope);
  await f.service.tick();
  const stopped = await f.service.get(f.scope);
  expect(stopped).toMatchObject({ phase: "stop-unconfirmed", generation: record.generation });
  expect(stopped.lastError).toContain("SERVICE_LEGACY_LOCALITY_UNCONFIRMED");
  expect(f.gate.blockers(() => true)[0]?.holder?.label).toContain("no machine proof across boots");
  f.clock(1_000_000);
  await f.service.tick();
  expect(f.processes).toHaveLength(1);
  expect((await f.service.get(f.scope)).phase).toBe("stop-unconfirmed");
});
