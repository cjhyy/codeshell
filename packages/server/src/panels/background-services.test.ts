import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, realpath } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createHash } from "node:crypto";
import { spawn, type ChildProcess } from "node:child_process";
import {
  BackgroundServiceStore,
  type CommitBoundary,
  groupStatus,
} from "./background-service-store.js";
import {
  PanelBackgroundService,
  type BackgroundServiceDescription,
} from "./background-services.js";
import { PanelExecutionGate } from "./execution-gate.js";
import { panelBridgeFailure } from "./bridge-contract.js";
import { PanelToolJobService } from "./tool-jobs.js";
import { resolvePanelExecutable } from "./process-service.js";

const roots: string[] = [],
  services: PanelBackgroundService[] = [];
afterEach(async () => {
  for (const service of services.splice(0)) await service.shutdown().catch(() => {});
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});
function barrier<T = void>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { resolve, promise };
}
// Plain pipe receipts avoid Bun/Node private IPC-channel interoperability. The
// child writes one bounded JSON line; completion is an explicit IPC barrier.
function receiveChildReceipt(child: ChildProcess, stderr: () => string): Promise<any> {
  return new Promise((resolve, reject) => {
    let bytes = "";
    const cleanup = () => {
      child.stdout!.off("data", data);
      child.off("exit", exited);
      child.off("error", failed);
    };
    const failed = (error: Error) => {
      cleanup();
      reject(error);
    };
    const exited = (code: number | null) => failed(new Error(`host ${code}: ${stderr()}`));
    const data = (chunk: Buffer) => {
      bytes += chunk.toString();
      if (Buffer.byteLength(bytes) > 8192) return failed(new Error("HOST_RECEIPT_LIMIT"));
      const end = bytes.indexOf("\n");
      if (end < 0) return;
      try {
        const receipt = JSON.parse(bytes.slice(0, end));
        cleanup();
        resolve(receipt);
      } catch (error) {
        failed(error as Error);
      }
    };
    child.stdout!.on("data", data);
    child.once("exit", exited);
    child.once("error", failed);
  });
}
test("native Node Host receipts use bounded pipes independently of Bun private IPC", async () => {
  const executable = (await resolvePanelExecutable("node"))!;
  const child = spawn(
    executable,
    ["-e", `process.stdout.write(JSON.stringify({ready:true})+'\\n');`],
    { stdio: ["ignore", "pipe", "pipe"], env: { PATH: process.env.PATH } },
  );
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const exited = new Promise<number | null>((resolve) => child.once("exit", resolve));
  try {
    expect(await receiveChildReceipt(child, () => stderr)).toEqual({ ready: true });
    expect(await exited).toBe(0);
  } finally {
    if (child.exitCode === null) child.kill("SIGKILL");
  }
});
const source = `import {createInterface} from 'node:readline';
let n=0; const send=x=>console.log(JSON.stringify(x));
createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);
if(x.t==='hello'){send({t:'ready'});send({t:'publish',channel:'quotes',value:{n:++n,config:x.config}})}
if(x.t==='poke')send({t:'publish',channel:'quotes',value:{n:++n}});
if(x.t==='config')send({t:'publish',channel:'quotes',value:{n:++n,config:x.config}});
if(x.t==='drain'){send({t:'drained'});process.exit(0)}}).on('close',()=>process.exit(0));`;
async function fixture(
  extra: Partial<ConstructorParameters<typeof PanelBackgroundService>[0]> = {},
) {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-background-service-")));
  roots.push(root);
  const pkg = join(root, "pkg"),
    cwd = join(root, "cwd");
  await mkdir(pkg);
  await mkdir(cwd);
  const entry = join(pkg, "worker.mjs");
  await writeFile(entry, source);
  const executable = await resolvePanelExecutable("node");
  if (!executable) throw new Error("Node required");
  const description = {
    revision: "r1",
    executable,
    entry,
    packageRoot: pkg,
    cwd,
    sha256: createHash("sha256").update(source).digest("hex"),
    definition: {
      entry: "fixture",
      channels: { quotes: { maxBytes: 262144 } },
      maxLifetimeMs: 60_000,
      idleGraceMs: 0,
    },
  } satisfies BackgroundServiceDescription;
  const events: any[] = [];
  const waiters: Array<{ match: (event: any) => boolean; resolve: (event: any) => void }> = [];
  const next = (match: (event: any) => boolean) => {
    const found = events.find(match);
    if (found) return Promise.resolve(found);
    return new Promise<any>((resolve) => {
      waiters.push({ match, resolve });
    });
  };
  const gate = new PanelExecutionGate();
  const options = {
    rootDir: join(root, "store"),
    gate,
    describe: async () => description,
    onEvent: (_scope: any, event: any) => {
      events.push(event);
      for (const waiter of waiters.splice(0)) {
        if (waiter.match(event)) waiter.resolve(event);
        else waiters.push(waiter);
      }
    },
    ...extra,
  };
  const service = new PanelBackgroundService(options);
  services.push(service);
  await service.initialize();
  const scope = { appId: "fixture", projectPath: root, name: "feed" };
  return { root, service, options, description, scope, next, events, gate };
}

test("one executor across guests; always survives all detach; reopen reads same generation", async () => {
  const f = await fixture();
  const [a, b] = await Promise.all([f.service.attach(f.scope, 1), f.service.attach(f.scope, 2)]);
  expect(a.attachId).not.toBe(b.attachId);
  const started = await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  await f.next((event) => event.seq === 1);
  f.service.detachGuest(1);
  f.service.detachGuest(2);
  await f.service.control(f.scope, { action: "poke", requestKey: "tick-without-guests" });
  await f.next((event) => event.seq === 2);
  const snapshot = await f.service.read(f.scope, "quotes");
  expect(snapshot).toMatchObject({ seq: 2, generation: started.generation });
  const reopened = await f.service.attach(f.scope, 3);
  expect(reopened.state.generation).toBe(started.generation);
  expect(
    f.gate.blockers(() => true).filter((blocker) => blocker.holder?.kind === "service"),
  ).toHaveLength(1);
  expect(
    await f.service.read({ ...f.scope, projectPath: join(f.root, "other") }, "quotes"),
  ).toMatchObject({ seq: 0, value: null });
  expect(await f.service.read({ ...f.scope, appId: "other" }, "quotes")).toMatchObject({
    seq: 0,
    value: null,
  });
});

test("durable stop receipt is idempotent, snapshots and sequence survive restart", async () => {
  const f = await fixture();
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  await f.next((event) => event.seq === 1);
  const stopped = await f.service.control(f.scope, {
    action: "stop",
    requestKey: "lost-stop-receipt",
  });
  expect(stopped.phase).toBe("stopped");
  expect(stopped.controls.some((control) => control.requestKey === "lost-stop-receipt")).toBe(true);
  const seq = ((await f.service.read(f.scope, "quotes")) as any).seq;
  const duplicate = await f.service.control(f.scope, {
    action: "stop",
    requestKey: "lost-stop-receipt",
  });
  expect(duplicate.desiredRevision).toBe(stopped.desiredRevision);
  await f.service.shutdown();
  services.splice(services.indexOf(f.service), 1);
  const restarted = new PanelBackgroundService(f.options);
  services.push(restarted);
  await restarted.initialize();
  expect(await restarted.get(f.scope)).toMatchObject({
    desired: "off",
    generation: stopped.generation,
  });
  expect(await restarted.read(f.scope, "quotes")).toMatchObject({ seq });
  const enabled = await restarted.setDesired(f.scope, {
    desired: "always",
    expectedRevision: stopped.desiredRevision,
    requestKey: "enable-again",
  });
  expect(enabled.generation).toBe(stopped.generation + 1);
});

test("config CAS and declaration scope reject invalid mutations; receipts are bounded", async () => {
  const f = await fixture();
  await f.service.configure(f.scope, {
    config: { subscriptions: [] },
    expectedConfigRevision: 0,
    requestKey: "config",
  });
  expect(
    await f.service.configure(f.scope, {
      config: { subscriptions: [] },
      expectedConfigRevision: 0,
      requestKey: "config",
    }),
  ).toEqual({ configRevision: 1 });
  await expect(
    f.service.configure(f.scope, { config: {}, expectedConfigRevision: 0, requestKey: "other" }),
  ).rejects.toThrow("SERVICE_CONFIG_CONFLICT");
  await expect(f.service.read(f.scope, "undeclared")).rejects.toThrow("SERVICE_UNKNOWN_CHANNEL");
  await expect(
    f.service.configure(f.scope, {
      config: { subscriptions: ["different"] },
      expectedConfigRevision: 1,
      requestKey: "config",
    }),
  ).rejects.toThrow("SERVICE_REQUEST_KEY_CONFLICT");
  for (let index = 0; index < 40; index++)
    await f.service.control(f.scope, { action: "poke", requestKey: `poke:${index}` });
  await expect(
    f.service.configure(f.scope, {
      config: { subscriptions: ["new"] },
      expectedConfigRevision: 0,
      requestKey: "config",
    }),
  ).rejects.toThrow("SERVICE_CONFIG_CONFLICT");
  expect((await f.service.get(f.scope)).controls).toHaveLength(32);
});

test("cross-Host coordinator lock refuses even a quiet live owner, exact release allows recovery", async () => {
  const root = await mkdtemp(join(tmpdir(), "panel-service-lock-"));
  roots.push(root);
  const a = new BackgroundServiceStore(root),
    b = new BackgroundServiceStore(root);
  a.acquire();
  expect(() => b.acquire()).toThrow("SERVICE_COORDINATOR_BUSY");
  expect((await readdir(join(root, "coordinator.lock"))).length).toBe(1);
  a.release();
  b.acquire();
  b.release();
});

for (const boundary of ["write", "file-fsync", "rename", "directory-fsync"] as CommitBoundary[]) {
  test(`single authoritative record survives crash at ${boundary} without hybrid state`, async () => {
    const root = await mkdtemp(join(tmpdir(), "panel-service-crash-"));
    roots.push(root);
    const original = {
      format: "panel.background-service/1",
      generation: 9,
      desired: "always",
      seq: 41,
      payload: "old",
    };
    let crash = false;
    const a = new BackgroundServiceStore<any>(root, (point) => {
      if (crash && point === boundary) throw new Error("crash");
    });
    a.acquire();
    a.commit("a".repeat(64), original);
    crash = true;
    const stopped = {
      ...original,
      generation: 10,
      desired: "off",
      seq: 42,
      payload: "new",
      requestKey: "stop",
    };
    expect(() => a.commit("a".repeat(64), stopped)).toThrow("crash");
    expect(() => a.commit("a".repeat(64), original)).toThrow("SERVICE_COORDINATOR_UNAVAILABLE");
    a.release();
    const recovered = new BackgroundServiceStore<any>(root);
    recovered.acquire();
    expect(recovered.read("a".repeat(64))).toEqual(
      ["write", "file-fsync"].includes(boundary) ? original : stopped,
    );
    recovered.release();
  });
}

test("upgrade drains before new revision enters and service budget is independent of two task slots", async () => {
  const f = await fixture();
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  await f.next((event) => event.seq === 1);
  const releaseTaskA = f.gate.enter({
    appId: "media-a",
    projectPath: f.root,
    holder: { kind: "tool-job" },
  });
  const releaseTaskB = f.gate.enter({
    appId: "media-b",
    projectPath: f.root,
    holder: { kind: "tool-job" },
  });
  const matches = (scope: any) => scope.appId === f.scope.appId;
  await f.gate.mutate(
    matches,
    async () => {
      expect(f.gate.blockers(matches)).toHaveLength(0);
      f.description.revision = "r2";
    },
    () => f.service.drain(matches),
  );
  await f.service.tick();
  const state = await f.service.get(f.scope);
  expect(state.generation).toBe(2);
  expect(state.revision).toBe("r2");
  releaseTaskA();
  releaseTaskB();
});

test("publication paused before commit is atomically rejected after acknowledged stop", async () => {
  const entered = barrier(),
    release = barrier();
  const f = await fixture({
    beforePublish: async () => {
      entered.resolve();
      await release.promise;
    },
  });
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  await entered.promise;
  const stopped = await f.service.control(f.scope, { action: "stop", requestKey: "stop" });
  expect(stopped.phase).toBe("stopped");
  release.resolve();
  await f.service.tick();
  expect(await f.service.read(f.scope, "quotes")).toMatchObject({ seq: 0, value: null });
  expect(f.events.some((event) => event.channel)).toBe(false);
});

test("I-1 actual coordinator counts guardian loss once and backs off after group exit", async () => {
  const f = await fixture();
  const native = `import{createInterface}from'node:readline';setInterval(()=>{},1000);createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.t==='hello'){console.log(JSON.stringify({t:'ready'}));console.log(JSON.stringify({t:'publish',channel:'quotes',value:{ready:true}}));}if(x.t==='poke')process.kill(process.ppid,'SIGKILL');if(x.t==='drain')process.exit(0);});`;
  await writeFile(f.description.entry, native);
  f.description.sha256 = createHash("sha256").update(native).digest("hex");
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  await f.next((event) => event.seq === 1);
  await f.service.control(f.scope, { action: "poke", requestKey: "kill-guardian" });
  await f.next((event) => event.state.phase === "backoff");
  expect(await f.service.get(f.scope)).toMatchObject({
    phase: "backoff",
    restarts: 1,
    generation: 1,
    lastError: "SERVICE_CUSTODY_LEADER_EXITED",
  });
  await f.service.tick();
  expect((await f.service.get(f.scope)).generation).toBe(1);
});

test("Host SIGKILL with a stopped guardian cannot create a second executor; only proven group death permits recovery", async () => {
  const f = await fixture();
  await f.service.shutdown();
  services.splice(services.indexOf(f.service), 1);
  const script = join(f.root, "host.mjs");
  // Derive the source-adjacent built module without importing the user's installed Host.
  const built = new URL("../../dist/panels/background-services.js", import.meta.url).href;
  await writeFile(
    script,
    `import {PanelBackgroundService} from ${JSON.stringify(built)};
const description=${JSON.stringify(f.description)};const scope=${JSON.stringify(f.scope)};
const service=new PanelBackgroundService({rootDir:${JSON.stringify(f.options.rootDir)},describe:async()=>description,onEvent:(_scope,event)=>{if(event.seq===1)process.stdout.write(JSON.stringify({ready:true})+'\\n')}});
await service.initialize();await service.setDesired(scope,{desired:'always',expectedRevision:0,requestKey:'start'});`,
  );
  const child = spawn(f.description.executable, [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  const ready = receiveChildReceipt(child, () => stderr);
  let guardian = 0;
  try {
    expect(await ready).toEqual({ ready: true });
    const path = (await readdir(f.options.rootDir)).find((name) => name.endsWith(".json"))!;
    const record = JSON.parse(await readFile(join(f.options.rootDir, path), "utf8"));
    guardian = record.process.pid;
    expect(record.process.start).toMatch(/^(darwin-unique:|linux-ticks:)/);
    expect(record.process.boot).toBeTruthy();
    process.kill(guardian, "SIGSTOP");
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const restarted = new PanelBackgroundService(f.options);
    services.push(restarted);
    await restarted.initialize();
    const blocked = await restarted.get(f.scope);
    expect(blocked).toMatchObject({ phase: "stop-unconfirmed", generation: 1, desired: "always" });
    await restarted.attach(f.scope, 9);
    await restarted.tick();
    expect((await restarted.get(f.scope)).generation).toBe(1);
    expect(await restarted.read(f.scope, "quotes")).toMatchObject({ seq: 1 });
    // The fixture owns this exact group; production recovery never issues this kill.
    process.kill(-guardian, "SIGKILL");
    const deadline = Date.now() + 5000;
    while (groupStatus(guardian) !== "dead" && Date.now() < deadline)
      await new Promise((resolve) => setImmediate(resolve));
    expect(groupStatus(guardian)).toBe("dead");
    guardian = 0;
    await restarted.tick();
    expect((await restarted.get(f.scope)).generation).toBe(2);
  } finally {
    child.kill("SIGKILL");
    if (guardian) {
      try {
        process.kill(-guardian, "SIGKILL");
      } catch {}
    }
  }
});

test("Host crash after guardian spawn but before PID commit cannot run uncommitted native code", async () => {
  const f = await fixture();
  await f.service.shutdown();
  services.splice(services.indexOf(f.service), 1);
  const native =
    String.raw`import {appendFileSync} from 'node:fs';appendFileSync('starts','started\n');` +
    source;
  await writeFile(f.description.entry, native);
  f.description.sha256 = createHash("sha256").update(native).digest("hex");
  const script = join(f.root, "host-before-go.mjs");
  const built = new URL("../../dist/panels/background-services.js", import.meta.url).href;
  await writeFile(
    script,
    `import {PanelBackgroundService} from ${JSON.stringify(built)};const service=new PanelBackgroundService({rootDir:${JSON.stringify(f.options.rootDir)},describe:async()=>(${JSON.stringify(f.description)}),afterSpawnBeforeIdentity:async(identity)=>{await new Promise((resolve,reject)=>process.stdout.write(JSON.stringify(identity)+'\\n',error=>error?reject(error):resolve()));await new Promise(()=>{})}});await service.initialize();await service.setDesired(${JSON.stringify(f.scope)},{desired:'always',expectedRevision:0,requestKey:'start'});`,
  );
  const child = spawn(f.description.executable, [script], {
    stdio: ["pipe", "pipe", "pipe"],
    env: { PATH: process.env.PATH },
  });
  let stderr = "";
  child.stderr!.on("data", (chunk) => {
    stderr += chunk;
  });
  let guardian = 0;
  try {
    const identity = await receiveChildReceipt(child, () => stderr);
    guardian = identity.pid;
    await expect(readFile(join(f.description.cwd, "starts"))).rejects.toThrow();
    const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
    child.kill("SIGKILL");
    await exited;
    const restarted = new PanelBackgroundService(f.options);
    services.push(restarted);
    await restarted.initialize();
    await f.next((event) => event.seq === 1);
    expect((await restarted.get(f.scope)).generation).toBe(2);
    expect(await readFile(join(f.description.cwd, "starts"), "utf8")).toBe("started\n");
  } finally {
    child.kill("SIGKILL");
    if (guardian && groupStatus(guardian) !== "dead") {
      try {
        process.kill(-guardian, "SIGKILL");
      } catch {}
    }
  }
});

test("service sandbox refuses escaping subprocesses while permitting reviewed package code", async () => {
  const f = await fixture();
  const native = String.raw`import {spawnSync} from 'node:child_process';import {createInterface} from 'node:readline';createInterface({input:process.stdin}).on('line',line=>{const x=JSON.parse(line);if(x.t==='drain')process.exit(0);if(x.t==='hello'){let denied=false;try{spawnSync(process.execPath,['-e','process.exit(0)'])}catch(error){denied=error.code==='ERR_ACCESS_DENIED'}console.log(JSON.stringify({t:'ready'}));console.log(JSON.stringify({t:'publish',channel:'quotes',value:{denied}}))}}).on('close',()=>process.exit(0));`;
  await writeFile(f.description.entry, native);
  f.description.sha256 = createHash("sha256").update(native).digest("hex");
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "sandbox",
  });
  await f.next((event) => event.seq === 1);
  expect(await f.service.read(f.scope, "quotes")).toMatchObject({ value: { denied: true } });
});

test("unbounded stdout is terminated, leaves no oversized snapshot, and enters bounded backoff", async () => {
  const f = await fixture();
  const native = String.raw`process.stdin.on('data',()=>process.stdout.write('x'.repeat(300000)));process.stdin.on('end',()=>process.exit(0));`;
  await writeFile(f.description.entry, native);
  f.description.sha256 = createHash("sha256").update(native).digest("hex");
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "flood",
  });
  await f.next((event) => event.state.phase === "backoff");
  expect(await f.service.read(f.scope, "quotes")).toMatchObject({ seq: 0, value: null });
  expect((await f.service.get(f.scope)).lastError).toContain("SERVICE_OUTPUT_LINE_TOO_LARGE");
});

test("a running background collector leaves both durable task execution slots available", async () => {
  const f = await fixture();
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  await f.next((event) => event.seq === 1);
  const both = barrier(),
    release = barrier();
  let executing = 0;
  const jobs = new PanelToolJobService({
    rootDir: join(f.root, "jobs"),
    execute: async () => {
      executing++;
      if (executing === 2) both.resolve();
      await release.promise;
      return { ok: true };
    },
  });
  const scope = { appId: "media-fixture", projectPath: f.root, revision: "r1" };
  try {
    const request = {
      entry: { name: "fixture", sha256: "a".repeat(64) },
      input: {},
      recovery: "manual" as const,
    };
    const [a, b] = await Promise.all([
      jobs.start(scope, { ...request, requestKey: "a" }),
      jobs.start(scope, { ...request, requestKey: "b" }),
    ]);
    await both.promise;
    expect((await jobs.get(scope, a.id)).status).toBe("running");
    expect((await jobs.get(scope, b.id)).status).toBe("running");
    expect((await f.service.get(f.scope)).phase).toBe("running");
  } finally {
    release.resolve();
    await jobs.shutdown();
  }
});

test("five consecutive worker failures stop automatic restarts until explicit recovery", async () => {
  let now = 100_000;
  const f = await fixture({ now: () => now });
  const native = `process.stdin.once('data',()=>process.exit(1));`;
  await writeFile(f.description.entry, native);
  f.description.sha256 = createHash("sha256").update(native).digest("hex");
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "enable",
  });
  for (let count = 1; count <= 5; count++) {
    await f.next(
      (event) =>
        event.state.restarts === count && ["backoff", "failed"].includes(event.state.phase),
    );
    if (count < 5) {
      now += 300_001;
      await f.service.tick();
    }
  }
  expect(await f.service.get(f.scope)).toMatchObject({ phase: "failed", generation: 5 });
  now += 300_001;
  await f.service.tick();
  expect((await f.service.get(f.scope)).generation).toBe(5);
});

test("capacity rejection has a structured bridge code and does not enable a queued desired intent", async () => {
  const f = await fixture();
  await f.service.setDesired(f.scope, {
    desired: "always",
    expectedRevision: 0,
    requestKey: "one",
  });
  await f.service.setDesired(
    { ...f.scope, name: "second", projectPath: join(f.root, "second-project") },
    { desired: "always", expectedRevision: 0, requestKey: "two" },
  );
  const third = { ...f.scope, name: "third" };
  let failure: unknown;
  try {
    await f.service.setDesired(third, {
      desired: "always",
      expectedRevision: 0,
      requestKey: "three",
    });
  } catch (error) {
    failure = error;
  }
  expect(panelBridgeFailure(failure)).toMatchObject({
    __codeshellPanelError: { code: "SERVICE_CAPACITY" },
  });
  expect(await f.service.get(third)).toMatchObject({
    desired: "off",
    desiredRevision: 0,
    generation: 0,
  });
});

test("unknown persisted formats are never migrated or rewritten by this reader/writer", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "panel-service-format-")));
  roots.push(root);
  const store = new BackgroundServiceStore<any>(root);
  store.acquire();
  const key = "b".repeat(64),
    bytes = JSON.stringify({
      format: "panel.background-service/2",
      generation: 100,
      desired: "off",
    });
  await writeFile(join(root, `${key}.json`), bytes);
  try {
    expect(() => store.read(key)).toThrow("SERVICE_FORMAT_UNSUPPORTED");
    expect(() => store.commit(key, { format: "panel.background-service/2" })).toThrow(
      "SERVICE_FORMAT_UNSUPPORTED",
    );
    expect(await readFile(join(root, `${key}.json`), "utf8")).toBe(bytes);
  } finally {
    store.release();
  }
});
