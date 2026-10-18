import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseNsisArguments, runNsisOwnedProcess } from "./smoke-windows-nsis-install.mjs";
import {
  NSIS_LEFTOVER_LIMITS,
  observeNsisUninstallLeftovers,
} from "./windows-nsis-leftover-metadata.mjs";

const fixture = async (action) => {
  const root = await mkdtemp(join(await realpath(tmpdir()), "codeshell-nsis-node-contract-"));
  const executable = join(root, "fake-owned-executable.txt");
  await writeFile(executable, "Pure fixture bytes; never executed.\n");
  try {
    return await action({ root, executable });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};
const setup = (
  { root, executable },
  { code = 0, watchError, output = Buffer.from("owned log\n") } = {},
) => {
  const child = new EventEmitter();
  Object.assign(child, {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: () => {
      child.unreferenced = true;
    },
  });
  const birth = "2026-10-17T09:00:00.1234567Z";
  const pinned = { pid: child.pid, ppid: process.pid, birth };
  const settlement = {
    status: "cleaned",
    owned: [pinned],
    ownedCount: 1,
    remaining: [],
    remainingCount: 0,
    queryFailed: false,
    evidenceTruncated: false,
  };
  const report = { processes: [] },
    events = [];
  let settle,
    optionsSeen,
    terminated = 0,
    stopped = 0;
  const completed = new Promise((resolve) => {
    settle = resolve;
  });
  const monitor = Object.assign(
    () => {
      stopped++;
    },
    {
      completed,
      terminate: async () => {
        terminated++;
        events.push("actual-owned-terminate");
        return settlement;
      },
    },
  );
  const options = {
    executable,
    args: ["/S", "/currentuser", "/D=D:\\owned\\installation"],
    cwd: root,
    environment: { OWNED: "fixture" },
    timeoutMs: 1_000,
    label: "fixture",
    report,
    checkpoint: (kind) => events.push(kind),
    takeSnapshot: () => [pinned],
    spawnProcess: (_file, _args, spawnOptions) => {
      optionsSeen = spawnOptions;
      return child;
    },
    watch: (actual, options) => {
      assert.equal(actual, child);
      assert.deepEqual(options.snapshotProcesses(), [pinned]);
      if (watchError !== undefined) throw watchError;
      setImmediate(() => {
        child.stdout.end(output);
        child.stderr.end();
        child.exitCode = code;
        child.emit("exit", code, null);
        child.emit("close", code, null);
        settle(settlement);
      });
      return monitor;
    },
  };
  return {
    options,
    child,
    report,
    events,
    settlement,
    observed: () => ({ optionsSeen, terminated, stopped }),
  };
};

test("owned process capture pins exact parent/full birth before await and keeps direct Node options", () =>
  fixture(async (paths) => {
    const value = setup(paths);
    const operation = await runNsisOwnedProcess(value.options);
    assert.equal(operation.status, "passed");
    assert.deepEqual(operation.child, {
      pid: 42,
      ppid: process.pid,
      birth: "2026-10-17T09:00:00.1234567Z",
      boundary: "ChildProcess PID; birth authority is exclusively the watchdog's fresh snapshot",
    });
    assert.equal(operation.result.code, 0);
    assert.deepEqual(value.observed(), {
      optionsSeen: {
        cwd: paths.root,
        env: { OWNED: "fixture" },
        shell: false,
        windowsVerbatimArguments: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      },
      terminated: 0,
      stopped: 1,
    });
    assert.equal(await readFile(join(paths.root, "fixture.stdout.log"), "utf8"), "owned log\n");
    assert.equal(operation.command.sha256.length, 64);
  }));

test("a native nonzero exit records first error before existing cleanup and cannot advance", () =>
  fixture(async (paths) => {
    const value = setup(paths, { code: 1 });
    let next = false;
    await assert.rejects(async () => {
      await runNsisOwnedProcess(value.options);
      next = true;
    });
    assert.equal(next, false);
    assert.equal(value.report.processes[0].status, "failed");
    assert.equal(value.report.processes[0].result.code, 1);
    assert.equal(value.observed().terminated, 1);
    assert.ok(
      value.events.indexOf("process-first-error") < value.events.indexOf("actual-owned-terminate"),
    );
  }));

test("missing birth authority never signals or closes a child and marks retained state unproven", () =>
  fixture(async (paths) => {
    const value = setup(paths, { watchError: Error("No owned birth") });
    await assert.rejects(runNsisOwnedProcess(value.options), /No owned birth/);
    assert.equal(value.child.unreferenced, true);
    assert.equal(value.report.unprovenProcess, true);
    assert.equal(value.observed().terminated, 0);
    assert.deepEqual(value.report.processes[0].signalRequests, []);
  }));

test("arbitrary caught values cannot bypass existing cleanup or corrupt the original failure", () =>
  fixture(async (paths) => {
    const thrown = {
      get message() {
        throw Error("getter");
      },
      get name() {
        throw Error("getter");
      },
    };
    const value = setup(paths);
    value.options.watch = (child, options) => {
      options.snapshotProcesses();
      const completed = Promise.resolve(value.settlement);
      // The failure originates after custody is acquired: child completion error.
      setImmediate(() => child.emit("error", thrown));
      return Object.assign(() => {}, {
        completed,
        terminate: async () => {
          value.events.push("actual-owned-terminate");
          return value.settlement;
        },
      });
    };
    await assert.rejects(runNsisOwnedProcess(value.options));
    assert.equal(value.report.processes[0].result.error, "Caught value could not be described");
    assert.ok(
      value.events.indexOf("process-first-error") < value.events.indexOf("actual-owned-terminate"),
    );
  }));

test("a cleaned foreign incarnation or incomplete owned count is still a failure", () =>
  fixture(async (paths) => {
    const value = setup(paths);
    value.settlement.owned = [
      { pid: 42, ppid: process.pid, birth: "2026-10-17T09:00:01.1234567Z" },
    ];
    await assert.rejects(runNsisOwnedProcess(value.options));
    assert.equal(value.report.processes[0].status, "failed");
    assert.equal(value.observed().terminated, 1);
  }));

test("stdout evidence is a bounded tail with explicit truncation and actual observed byte count", () =>
  fixture(async (paths) => {
    const bytes = Buffer.alloc(1024 * 1024 + 31, 120);
    const value = setup(paths, { output: bytes });
    const operation = await runNsisOwnedProcess(value.options);
    assert.deepEqual(operation.logs.stdout, {
      observedBytes: bytes.length,
      retainedBytes: 1024 * 1024,
      truncated: true,
    });
    assert.equal((await readFile(join(paths.root, "fixture.stdout.log"))).length, 1024 * 1024);
  }));

test("CLI rejects non-hosted use before changing an existing caller directory", () =>
  fixture(async (paths) => {
    const marker = join(paths.root, "caller-owned.txt");
    await writeFile(marker, "preserve\n");
    const result = spawnSync(
      process.execPath,
      [
        fileURLToPath(new URL("./smoke-windows-nsis-install.mjs", import.meta.url)),
        "--build-receipt",
        join(paths.root, "absent.json"),
        "--evidence-dir",
        paths.root,
      ],
      {
        env: { ...process.env, GITHUB_ACTIONS: "false" },
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.equal(await readFile(marker, "utf8"), "preserve\n");
    await assert.rejects(readFile(join(paths.root, "receipt.json")), { code: "ENOENT" });
  }));

test("CLI has only the finite build-receipt/evidence interface", () => {
  assert.ok(
    parseNsisArguments(["--build-receipt", "/owned/build.json", "--evidence-dir", "/owned/new"])
      .buildReceipt,
  );
  for (const args of [
    [],
    ["--build-receipt"],
    ["--build-receipt", "x", "--evidence-dir", "y", "--force", "1"],
    ["--build-receipt", "x", "--build-receipt", "y"],
  ])
    assert.throws(() => parseNsisArguments(args));
});

const metadataInfo = (type, { ino = 2n, size = 0n, time = 1n } = {}) => ({
  dev: 1n,
  ino,
  mode: type === "directory" ? 0o40700n : type === "link" ? 0o120700n : 0o100600n,
  mtimeNs: time,
  ctimeNs: time,
  size,
  isSymbolicLink: () => type === "link",
  isDirectory: () => type === "directory",
  isFile: () => type === "file",
});
const metadataFixture = (entries = []) => {
  const root = join(tmpdir(), "codeshell-inert-leftover-contract");
  const installation = join(root, "code-shell");
  const seen = [],
    directoryInfo = metadataInfo("directory");
  let index = 0;
  const directory = {
    read: async () => {
      seen.push("read");
      const entry = entries[index++];
      return entry ? { name: entry.name } : null;
    },
    close: async () => seen.push("close"),
  };
  const io = {
    lstat: async (path) => {
      seen.push(["lstat", path]);
      if (path === installation) return directoryInfo;
      if (dirname(path) !== installation) return metadataInfo("directory", { ino: 1n });
      const entry = entries.find((entry) => join(installation, entry.name) === path);
      return entry?.info ?? metadataInfo("directory", { ino: 1n });
    },
    realpath: async (path) => {
      seen.push(["realpath", path]);
      return path;
    },
    opendir: async (path) => {
      seen.push(["opendir", path]);
      assert.equal(path, installation, "No child directory or link may be opened");
      return directory;
    },
  };
  return { root, installation, io, directory, directoryInfo, seen };
};

test("post-uninstall metadata observes actual empty and direct-child owned directories without contents", () =>
  fixture(async ({ root }) => {
    const installation = join(root, "code-shell");
    await mkdir(installation);
    const empty = await observeNsisUninstallLeftovers({ root, installation });
    assert.equal(empty.status, "observed");
    assert.equal(empty.complete, true);
    assert.deepEqual(empty.entries, []);
    await mkdir(join(installation, "nested"));
    await writeFile(join(installation, "nested", "not-enumerated.txt"), "never read\n");
    await writeFile(join(installation, "中文 file.txt"), "owned bytes\n");
    const value = await observeNsisUninstallLeftovers({ root, installation });
    assert.equal(value.status, "observed");
    assert.equal(value.complete, true);
    assert.deepEqual(value.entries, [
      { relativeName: "nested", type: "directory" },
      { relativeName: "中文 file.txt", type: "file", size: 12 },
    ]);
    assert.equal(await readFile(join(installation, "中文 file.txt"), "utf8"), "owned bytes\n");
    assert.ok(Buffer.byteLength(JSON.stringify(value)) <= NSIS_LEFTOVER_LIMITS.bytes);
  }));

test("post-uninstall metadata never follows root links or opens direct-child directories and links", async () => {
  const value = metadataFixture([
    { name: "directory", info: metadataInfo("directory") },
    { name: "external-link", info: metadataInfo("link") },
    { name: "file", info: metadataInfo("file", { size: 4n }) },
  ]);
  const result = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
  assert.equal(result.status, "observed");
  assert.deepEqual(result.entries, [
    { relativeName: "directory", type: "directory" },
    { relativeName: "external-link", type: "link" },
    { relativeName: "file", type: "file", size: 4 },
  ]);
  assert.deepEqual(
    value.seen.filter((row) => Array.isArray(row) && row[0] === "opendir"),
    [["opendir", value.installation]],
  );
  const linked = metadataFixture();
  const original = linked.io.lstat;
  linked.io.lstat = (path) =>
    path === linked.installation ? Promise.resolve(metadataInfo("link")) : original(path);
  const refused = await observeNsisUninstallLeftovers(linked, { io: linked.io, now: () => 0 });
  assert.equal(refused.status, "unknown");
  assert.equal(refused.rootType, "link");
  assert.equal(refused.reason, "root-not-directory");
  assert.equal(
    linked.seen.some((row) => Array.isArray(row) && row[0] === "opendir"),
    false,
  );
});

test("post-uninstall metadata refuses foreign installation before IO and canonical parent aliases before open", async () => {
  const value = metadataFixture();
  const wrong = await observeNsisUninstallLeftovers(
    { root: value.root, installation: join(dirname(value.root), "foreign") },
    { io: value.io, now: () => 0 },
  );
  assert.equal(wrong.status, "unknown");
  assert.equal(wrong.reason, "owned-path");
  assert.deepEqual(value.seen, []);
  value.io.realpath = async () => join(value.root, "alias");
  const alias = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
  assert.equal(alias.status, "unknown");
  assert.equal(alias.reason, "parent-alias");
  assert.equal(
    value.seen.some((row) => Array.isArray(row) && row[0] === "opendir"),
    false,
  );
});

test("post-uninstall metadata reports missing, renamed and replaced identities as unknown", async () => {
  for (const mode of ["missing", "root-swap", "directory-change", "parent-swap"]) {
    const value = metadataFixture();
    const original = value.io.lstat;
    let rootReads = 0,
      parentReads = 0;
    value.io.lstat = async (path) => {
      if (path === value.installation) {
        rootReads++;
        if (mode === "missing") throw Object.assign(Error("private"), { code: "ENOENT" });
        if (mode === "root-swap" && rootReads === 2) return metadataInfo("directory", { ino: 3n });
        if (mode === "directory-change" && rootReads === 3)
          return metadataInfo("directory", { time: 2n });
      }
      if (path === value.root && ++parentReads === 2 && mode === "parent-swap")
        return metadataInfo("directory", { ino: 7n });
      return original(path);
    };
    const result = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
    assert.equal(result.status, "unknown", mode);
    assert.equal(result.complete, false, mode);
    assert.equal(JSON.stringify(result).includes("private"), false);
    assert.equal(value.seen.filter((row) => row === "close").length, mode === "missing" ? 0 : 1);
  }
});

test("post-uninstall metadata waits for pending read and close beyond its explicit soft deadline", async () => {
  const value = metadataFixture();
  let clock = 0,
    releaseRead,
    releaseClose,
    markRead,
    markClose,
    settled = false;
  const readStarted = new Promise((resolve) => (markRead = resolve));
  const closeStarted = new Promise((resolve) => (markClose = resolve));
  value.directory.read = async () => {
    markRead();
    await new Promise((resolve) => (releaseRead = resolve));
    value.seen.push("read-finished");
    return null;
  };
  value.directory.close = async () => {
    markClose();
    await new Promise((resolve) => (releaseClose = resolve));
    value.seen.push("close-finished");
  };
  const pending = observeNsisUninstallLeftovers(value, { io: value.io, now: () => clock }).then(
    (result) => {
      settled = true;
      return result;
    },
  );
  await readStarted;
  clock = NSIS_LEFTOVER_LIMITS.softDeadlineMs + 1;
  assert.equal(settled, false);
  releaseRead();
  await closeStarted;
  assert.equal(settled, false);
  releaseClose();
  const result = await pending;
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "soft-deadline");
  assert.deepEqual(value.seen.slice(-2), ["read-finished", "close-finished"]);
});

test("post-uninstall metadata entry and serialized byte caps are explicit and close the iterator", async () => {
  for (const mode of ["entries", "bytes"]) {
    const names = Array.from({ length: 129 }, (_, index) => ({
      name: String(index).padStart(3, "0") + (mode === "bytes" ? "中".repeat(252) : ""),
      info: metadataInfo("file"),
    }));
    const value = metadataFixture(names);
    const result = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
    assert.equal(result.status, "unknown");
    assert.equal(result.complete, false);
    assert.equal(result.reason, mode === "entries" ? "entry-limit" : "byte-limit");
    assert.ok(result.entries.length <= 128);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
    assert.equal(value.seen.filter((row) => row === "close").length, 1);
  }
});

test("post-uninstall metadata IO and close errors stay bounded unknown without raw causes", async () => {
  for (const step of ["opendir", "read", "child-lstat", "close"]) {
    const value = metadataFixture([{ name: "file", info: metadataInfo("file") }]);
    const failure = () => {
      throw Error("SECRET original path and environment");
    };
    if (step === "opendir") value.io.opendir = failure;
    else if (step === "child-lstat") {
      const original = value.io.lstat;
      value.io.lstat = (path) =>
        path === join(value.installation, "file") ? failure() : original(path);
    } else value.directory[step] = failure;
    const result = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
    assert.equal(result.status, "unknown", step);
    assert.equal(result.complete, false, step);
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.ok(Buffer.byteLength(JSON.stringify(result)) <= 64 * 1024);
  }
});

test("post-uninstall metadata rejects unsafe names and non-safe size without reading content", async () => {
  for (const name of ["..", "../foreign", "foreign\\file", "file:stream", "nul", "file."]) {
    const value = metadataFixture([{ name, info: metadataInfo("file") }]);
    const result = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, "unsafe-name");
    assert.deepEqual(result.entries, []);
  }
  const value = metadataFixture([
    { name: "huge", info: metadataInfo("file", { size: BigInt(Number.MAX_SAFE_INTEGER) + 1n }) },
  ]);
  const result = await observeNsisUninstallLeftovers(value, { io: value.io, now: () => 0 });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "metadata");
  const source = await readFile(
    new URL("./windows-nsis-leftover-metadata.mjs", import.meta.url),
    "utf8",
  );
  assert.doesNotMatch(
    source,
    /\b(?:readFile|readlink|unlink|rmdir|rename|spawn|execFile|setTimeout)\b/,
  );
  assert.doesNotMatch(source, /Promise\.race/);
});

test("actual outer catch preserves first error before one specific absence diagnostic await", async () => {
  const source = (
    await readFile(new URL("./smoke-windows-nsis-install.mjs", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const begin = source.indexOf('  } catch (error) {\n    report.status = "failed";');
  const boundary = "\n  } finally {";
  const end = source.indexOf(boundary, begin) + 1;
  assert.ok(begin > 0 && end > begin);
  assert.equal(source.indexOf(boundary, end), -1);
  const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
  const run = new AsyncFunction(
    "error",
    "report",
    "safeError",
    "checkpoint",
    "process",
    "postUninstallAbsenceFailed",
    "postUninstallAbsenceError",
    "observeNsisUninstallLeftovers",
    "root",
    "join",
    "NSIS_IDENTITY",
    "collectNsisCrashEvidence",
    "ci",
    "environment",
    "writeExclusive",
    "recordingFailure",
    source.slice(begin + "  } catch (error) {".length, end),
  );
  for (const mode of [
    "matched",
    "flag-false",
    "different",
    "undefined-earlier",
    "undefined-gate",
  ]) {
    const original = mode.startsWith("undefined") ? undefined : Error("original absence failure");
    const tagged = !["flag-false", "undefined-earlier"].includes(mode);
    const trigger = tagged && mode !== "different";
    const expectedMessage = original?.message ?? "Unknown caught value";
    const report = { phase: "uninstall", failures: [] };
    const fakeProcess = { exitCode: 0 },
      order = [];
    await run(
      original,
      report,
      (error) => {
        assert.equal(error, original);
        return { name: error?.name ?? "Error", message: error?.message ?? "Unknown caught value" };
      },
      (kind, _fields, diagnostic) => {
        assert.equal(kind, "first-error");
        assert.equal(diagnostic.error, report.firstError);
        order.push("persisted-first-error");
      },
      fakeProcess,
      tagged,
      mode === "different" ? Error("different earlier failure") : original,
      async ({ root, installation }) => {
        assert.equal(fakeProcess.exitCode, 1);
        assert.equal(report.firstError.message, expectedMessage);
        assert.deepEqual(order, ["persisted-first-error"]);
        assert.equal(installation, join(root, "code-shell"));
        order.push("metadata-only-observation");
        return { status: "unknown" };
      },
      join(tmpdir(), "inert-owned-root"),
      join,
      { product: "code-shell" },
      () => assert.fail("Install-only native event query cannot run"),
      {},
      {},
      () => assert.fail("No new public artifact is written"),
      () => assert.fail("No recording failure expected"),
    );
    assert.equal(report.status, "failed");
    assert.equal(report.failures.length, 1);
    assert.equal(report.failures[0], report.firstError);
    assert.equal(report.firstError.message, expectedMessage);
    assert.equal(fakeProcess.exitCode, 1);
    assert.deepEqual(
      order,
      trigger ? ["persisted-first-error", "metadata-only-observation"] : ["persisted-first-error"],
    );
  }
  assert.match(
    source,
    /try \{\n {8}await absent\(installation\);\n {6}\} catch \(error\) \{\n {8}postUninstallAbsenceFailed = true;\n {8}postUninstallAbsenceError = error;\n {8}throw error;/,
  );
});


test("production replacement forwards the exact role observer without a desktop collector wrapper", async () => {
  const source = (
    await readFile(new URL("./smoke-windows-nsis-install.mjs", import.meta.url), "utf8")
  ).replace(/\r\n/g, "\n");
  const start = "export async function runNsisOwnedProcess({";
  const end = "\nexport async function runWindowsNsisAcceptance(args) {";
  assert.equal(source.split(start).length, 2);
  assert.equal(source.split(end).length, 2);
  const runner = source.slice(source.indexOf(start) + "export ".length, source.indexOf(end));
  const compileRunner = new Function(
    "assert",
    "spawn",
    "watchElectronTestProcess",
    "snapshotElectronTestProcesses",
    "createNsisReplacementRoleObserver",
    "MAX_LOG",
    "BUDGETS",
    "join",
    "writeFileSync",
    "plainFile",
    "safeError",
    "assertNormalNsisProcess",
    "process",
    "setTimeout",
    "clearTimeout",
    `return (${runner});`,
  );
  const denied = (name) => () => assert.fail(`Unexpected real adapter: ${name}`);
  const child = Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    unref: denied("unref without custody"),
  });
  const pinned = { pid: 42, ppid: 99, birth: "2026-10-18T06:00:00.1234567Z" };
  const settlement = {
    status: "cleaned",
    owned: [pinned],
    ownedCount: 1,
    remaining: [],
    remainingCount: 0,
    queryFailed: false,
    evidenceTruncated: false,
  };
  const report = { processes: [] };
  const environment = { OWNED: "inert replacement fixture" };
  const replacementRoles = {
    root: "inert-owned-root",
    setup: "inert-owned-setup.exe",
    uninstaller: "inert-owned-uninstaller.exe",
    temporary: "inert-owned-tmp",
  };
  const roleCalls = [];
  const roleObserver = {
    receipt: { sampleCount: 0, samples: [] },
    snapshot: () => [pinned],
    onOwnedSnapshot: (value) => roleCalls.push(value),
    markFailure: denied("role failure on normal operation"),
  };
  const logFiles = new Map();
  const filePin = { size: 1, sha256: "a".repeat(64) };
  const timer = {};
  let settle;
  const completed = new Promise((resolve) => {
    settle = resolve;
  });
  let roleCreations = 0,
    watches = 0,
    normalChecks = 0,
    stopped = 0;
  const run = compileRunner(
    assert,
    denied("default spawn"),
    denied("default watchdog"),
    denied("default process snapshot"),
    (options) => {
      roleCreations++;
      assert.deepEqual(options, { ...replacementRoles, environment });
      return roleObserver;
    },
    1024 * 1024,
    { closeAfterCustody: 5000 },
    join,
    (path, bytes) => logFiles.set(path, Buffer.from(bytes)),
    async () => filePin,
    (error) => ({ name: error.name, message: error.message }),
    (operation) => {
      normalChecks++;
      assert.deepEqual(operation.result, { code: 0, signal: null });
      assert.equal(operation.settlement, settlement);
      assert.deepEqual(operation.errors, []);
      assert.deepEqual(operation.signalRequests, []);
    },
    { pid: 99, kill: denied("process.kill") },
    (_callback, delay) => {
      assert.equal(delay, 5000);
      return timer;
    },
    (value) => assert.equal(value, timer),
  );
  const sample = { phase: "owned-sample", rows: [pinned] };
  const operation = await run({
    executable: "inert-owned-setup.exe",
    args: ["/S", "/currentuser", "/D=inert-owned-root"],
    environment,
    cwd: "inert-owned-root",
    label: "replace",
    timeoutMs: 180_000,
    report,
    checkpoint: () => {},
    replacementRoles,
    // A previously forwarded legacy option must not wrap the role callback.
    replacementDesktopObservation: { observe: denied("desktop collector observation") },
    spawnProcess: () => child,
    takeSnapshot: denied("direct process snapshot with role observer"),
    watch: (actual, options) => {
      watches++;
      assert.equal(actual, child);
      assert.equal(options.timeoutMs, 180_000);
      assert.equal(options.onOwnedSnapshot, roleObserver.onOwnedSnapshot);
      assert.deepEqual(options.snapshotProcesses(), [pinned]);
      options.onOwnedSnapshot(sample);
      queueMicrotask(() => {
        child.exitCode = 0;
        child.emit("exit", 0, null);
        child.emit("close", 0, null);
        settle(settlement);
      });
      return Object.assign(() => stopped++, {
        completed,
        terminate: denied("cleanup fallback on normal operation"),
      });
    },
  });
  assert.equal(roleCreations, 1);
  assert.equal(watches, 1);
  assert.equal(normalChecks, 1);
  assert.equal(stopped, 1);
  assert.deepEqual(roleCalls, [sample]);
  assert.equal(operation.status, "passed");
  assert.equal(operation.child.birth, pinned.birth);
  assert.equal(operation.roleObservation, roleObserver.receipt);
  assert.equal(report.unprovenProcess, undefined);
  assert.equal(logFiles.size, 2, "Only the two inert initial logs are recorded");
});
