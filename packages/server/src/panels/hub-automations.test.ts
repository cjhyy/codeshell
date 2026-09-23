import { afterEach, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import type { CronJobLifecycleEvent, CronRunRequest } from "@cjhyy/code-shell-core/internal";
import { createHubPanelAutomationHost, type HubPanelAutomationOptions } from "./hub-automations.js";
import { panelExecutionGate, panelExecutionProject } from "./execution-gate.js";
import type { PanelAutomationScope } from "./automations.js";

const cleanups: Array<() => Promise<void>> = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
async function until(predicate: () => boolean) {
  const deadline = Date.now() + 3000;
  while (!predicate()) {
    if (Date.now() > deadline) throw Error("automation did not settle");
    await Bun.sleep(5);
  }
}
function fixture(overrides: Partial<HubPanelAutomationOptions> = {}) {
  const root = mkdtempSync(join(tmpdir(), "hub-automations-"));
  const cwd = join(root, "project");
  mkdirSync(cwd);
  const sessionRootDir = join(root, "sessions");
  const manager = new SessionManager(sessionRootDir);
  const sessionId = manager.create(cwd, "test-model", "test-provider").state.sessionId;
  const events: CronJobLifecycleEvent[] = [];
  const runs: CronRunRequest[] = [];
  const options: HubPanelAutomationOptions = {
    cwd,
    dataDir: join(root, "hub"),
    sessionRootDir,
    assertExecutable: async () => {},
    execute: async (request) => {
      runs.push(request);
    },
    onJobEvent: (event) => {
      events.push(event);
    },
    ...overrides,
  };
  const instances: ReturnType<typeof createHubPanelAutomationHost>[] = [];
  const open = () => {
    const service = createHubPanelAutomationHost(options);
    instances.push(service);
    return service;
  };
  cleanups.push(async () => {
    for (const service of instances) await service.close();
    rmSync(root, { recursive: true, force: true });
  });
  const service = open();
  const scope: PanelAutomationScope = {
    appId: "quant-lab",
    revision: "a".repeat(64),
    cwd,
    sessionId,
    isAuthorized: async () => true,
  };
  const call = (method: string, params?: unknown, target = scope) =>
    service.host.call(target, `automations.${method}`, params) as Promise<any>;
  return {
    root,
    cwd,
    options,
    manager,
    service,
    scope,
    call,
    open,
    events,
    runs,
    file: join(options.dataDir, "panel-automations/records/cron.json"),
  };
}
const definition = { name: "daily", schedule: "1d", prompt: "inspect project", key: "market.us" };

test("persistent project jobs retain source, edits, unique identity and pause across owner restart", async () => {
  const f = fixture();
  const job = await f.call("createUnique", definition);
  expect(job.panelSource).toEqual({ appId: f.scope.appId, revision: f.scope.revision });
  expect((await f.call("createUnique", definition)).id).toBe(job.id);
  await f.call("update", { id: job.id, prompt: "updated" });
  await f.call("pause", { id: job.id });
  expect(() => f.open()).toThrow(/lock/i);
  await f.service.close();
  await expect(f.call("list")).rejects.toThrow(/unavailable/);
  const restarted = f.open();
  const list = (await restarted.host.call(f.scope, "automations.list")) as any;
  expect(list.automations).toHaveLength(1);
  expect(list.automations[0]).toMatchObject({
    id: job.id,
    prompt: "updated",
    enabled: false,
    panelSource: job.panelSource,
  });
  const replay = (await restarted.host.call(f.scope, "automations.createUnique", {
    ...definition,
    prompt: "updated",
  })) as any;
  expect(replay.id).toBe(job.id);
  expect(replay.enabled).toBe(false);
  expect(f.runs).toHaveLength(0);
});

test("scope, persisted Session and current package restrict all mutation paths", async () => {
  const f = fixture();
  const job = await f.call("createUnique", definition);
  const foreignApp = { ...f.scope, appId: "starter" };
  const foreignSession = {
    ...f.scope,
    sessionId: f.manager.create(join(f.root, "elsewhere"), "m", "p").state.sessionId,
  };
  expect((await f.call("list", undefined, foreignApp)).automations).toEqual([]);
  for (const method of ["pause", "resume", "delete", "runNow"])
    await expect(f.call(method, { id: job.id }, foreignApp)).rejects.toThrow(/not available/);
  await expect(f.call("list", undefined, foreignSession)).rejects.toThrow(/outside this project/);
  await expect(f.call("list", undefined, { ...f.scope, cwd: f.root })).rejects.toThrow(/scope/);
  await expect(f.call("create", { ...definition, panelSource: {} })).rejects.toThrow(/authority/);
  await expect(
    f.call("createUnique", definition, { ...f.scope, revision: undefined }),
  ).rejects.toThrow(/revision/);
  const upgraded = { ...f.scope, revision: "b".repeat(64) };
  await expect(f.call("createUnique", definition, upgraded)).rejects.toThrow(
    /different definition/,
  );
  for (const method of ["resume", "runNow", "update"])
    await expect(
      f.call(method, { id: job.id, ...(method === "update" ? { prompt: "x" } : {}) }, upgraded),
    ).rejects.toThrow(/different Panel revision/);
  expect((await f.call("pause", { id: job.id }, upgraded)).ok).toBe(true);
  expect((await f.call("delete", { id: job.id }, upgraded)).ok).toBe(true);
});

test("page authorization is rechecked after await, with no persistent mutation on revocation", async () => {
  const f = fixture();
  let calls = 0;
  await expect(
    f.call("createUnique", definition, { ...f.scope, isAuthorized: async () => ++calls === 1 }),
  ).rejects.toThrow(/expired/);
  expect((await f.call("list")).automations).toEqual([]);
});

test("accepted execution uses persisted source and policy after page disconnect; prompt is frozen", async () => {
  const gate = deferred();
  const f = fixture({ assertExecutable: () => gate.promise });
  const job = await f.call("createUnique", definition);
  await f.call("runNow", { id: job.id });
  expect(f.service.activeCount()).toBe(1);
  f.scope.isAuthorized = async () => false;
  gate.resolve();
  await until(() => f.events.some((event) => event.type === "job_end"));
  expect(f.runs).toHaveLength(1);
  const request = f.runs[0];
  expect(request.job.panelSource?.revision).toBe("a".repeat(64));
  expect(request.prompt).toBe(definition.prompt);
  expect(request.permissionMode).toBe("default");
  expect(request.sandboxMode).toBe("auto");
  expect(await request.approvalBackend.requestApproval({ toolName: "Bash" } as any)).toMatchObject({
    approved: true,
  });
  expect(request.signal?.aborted).toBe(false);
  expect(f.service.activeCount()).toBe(0);
});

test("revoked package binding disables recurring work with a visible reason", async () => {
  const f = fixture({
    assertExecutable: async () => {
      throw Error("Panel permission revoked");
    },
  });
  const job = await f.call("createUnique", definition);
  await f.call("runNow", { id: job.id });
  await until(() => f.events.some((event) => event.type === "job_stopped"));
  const saved = (await f.call("list")).automations[0];
  expect(saved.enabled).toBe(false);
  expect(saved.disabledReason).toBe("Panel permission revoked");
  expect(f.runs).toHaveLength(0);
});

test("deleting or editing a job during package verification prevents stale dispatch", async () => {
  for (const action of ["delete", "update"]) {
    const gate = deferred();
    const f = fixture({ assertExecutable: () => gate.promise });
    const job = await f.call("createUnique", definition);
    await f.call("runNow", { id: job.id });
    await f.call(action, { id: job.id, ...(action === "update" ? { prompt: "new prompt" } : {}) });
    gate.resolve();
    await until(() => f.events.some((event) => event.type === "job_error"));
    expect(f.runs).toHaveLength(0);
  }
});

test("moving a Session during asynchronous verification cannot dispatch into its new workspace", async () => {
  const gate = deferred();
  const f = fixture({ assertExecutable: () => gate.promise });
  const job = await f.call("createUnique", definition);
  await f.call("runNow", { id: job.id });
  f.manager.updateSessionState(f.scope.sessionId, { cwd: f.root });
  gate.resolve();
  await until(() => f.events.some((event) => event.type === "job_error"));
  expect(f.runs).toHaveLength(0);
});

test("close aborts execution and retains the lease until actual executor teardown", async () => {
  const started = deferred(),
    aborted = deferred(),
    teardown = deferred();
  const f = fixture({
    execute: async (request) => {
      request.signal!.addEventListener("abort", aborted.resolve, { once: true });
      started.resolve();
      await teardown.promise;
    },
  });
  const job = await f.call("createUnique", definition);
  await f.call("runNow", { id: job.id });
  await started.promise;
  const closing = f.service.close();
  expect(f.service.close()).toBe(closing);
  await aborted.promise;
  expect(() => f.open()).toThrow(/lock/i);
  teardown.resolve();
  await closing;
  expect(f.events.some((event) => event.type === "job_cancelled")).toBe(true);
  const restored = f.open();
  expect(
    ((await restored.host.call(f.scope, "automations.list")) as any).automations[0].enabled,
  ).toBe(true);
});

test("shutdown while validation is pending does not permanently revoke a job", async () => {
  const gate = deferred();
  const f = fixture({
    assertExecutable: async () => {
      await gate.promise;
      throw Error("validation interrupted");
    },
  });
  const job = await f.call("createUnique", definition);
  await f.call("runNow", { id: job.id });
  const closing = f.service.close();
  gate.resolve();
  await closing;
  const persisted = JSON.parse(readFileSync(f.file, "utf8")).jobs[0];
  expect(persisted.enabled).toBe(true);
  expect(persisted.disabledReason).toBeUndefined();
  expect(f.runs).toHaveLength(0);
});

test("corrupt persisted tasks reject startup without erasing bytes or retaining the lease", async () => {
  const f = fixture();
  await f.call("createUnique", definition);
  await f.service.close();
  const original = readFileSync(f.file, "utf8");
  writeFileSync(f.file, "{ corrupt");
  expect(() => f.open()).toThrow();
  expect(readFileSync(f.file, "utf8")).toBe("{ corrupt");
  writeFileSync(f.file, original);
  const restored = f.open();
  expect(((await restored.host.call(f.scope, "automations.list")) as any).automations).toHaveLength(
    1,
  );
});

test("actual timer fires without an open page and never overlaps the same job", async () => {
  const gate = deferred();
  let calls = 0;
  const f = fixture({
    execute: async () => {
      calls++;
      await gate.promise;
    },
  });
  const job = await f.call("createUnique", { ...definition, schedule: "30" });
  f.scope.isAuthorized = async () => false;
  try {
    await until(() => calls === 1);
    await Bun.sleep(120);
    expect(calls).toBe(1);
    f.scope.isAuthorized = async () => true;
    await f.call("pause", { id: job.id });
    gate.resolve();
    await until(() => f.service.activeCount() === 0);
    expect((await f.call("list")).automations[0]).toMatchObject({ enabled: false, runCount: 1 });
  } finally {
    gate.resolve();
  }
});

test("a separate Node process cannot acquire an existing project scheduling lease", async () => {
  const f = fixture();
  const moduleUrl = new URL("../../dist/index.panels.js", import.meta.url).href;
  const child = Bun.spawn(
    [
      "node",
      "--input-type=module",
      "-e",
      `
    import { createHubPanelAutomationHost } from ${JSON.stringify(moduleUrl)};
    try {
      const service = createHubPanelAutomationHost({
        cwd: ${JSON.stringify(f.cwd)}, dataDir: ${JSON.stringify(f.options.dataDir)},
        sessionRootDir: ${JSON.stringify(f.options.sessionRootDir)},
        assertExecutable: async () => {}, execute: async () => {},
      });
      await service.close(); process.exitCode = 2;
    } catch (error) { if (error.code !== "ELOCKED") throw error; }
  `,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [code, stderr] = await Promise.all([child.exited, new Response(child.stderr).text()]);
  expect(code, stderr).toBe(0);
});

test("corruption during preparation prevents dispatch and preserves the corrupt snapshot", async () => {
  const gate = deferred();
  const f = fixture({ assertExecutable: () => gate.promise });
  const job = await f.call("createUnique", definition);
  await f.call("runNow", { id: job.id });
  writeFileSync(f.file, "{ corrupt while preparing");
  gate.resolve();
  await until(() => f.events.some((event) => event.type === "job_error"));
  expect(f.runs).toHaveLength(0);
  expect(readFileSync(f.file, "utf8")).toBe("{ corrupt while preparing");
});

test("foreign project snapshots fail before any startup reconciliation writes", async () => {
  const f = fixture();
  await f.call("createUnique", definition);
  await f.service.close();
  const snapshot = JSON.parse(readFileSync(f.file, "utf8"));
  snapshot.jobs[0].cwd = f.root;
  snapshot.jobs[0].nextRun = 1;
  const bytes = JSON.stringify(snapshot);
  writeFileSync(f.file, bytes);
  expect(() => f.open()).toThrow(/another project/);
  expect(readFileSync(f.file, "utf8")).toBe(bytes);
});

test("package upgrades wait for verification and real execution cleanup", async () => {
  const verify = deferred(),
    execute = deferred();
  const f = fixture({ assertExecutable: () => verify.promise, execute: () => execute.promise });
  const job = await f.call("createUnique", definition);
  const change = () =>
    panelExecutionGate.mutate(
      (scope) =>
        scope.appId === f.scope.appId && scope.projectPath === panelExecutionProject(f.cwd),
      async () => "changed",
    );
  try {
    await f.call("runNow", { id: job.id });
    await expect(change()).rejects.toThrow(/任务/);
    verify.resolve();
    await Bun.sleep(10);
    const closing = f.service.close();
    await expect(change()).rejects.toThrow(/任务/);
    execute.resolve();
    await closing;
    expect(await change()).toBe("changed");
  } finally {
    verify.resolve();
    execute.resolve();
  }
});
