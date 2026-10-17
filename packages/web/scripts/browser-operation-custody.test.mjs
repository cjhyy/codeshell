import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { createHash } from "node:crypto";
import { mkdtemp, mkdir, readFile, rm, writeFile, lstat, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { prepareBrowserOperationCustody } from "./browser-operation-custody.mjs";

assert.equal(process.env.NODE_ENV, "test", "Use the isolated Node smoke runner");
assert.equal(process.env.CODE_SHELL_TEST_HOME, path.join(process.env.HOME, ".code-shell"));

async function fixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "codeshell-browser-custody-unit-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const evidence = path.join(root, "evidence");
  await mkdir(evidence);
  const executable = path.join(root, "owned Chromium 中文 executable");
  const executableBytes = "Pure Node fixture; never executed.";
  await writeFile(executable, executableBytes);
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 700001,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref() {},
    kill() {
      throw Error("No direct ChildProcess kill authority");
    },
  });
  let terminateCount = 0,
    watchCount = 0;
  const spawns = [],
    launches = [],
    failures = [],
    signals = [],
    order = [];
  const children = {
    spawn: (...args) => {
      spawns.push(args);
      order.push("spawn");
      return child;
    },
  };
  const previousSpawn = children.spawn;
  const exit = (code = 0, signal = null) => {
    if (child.exitCode !== null || child.signalCode !== null) return;
    child.exitCode = code;
    child.signalCode = signal;
    child.emit("close", code, signal);
  };
  const cleaned = {
    status: "cleaned",
    owned: [{ pid: child.pid, ppid: process.pid, birth: "owned-full-birth" }],
    remaining: [],
    ownedCount: 1,
    remainingCount: 0,
    queryFailed: false,
    evidenceTruncated: false,
  };
  let watchOptions;
  const watch = (_child, incoming) => {
    watchCount++;
    watchOptions = incoming;
    order.push("watch-before-handshake");
    if (options.watchThrows) throw Error("Initial birth query failed");
    return {
      terminate: async () => {
        terminateCount++;
        order.push("terminate");
        if (options.terminateThrows) throw Error("Termination failed");
        if (options.terminateNever) return new Promise(() => {});
        if (!options.noExit)
          exit(options.exitCode === undefined ? 0 : options.exitCode, options.signal ?? null);
        return options.settlement ?? cleaned;
      },
    };
  };
  const custody = await prepareBrowserOperationCustody({
    evidence,
    executablePath: executable,
    executableSHA256: createHash("sha256").update(executableBytes).digest("hex"),
    environment: { ...process.env, OWNED_PROVIDER_SECRET: "must-not-inherit" },
    timeoutMs: 120000,
    closeTimeoutMs: 20,
    settlementTimeoutMs: 20,
    exitTimeoutMs: 20,
    reportFailure: (message) => failures.push(message),
    onCheckpoint: options.onCheckpoint,
    dependencies: {
      children,
      syncBuiltinESMExports() {},
      watch,
      signalProcess: (...args) => signals.push(args),
      remove: options.remove,
    },
  });
  const owner = {
    browser: () => (options.nullBrowser ? null : {}),
    async close() {
      order.push("close");
      if (options.closeThrows) throw Error("Graceful close failed");
      if (options.closeNever) return new Promise(() => {});
      if (!options.noExit)
        exit(options.exitCode === undefined ? 0 : options.exitCode, options.signal ?? null);
    },
  };
  const chromium = {
    async launchPersistentContext(profile, launchOptions) {
      launches.push({ profile, launchOptions });
      order.push("launch");
      if (!options.noSpawn) {
        const args = options.args ?? [`--user-data-dir=${profile}`];
        children.spawn(
          options.foreignExecutable ? "/foreign-chromium" : custody.receipt.executable,
          args,
          {
            env: options.foreignHome ? { HOME: "/foreign" } : launchOptions.env,
          },
        );
        if (options.duplicate)
          children.spawn(custody.receipt.executable, args, { env: launchOptions.env });
      }
      order.push("handshake");
      if (options.launchThrows) throw Error("Handshake failed");
      return owner;
    },
  };
  const exists = async () =>
    lstat(custody.privateRoot).then(
      () => true,
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
  return {
    custody,
    chromium,
    child,
    spawns,
    launches,
    failures,
    signals,
    order,
    exists,
    exit,
    previousSpawn,
    children,
    watchOptions: () => watchOptions,
    counts: () => ({ watchCount, terminateCount }),
    evidence,
    executable,
  };
}

test("public persistent launch preserves options, establishes early custody and normally cleans only owned HOME", async (t) => {
  const f = await fixture(t);
  const owner = await f.custody.launchPersistentContext(f.chromium, {
    headless: false,
    timeout: 30000,
    proxy: { server: "http://127.0.0.1:1234" },
  });
  assert.ok(owner.browser());
  assert.equal(f.launches[0].profile, f.custody.profile);
  assert.equal(f.launches[0].launchOptions.headless, false);
  assert.equal(f.launches[0].launchOptions.timeout, 30000);
  assert.deepEqual(f.launches[0].launchOptions.proxy, { server: "http://127.0.0.1:1234" });
  assert.equal(f.launches[0].launchOptions.serviceWorkers, "block");
  assert.equal(f.launches[0].launchOptions.env, f.custody.env);
  assert.ok(f.order.indexOf("watch-before-handshake") < f.order.indexOf("handshake"));
  assert.equal(f.children.spawn, f.previousSpawn);
  assert.equal(f.custody.env.OWNED_PROVIDER_SECRET, undefined);
  assert.equal(f.custody.env.HOME, path.join(f.custody.privateRoot, "home"));
  const r = await f.custody.settle();
  assert.equal(r, f.custody.receipt);
  assert.equal(r.status, "settled");
  assert.deepEqual(r.processExit, { code: 0, signal: null });
  assert.deepEqual(await f.custody.cleanupPrivateHome({ acceptancePassed: true }), {
    removed: true,
    retainedHome: null,
  });
  assert.equal(await f.exists(), false);
  assert.deepEqual(f.counts(), { watchCount: 1, terminateCount: 1 });
  assert.deepEqual(f.signals, []);
});

for (const [label, options] of [
  ["foreign HOME", { foreignHome: true }],
  ["foreign executable", { foreignExecutable: true }],
  ["foreign profile", { args: ["--user-data-dir=/foreign"] }],
  ["two profiles", { args: ["--user-data-dir=/one", "--user-data-dir=/two"] }],
  ["split profile switch", { args: ["--user-data-dir", "/foreign"] }],
])
  test(`${label} is rejected before native spawn and cannot delete HOME`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(f.custody.launchPersistentContext(f.chromium));
    await f.custody.settle();
    assert.equal(f.spawns.length, 0);
    assert.equal(f.children.spawn, f.previousSpawn);
    assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
    assert.equal(await f.exists(), true);
    assert.deepEqual(f.signals, []);
  });

test("duplicate capture rejects before starting another process", async (t) => {
  const f = await fixture(t, { duplicate: true });
  await assert.rejects(f.custody.launchPersistentContext(f.chromium), /Repeated/);
  await f.custody.settle();
  assert.equal(f.spawns.length, 1);
  assert.equal(f.counts().watchCount, 1);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

test("handshake rejection retains early child custody and original failure", async (t) => {
  const f = await fixture(t, { launchThrows: true });
  await assert.rejects(f.custody.launchPersistentContext(f.chromium), /Handshake failed/);
  await f.custody.settle();
  assert.match(f.custody.receipt.firstFailure.message, /Handshake failed/);
  assert.equal(f.counts().terminateCount, 1);
  assert.equal(f.children.spawn, f.previousSpawn);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

for (const options of [{ watchThrows: true }, { noSpawn: true }, { nullBrowser: true }])
  test(`missing authority or public Browser fails closed ${JSON.stringify(options)}`, async (t) => {
    const f = await fixture(t, options);
    await assert.rejects(f.custody.launchPersistentContext(f.chromium));
    await f.custody.settle();
    assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
    assert.equal(await f.exists(), true);
    assert.deepEqual(f.signals, []);
  });

for (const [label, options] of [
  ["close rejection", { closeThrows: true }],
  ["close never settles", { closeNever: true }],
  ["monitor rejection", { terminateThrows: true }],
  ["monitor never settles", { terminateNever: true }],
  ["missing actual exit", { noExit: true }],
  ["nonzero exit", { exitCode: 1 }],
  ["signal exit", { exitCode: null, signal: "SIGTERM" }],
  ["unproven identity", { settlement: { status: "unproven" } }],
])
  test(`${label} cannot pass or remove HOME; monitor still requested once`, async (t) => {
    const f = await fixture(t, options);
    await f.custody.launchPersistentContext(f.chromium);
    const [a, b] = await Promise.all([f.custody.settle(), f.custody.settle()]);
    assert.equal(a, b);
    assert.equal(f.counts().terminateCount, 1);
    assert.equal(a.status, "failed");
    assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
    assert.equal(await f.exists(), true);
  });

test("pure UI failure retains HOME despite normal exit and cleaned custody", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  await f.custody.settle();
  assert.equal(f.custody.receipt.status, "settled");
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: false })).removed, false);
  assert.equal(await f.exists(), true);
});

test("late known failure blocks cleanup even if driver passes an incorrect true gate", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  await f.custody.settle();
  f.custody.noteFailure("late ledger", Error("owned late failure"));
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
  assert.equal(await f.exists(), true);
});

test("durable early diagnostic failure prevents launch and retains private root", async (t) => {
  const f = await fixture(t, {
    onCheckpoint() {
      throw Error("owned report unavailable");
    },
  });
  await assert.rejects(f.custody.launchPersistentContext(f.chromium), /durable/);
  await f.custody.settle();
  assert.equal(f.spawns.length, 0);
  const saved = JSON.parse(await readFile(path.join(f.evidence, "browser-custody.json"), "utf8"));
  assert.equal(saved.recordingFailed, true);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

test("bounded logs record exact byte counts and truncation independently of normal exit", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  f.child.stdout.write(Buffer.alloc(1024 * 1024 + 17, 120));
  f.child.stderr.write(Buffer.from("owned stderr 中文"));
  await f.custody.settle();
  assert.deepEqual(f.custody.receipt.logs.stdout, {
    observedBytes: 1024 * 1024 + 17,
    retainedBytes: 1024 * 1024,
    truncated: true,
  });
  assert.equal(f.custody.logs().stdout.length, 1024 * 1024);
  assert.equal(f.custody.logs().stderr.toString("utf8"), "owned stderr 中文");
});

test("root watchdog signal cannot masquerade as normal graceful acceptance", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  f.watchOptions().signalProcess(f.child.pid, "SIGTERM");
  await f.custody.settle();
  assert.deepEqual(f.signals, [[f.child.pid, "SIGTERM"]]);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

test("cleanup refuses a replaced private root and retains the replacement", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  await f.custody.settle();
  await rm(f.custody.privateRoot, { recursive: true });
  await symlink(f.evidence, f.custody.privateRoot);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
  assert.equal((await lstat(f.custody.privateRoot)).isSymbolicLink(), true);
});

test("HOME removal rejection remains a failed retained outcome", async (t) => {
  const f = await fixture(t, {
    remove: async () => {
      throw Error("Owned rm failed");
    },
  });
  await f.custody.launchPersistentContext(f.chromium);
  await f.custody.settle();
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
  assert.equal(await f.exists(), true);
});

for (const [label, change] of [
  ["query failure", { queryFailed: true }],
  ["truncated evidence", { evidenceTruncated: true }],
  ["foreign root", { owned: [{ pid: 800001, ppid: process.pid, birth: "foreign" }] }],
  ["missing birth", { owned: [{ pid: 700001, ppid: process.pid, birth: "" }] }],
])
  test(`nominal cleaned settlement with ${label} cannot authorize cleanup`, async (t) => {
    const f = await fixture(t, {
      settlement: {
        status: "cleaned",
        owned: [{ pid: 700001, ppid: process.pid, birth: "owned" }],
        remaining: [],
        ownedCount: 1,
        remainingCount: 0,
        queryFailed: false,
        evidenceTruncated: false,
        ...change,
      },
    });
    await f.custody.launchPersistentContext(f.chromium);
    await f.custody.settle();
    assert.equal(f.custody.receipt.status, "failed");
    assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
  });

test("repeated public launch validation is latched without a second process", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  await assert.rejects(f.custody.launchPersistentContext(f.chromium), /Only one/);
  await f.custody.settle();
  assert.equal(f.spawns.length, 1);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

test("spawn checkpoint failure still retains the already acquired watchdog", async (t) => {
  const f = await fixture(t, {
    onCheckpoint(receipt) {
      if (receipt.timeline.at(-1).phase === "spawn-captured")
        throw Error("owned spawn receipt failure");
    },
  });
  await assert.rejects(f.custody.launchPersistentContext(f.chromium), /durable/);
  await f.custody.settle();
  assert.deepEqual(f.counts(), { watchCount: 1, terminateCount: 1 });
  assert.equal(f.children.spawn, f.previousSpawn);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

test("failure and timeline diagnostics stay bounded and truncation blocks cleanup", async (t) => {
  const f = await fixture(t);
  await f.custody.launchPersistentContext(f.chromium);
  f.custody.noteFailure("owned long failure", Error("x".repeat(5000)));
  assert.equal(f.custody.receipt.firstFailure.message.length, 4096);
  for (let i = 0; i < 140; i++) f.custody.checkpoint("owned bounded checkpoint");
  await f.custody.settle();
  assert.equal(f.custody.receipt.timeline.length, 128);
  assert.equal(f.custody.receipt.truncated, true);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});

test("browser bytes changed after resolver/factory pin are refused before spawn", async (t) => {
  const f = await fixture(t);
  await writeFile(f.executable, "Different owned binary; never executed.");
  await assert.rejects(f.custody.launchPersistentContext(f.chromium), /identity changed/);
  await f.custody.settle();
  assert.equal(f.spawns.length, 0);
  assert.equal((await f.custody.cleanupPrivateHome({ acceptancePassed: true })).removed, false);
});
