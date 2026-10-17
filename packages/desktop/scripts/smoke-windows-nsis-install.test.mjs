import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PassThrough } from "node:stream";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { parseNsisArguments, runNsisOwnedProcess } from "./smoke-windows-nsis-install.mjs";

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
