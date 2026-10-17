import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { readFileSync } from "node:fs";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { join } from "node:path";
import { test } from "node:test";
import vm from "node:vm";
import {
  createNsisCheckpointDiagnostics,
  NSIS_CHECKPOINT_LIMITS,
} from "./windows-nsis-checkpoint-diagnostics.mjs";
import { runNsisOwnedProcess } from "./smoke-windows-nsis-install.mjs";

const event = (sequence = 1, fields = {}) => ({
  sequence,
  elapsedMs: sequence * 2,
  phase: "nsis-build",
  kind: "stage-start",
  ...fields,
});
const detail = () => ({
  error: { name: "Error", message: "Original owned native failure" },
  status: "failed",
  child: { pid: 42, ppid: 8, birth: "2026-10-17T09:00:00.1234567Z" },
  cachedExit: { code: 1, signal: null },
  result: { code: 1, signal: null },
  logs: {
    stdout: { observedBytes: 0, retainedBytes: 0, truncated: false },
    stderr: { observedBytes: 0, retainedBytes: 0, truncated: false },
  },
  stderr: Buffer.alloc(0),
});
const capture = (options = {}) => {
  const buffers = [],
    failures = [];
  const mirror = createNsisCheckpointDiagnostics({
    write(bytes) {
      buffers.push(Buffer.from(bytes));
      return bytes.length;
    },
    recordingFailure(message) {
      failures.push(message);
    },
    ...options,
  });
  return { mirror, failures, buffers, rows: () => buffers.map((b) => JSON.parse(b.toString())) };
};

test("same checkpoint sequence/elapsed and fixed fields are mirrored without foreign payloads", () => {
  const value = capture();
  value.mirror.checkpoint(
    event(8, {
      label: "install",
      phase: "install",
      kind: "process-spawn",
      env: "foreign-env",
      argv: ["foreign-arg"],
    }),
  );
  assert.deepEqual(value.rows(), [
    {
      fixture: "owned-windows-nsis-checkpoint",
      schemaVersion: 1,
      sequence: 8,
      elapsedMs: 16,
      phase: "install",
      kind: "process-spawn",
      label: "install",
    },
  ]);
  assert.equal(value.mirror.receipt.writtenBytes, value.buffers[0].length);
  assert.equal(value.mirror.receipt.failed, false);
  assert.deepEqual(value.failures, []);
});

test("first native error includes bounded existing cached state and exact raw stderr suffix", () => {
  const value = capture(),
    data = detail();
  data.error = { name: "E".repeat(100), message: "中".repeat(4000) };
  data.stderr = Buffer.concat([Buffer.alloc(5000, 0xff), Buffer.from("owned terminal 中😀")]);
  data.logs.stderr = {
    observedBytes: data.stderr.length + 90,
    retainedBytes: data.stderr.length,
    truncated: true,
  };
  data.env = "not permitted";
  data.argv = ["not permitted"];
  value.mirror.checkpoint(event(1, { kind: "process-first-error", label: "nsis-build" }), data);
  const row = value.rows()[0];
  assert.equal(row.firstError.name.length, 80);
  assert.equal(row.firstError.message.length, 2048);
  assert.equal(row.process.status, "failed");
  assert.deepEqual(row.process.cachedExit, { code: 1, signal: null });
  assert.equal(row.process.child.birth, data.child.birth);
  assert.equal(row.stderrTail.bytes, 4096);
  assert.equal(row.stderrTail.truncated, true);
  assert.deepEqual(Buffer.from(row.stderrTail.data, "base64"), data.stderr.subarray(-4096));
  assert.equal(row.stderrTail.observedBytes, data.logs.stderr.observedBytes);
  assert.equal(JSON.stringify(row).includes("not permitted"), false);
});

test("outer first-error mirrors the original stored safe error rather than final generic assertion", () => {
  const value = capture();
  value.mirror.checkpoint(event(2, { phase: "installed-identity", kind: "first-error" }), {
    error: {
      phase: "installed-identity",
      name: "AssertionError",
      message: "Original registration mismatch",
      stack: "not permitted",
    },
  });
  assert.deepEqual(value.rows()[0].firstError, {
    name: "AssertionError",
    message: "Original registration mismatch",
  });
  assert.equal(value.rows()[0].phase, "installed-identity");
  assert.equal(JSON.stringify(value.rows()).includes("stack"), false);
});

test("event/UTF8 byte caps latch a failure, never write beyond cap or silently recover", () => {
  const counted = capture();
  for (let n = 1; n <= NSIS_CHECKPOINT_LIMITS.events + 2; n++) counted.mirror.checkpoint(event(n));
  assert.equal(counted.rows().length, 256);
  assert.equal(counted.mirror.receipt.failed, true);
  assert.equal(counted.failures.length, 1);
  const sized = capture(),
    data = detail();
  data.error.message = "中".repeat(2048);
  data.stderr = Buffer.alloc(4096, 0xf0);
  data.logs.stderr = { observedBytes: 4096, retainedBytes: 4096, truncated: false };
  for (let n = 1; n <= 256; n++)
    sized.mirror.checkpoint(event(n, { kind: "process-first-error", label: "install" }), data);
  assert.equal(sized.mirror.receipt.failed, true);
  assert.ok(sized.mirror.receipt.attemptedEvents < 256);
  assert.ok(Buffer.concat(sized.buffers).length <= 128 * 1024);
  assert.equal(sized.failures.length, 1);
});

test("writer throw/short write and hostile diagnostic inputs are swallowed and latched", () => {
  for (const write of [
    () => {
      throw Error("private writer error");
    },
    () => 0,
  ]) {
    const value = capture({ write });
    assert.doesNotThrow(() => value.mirror.checkpoint(event()));
    assert.equal(value.mirror.receipt.failed, true);
    assert.equal(value.failures.length, 1);
  }
  for (const malformed of [
    event(1, { phase: "foreign-phase" }),
    event(1, { kind: "foreign-kind" }),
    event(1, { label: "foreign-label" }),
    new Proxy(
      {},
      {
        get() {
          throw Error("private getter");
        },
      },
    ),
  ]) {
    const value = capture({
      recordingFailure() {
        throw Error("private sink error");
      },
    });
    assert.doesNotThrow(() => value.mirror.checkpoint(malformed));
    assert.equal(value.mirror.receipt.failed, true);
  }
  const value = capture();
  value.mirror.checkpoint(event(2));
  value.mirror.checkpoint(event(1));
  assert.equal(value.mirror.receipt.failed, true);
  const provider = capture();
  assert.doesNotThrow(() =>
    provider.mirror.checkpoint(event(1, { kind: "process-first-error", label: "install" }), () => {
      throw Error("private cached-state getter");
    }),
  );
  assert.equal(provider.mirror.receipt.failed, true);
  assert.equal(provider.buffers.length, 0);
});

test("the actual stage gate rejects a late mirror IO error despite returned operation progress", async () => {
  const ts = createRequire(import.meta.url)("typescript");
  const source = ts.createSourceFile(
    "fixture.mjs",
    readFileSync(new URL("./smoke-windows-nsis-install.mjs", import.meta.url), "utf8"),
    ts.ScriptTarget.Latest,
    true,
  );
  let initializer;
  const visit = (node) => {
    if (ts.isVariableDeclaration(node) && node.name.getText() === "at")
      initializer = node.initializer;
    ts.forEachChild(node, visit);
  };
  visit(source);
  assert.ok(initializer && ts.isArrowFunction(initializer));
  const report = { phase: "initial", operations: [], recordingFailures: [] };
  let writes = 0,
    sequence = 0,
    calls = 0;
  const mirror = createNsisCheckpointDiagnostics({
    write(bytes) {
      if (++writes === 2) throw Error("stdout closed after operation");
      return bytes.length;
    },
    recordingFailure(message) {
      report.recordingFailures.push(message);
    },
  });
  const at = vm.compileFunction(`return (${initializer.getText()})`, [
    "report",
    "assert",
    "checkpoint",
  ])(report, assert, (kind) => {
    mirror.checkpoint(event(++sequence, { phase: report.phase, kind }));
  });
  await assert.rejects(
    at("preflight", async () => {
      calls++;
      return "owned result";
    }),
  );
  assert.equal(calls, 1);
  assert.deepEqual(report.operations, [{ phase: "preflight", status: "passed" }]);
  assert.equal(report.recordingFailures.length, 1);
  assert.equal(mirror.receipt.failed, true);
});

async function failedOwnedProcess(writeFault = false) {
  const root = await mkdtemp(join(await realpath(tmpdir()), "codeshell-nsis-stdout-contract-"));
  const executable = join(root, "fake-owned-executable.txt");
  await writeFile(executable, "Never executed.\n");
  try {
    const child = Object.assign(new EventEmitter(), {
      pid: 42,
      exitCode: null,
      signalCode: null,
      stdout: new EventEmitter(),
      stderr: new EventEmitter(),
      unref() {},
    });
    const pinned = { pid: 42, ppid: process.pid, birth: "2026-10-17T09:00:00.1234567Z" };
    const settlement = {
      status: "cleaned",
      owned: [pinned],
      ownedCount: 1,
      remaining: [],
      remainingCount: 0,
      queryFailed: false,
      evidenceTruncated: false,
    };
    const order = [],
      records = [],
      failures = [];
    let sequence = 0;
    const mirror = createNsisCheckpointDiagnostics({
      write(bytes) {
        if (writeFault) throw Error("stdout closed");
        records.push(JSON.parse(bytes.toString()));
        order.push(records.at(-1).kind);
        return bytes.length;
      },
      recordingFailure(message) {
        failures.push(message);
      },
    });
    let resolve;
    const completed = new Promise((done) => {
      resolve = done;
    });
    const monitor = Object.assign(() => {}, {
      completed,
      terminate: async () => {
        order.push("actual-owned-terminate");
        return settlement;
      },
    });
    const report = { processes: [] };
    let caught;
    await runNsisOwnedProcess({
      executable,
      args: ["/S"],
      cwd: root,
      environment: { OWNED: "fixture" },
      label: "install",
      timeoutMs: 1000,
      report,
      takeSnapshot: () => [pinned],
      spawnProcess: () => child,
      checkpoint(kind, fields = {}, diagnostic) {
        mirror.checkpoint(event(++sequence, { phase: "install", kind, ...fields }), diagnostic);
      },
      watch(actual, options) {
        assert.equal(actual, child);
        options.snapshotProcesses();
        setImmediate(() => {
          child.stderr.emit("data", Buffer.from("already observed owned stderr\n"));
          child.exitCode = 1;
          child.emit("exit", 1, null);
          child.emit("close", 1, null);
          resolve(settlement);
        });
        return monitor;
      },
    }).catch((error) => {
      caught = error;
    });
    return { caught, report, order, records, failures, mirror: mirror.receipt };
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}
test("production process-first-error stdout is complete before the unchanged cleanup await", async () => {
  const value = await failedOwnedProcess();
  assert.ok(value.caught);
  const first = value.records.find((row) => row.kind === "process-first-error");
  assert.ok(first, "Original process error must reach CI stdout");
  assert.deepEqual(first.firstError, value.report.processes[0].failure);
  assert.deepEqual(first.process.result, { code: 1, signal: null });
  assert.deepEqual(first.process.cachedExit, { code: 1, signal: null });
  assert.equal(first.process.child.pid, 42);
  assert.equal(first.process.child.birth, "2026-10-17T09:00:00.1234567Z");
  assert.equal(
    Buffer.from(first.stderrTail.data, "base64").toString(),
    "already observed owned stderr\n",
  );
  assert.ok(
    value.order.indexOf("process-first-error") < value.order.indexOf("actual-owned-terminate"),
  );
  assert.deepEqual(value.failures, []);
});
test("stdout IO failure cannot skip production existing termination or create a normal pass", async () => {
  const value = await failedOwnedProcess(true);
  assert.ok(value.caught);
  assert.equal(value.report.processes[0].status, "failed");
  assert.equal(value.order.filter((x) => x === "actual-owned-terminate").length, 1);
  assert.equal(value.mirror.failed, true);
  assert.equal(value.failures.length, 1);
});
