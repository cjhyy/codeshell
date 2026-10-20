import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { test } from "node:test";
import { createPanelOperationDiagnostics } from "./panel-operation-diagnostics.mjs";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";

function fixture(t, options = {}) {
  const evidence = mkdtempSync(join(tmpdir(), "codeshell-panel-diagnostic-test-"));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const controller = new EventEmitter();
  const diagnostics = createPanelOperationDiagnostics({
    evidence,
    controller,
    ownedRoots: [evidence],
    ...options,
  });
  const read = () => JSON.parse(readFileSync(join(evidence, "diagnostics.json"), "utf8"));
  const journal = () =>
    readFileSync(join(evidence, "diagnostics.jsonl"), "utf8").trim().split("\n").map(JSON.parse);
  return { evidence, controller, diagnostics, read, journal };
}

function child() {
  return Object.assign(new EventEmitter(), {
    pid: 42,
    exitCode: null,
    signalCode: null,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
}

test("initial pending is durable and progress cannot assert a final acceptance", (t) => {
  const { diagnostics, read, journal } = fixture(t);
  assert.equal(read().status, "incomplete");
  assert.equal(read().main.exitObserved, null);
  diagnostics.phase("panel-image");
  diagnostics.caseCompleted("Owned PNG bytes returned", 1);
  assert.equal(read().completedCases.length, 1);
  assert.equal(read().finalReportWritten, false);
  assert.equal(read().acceptanceResult, undefined);
  assert.equal(journal()[0].kind, "initial-pending");
});

test("first original error is persisted synchronously before any screenshot or cleanup await", (t) => {
  const { diagnostics, read, evidence } = fixture(t);
  const main = child();
  diagnostics.observeChild(main);
  diagnostics.phase("panel-review-stage");
  const error = new Error("Original staged Review failure");
  error.stack = `Error: Original\n    at owned (${evidence}/fixture.mjs:12:3)\n    at foreign (/operator/private.js:5:1)`;
  diagnostics.error(error, main);
  const original = read().diagnostics.firstError;
  assert.equal(original.phase, "panel-review-stage");
  assert.equal(original.message, error.message);
  assert.equal(original.child.exitObserved, false);
  assert.match(original.stack, /fixture.mjs:12:3/);
  assert.doesNotMatch(original.stack, /operator/);
  diagnostics.phase("panel-graceful-close");
  diagnostics.error(new Error("Later close failure"), main);
  assert.deepEqual(read().diagnostics.firstError, original);
});

test("cached Main exit and cleanup ordering do not equate controller exit1 with Main crash", (t) => {
  const { diagnostics, read, journal, controller } = fixture(t);
  const main = child();
  diagnostics.observeChild(main);
  diagnostics.phase("panel-review-corrupt");
  diagnostics.error(new Error("UI wait failed"), main);
  const cleanup = diagnostics.cleanup("cycle-error", main);
  diagnostics.phase("panel-custody");
  diagnostics.request(cleanup, "monitor.terminate", main);
  main.exitCode = 1;
  main.emit("exit", 1, null);
  main.emit("close", 1, null);
  diagnostics.settled(cleanup, main);
  controller.emit("exit", 1);
  const value = read();
  assert.equal(value.status, "incomplete");
  assert.equal(value.finalReportWritten, false);
  assert.equal(value.diagnostics.firstError.child.exitObserved, false);
  assert.equal(value.diagnostics.cleanups[0].requests[0].before.exitObserved, false);
  assert.equal(value.diagnostics.cleanups[0].after.exitCode, 1);
  assert.match(value.controllerExit.boundary, /not the Main/);
  const records = journal();
  assert.ok(
    records.findIndex((x) => x.kind === "first-error") <
      records.findIndex((x) => x.kind === "cleanup-request"),
  );
  assert.ok(records.every((x, index) => !index || records[index - 1].sequence < x.sequence));
  assert.ok(records.every((x, index) => !index || records[index - 1].elapsedMs <= x.elapsedMs));
});

test("Main stream files retain bounded final bytes and truthful truncation metadata", (t) => {
  const { diagnostics, read, evidence } = fixture(t);
  const main = child();
  diagnostics.observeChild(main);
  assert.equal(statSync(join(evidence, "main.stdout.log")).size, 0);
  const data = Buffer.alloc(1024 * 1024 + 91, 97);
  main.stdout.emit("data", data);
  main.stdout.emit("data", Buffer.from("FINAL"));
  main.stderr.emit("data", Buffer.from("owned stderr"));
  assert.equal(statSync(join(evidence, "main.stdout.log")).size, 1024 * 1024);
  assert.equal(readFileSync(join(evidence, "main.stdout.log")).subarray(-5).toString(), "FINAL");
  assert.equal(read().logs.stdout.observedBytes, data.length + 5);
  assert.equal(read().logs.stdout.truncated, true);
  assert.equal(read().logs.stderr.truncated, false);
  if (process.platform !== "win32")
    assert.equal(statSync(join(evidence, "main.stderr.log")).mode & 0o777, 0o600);
});

test("hostile errors and diagnostic disk failures cannot stop the existing cleanup path", (t) => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw Error("Private getter data");
      },
    },
  );
  for (const error of [null, undefined, hostile]) {
    const { diagnostics, read } = fixture(t);
    diagnostics.phase("panel-graceful-close");
    assert.doesNotThrow(() => diagnostics.error(error));
    assert.ok(read().diagnostics.firstError);
    assert.doesNotMatch(JSON.stringify(read()), /Private getter data/);
  }
  const { diagnostics } = fixture(t, {
    io: {
      appendFileSync() {
        throw Error("disk full");
      },
      renameSync() {
        throw Error("disk full");
      },
      writeFileSync() {
        throw Error("disk full");
      },
    },
  });
  let cleanupCalled = false;
  assert.doesNotThrow(() => {
    diagnostics.error(hostile);
    const cleanup = diagnostics.cleanup("cycle-error");
    diagnostics.request(cleanup, "monitor.terminate");
    cleanupCalled = true;
    diagnostics.settled(cleanup);
  });
  assert.equal(cleanupCalled, true);
  assert.equal(diagnostics.receipt.recordingFailed, true);
});

test("failed final snapshot replacement preserves the prior pending snapshot and first-error journal", (t) => {
  let refuse = false;
  const { diagnostics, read, journal } = fixture(t, {
    io: {
      appendFileSync,
      writeFileSync,
      renameSync(...args) {
        if (refuse) throw Error("snapshot rename failed");
        return renameSync(...args);
      },
    },
  });
  diagnostics.phase("panel-final-report");
  refuse = true;
  diagnostics.error(new Error("Actual final report write failed"));
  assert.equal(read().status, "incomplete");
  assert.equal(read().finalReportWritten, false);
  assert.equal(
    journal().find((x) => x.kind === "first-error").observation.message,
    "Actual final report write failed",
  );
  assert.equal(diagnostics.receipt.recordingFailed, true);
});

test("records and raw error strings stay bounded without making progress passed", (t) => {
  const { diagnostics, read, evidence } = fixture(t);
  diagnostics.error(new Error("x".repeat(12000)));
  for (let index = 0; index < 400; index++) diagnostics.caseCompleted("case".repeat(100), index);
  assert.equal(read().diagnostics.firstError.message.length, 4096);
  assert.equal(read().completedCases.length, 20);
  assert.equal(read().journalTruncated, true);
  assert.ok(statSync(join(evidence, "diagnostics.jsonl")).size <= 512 * 1024);
  assert.equal(read().status, "incomplete");
  assert.doesNotThrow(() => diagnostics.phase("arbitrary unreviewed phase"));
  assert.equal(read().recordingFailed, true);
});

test("Keychain preflight rejection retains safe codes without private cause metadata", (t) => {
  const { diagnostics, read, evidence } = fixture(t);
  let failure;
  try {
    ensureElectronKeychainContext({
      home: evidence,
      environment: { HOME: evidence, USERPROFILE: evidence },
      platform: "darwin",
      operatorHome: join(evidence, "operator"),
      query() {
        throw Error("private-keychain-path ino=123 uid=456");
      },
    });
  } catch (error) {
    failure = error;
  }
  assert.ok(failure);
  diagnostics.phase("harness-preflight");
  diagnostics.error(failure);
  assert.equal(
    read().diagnostics.firstError.message,
    "Keychain metadata preflight refused startup",
  );
  assert.equal(read().diagnostics.firstError.stack, "");
  assert.doesNotMatch(JSON.stringify(read()), /private-keychain-path|ino=123|uid=456/);
});

test("an actual owned Node controller exit1 leaves durable incomplete evidence without a Main claim", (t) => {
  const evidence = mkdtempSync(join(tmpdir(), "codeshell-panel-controller-exit-test-"));
  t.after(() => rmSync(evidence, { recursive: true, force: true }));
  const moduleURL = new URL("./panel-operation-diagnostics.mjs", import.meta.url).href;
  const result = spawnSync(
    process.execPath,
    [
      "--input-type=module",
      "--eval",
      `import {createPanelOperationDiagnostics} from ${JSON.stringify(moduleURL)}; const d=createPanelOperationDiagnostics({evidence:${JSON.stringify(evidence)}}); d.phase("panel-review-stage"); d.error(new Error("Owned driver exit probe")); process.exit(1);`,
    ],
    { env: process.env, encoding: "utf8" },
  );
  assert.equal(result.status, 1);
  assert.equal(result.signal, null);
  const value = JSON.parse(readFileSync(join(evidence, "diagnostics.json"), "utf8"));
  assert.equal(value.status, "incomplete");
  assert.equal(value.controllerExit.code, 1);
  assert.equal(value.main.pid, null);
  assert.equal(value.main.exitObserved, null);
  assert.equal(value.diagnostics.firstError.phase, "panel-review-stage");
});
