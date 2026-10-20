import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createElectronTestDiagnostics, observeElectronDiagnostic } from "./electron-harness.mjs";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";
import {
  assertStartupCycleSettled,
  resolveStartupEvidence,
  startupMainLogErrors,
} from "./e2e-startup-operation-cycles.mjs";

const proof = () => ({
  pid: 42,
  guard: { mainPid: 42, workerCreated: false },
  exit: { code: 0, signal: null },
  settlement: { status: "cleaned", queryFailed: false, remainingCount: 0 },
  observerFailures: [],
  rendererErrors: [],
  mainErrors: [],
  deniedAttempts: [],
  spawnedWorkers: [],
});

test("diagnostics distinguish worker-guard and runtime errors without overwriting the first failure", () => {
  const diagnostics = createElectronTestDiagnostics({ ownedRoots: ["/owned"] });
  const child = { pid: 42, exitCode: null, signalCode: null };
  diagnostics.phase("startup-worker-guard");
  diagnostics.error(new Error("Guard IPC failure"), child);
  diagnostics.phase("startup-runtime");
  diagnostics.error(new Error("Runtime IPC failure"), child);
  assert.equal(diagnostics.receipt.firstError.phase, "startup-worker-guard");
  assert.equal(diagnostics.receipt.firstError.message, "Guard IPC failure");
  assert.equal(diagnostics.receipt.firstError.child.exitObserved, false);
  assert.throws(() => diagnostics.phase("arbitrary payload"), /Unknown Electron diagnostic phase/);
});

test("diagnostic errors cannot throw for null, undefined or hostile error getters", () => {
  const hostile = new Proxy(
    {},
    {
      get() {
        throw new Error("Private getter detail");
      },
    },
  );
  for (const value of [null, undefined, "string rejection", hostile]) {
    const diagnostics = createElectronTestDiagnostics();
    diagnostics.phase("harness-main-identity");
    assert.doesNotThrow(() => diagnostics.error(value));
    assert.equal(diagnostics.receipt.firstError.child.exitObserved, null);
    assert.doesNotMatch(JSON.stringify(diagnostics.receipt), /Private getter detail/);
  }
  const observer = {
    receipt: {},
    error() {
      throw Error("Diagnostic failure");
    },
    cleanup() {
      throw Error("Diagnostic failure");
    },
  };
  assert.doesNotThrow(() => observeElectronDiagnostic(observer, "error", hostile));
  assert.doesNotThrow(() => observeElectronDiagnostic(observer, "cleanup", "harness-error"));
  assert.equal(observer.receipt.recordingFailed, true);
});

test("diagnostic records stay bounded and cannot turn a cleanup exit1 into a passing cycle", () => {
  const diagnostics = createElectronTestDiagnostics();
  diagnostics.phase("startup-custody");
  for (let i = 0; i < 400; i++) diagnostics.signal(42, "SIGTERM");
  assert.equal(diagnostics.receipt.timeline.length, 256);
  assert.equal(diagnostics.receipt.signals.length, 256);
  assert.equal(diagnostics.receipt.truncated, true);
  const value = proof();
  value.exit.code = 1;
  value.diagnostics = diagnostics.receipt;
  assert.throws(() => assertStartupCycleSettled(value), /Main must exit normally/);
});

test("Keychain diagnostic stacks do not expose private metadata or raw causes", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-startup-diagnostic-test-")));
  try {
    const home = join(root, "home"),
      operatorHome = join(root, "operator");
    await mkdir(home, { mode: 0o700 });
    await mkdir(operatorHome, { mode: 0o700 });
    let failure;
    try {
      ensureElectronKeychainContext({
        home,
        environment: { HOME: home, USERPROFILE: home },
        platform: "darwin",
        operatorHome,
        query() {
          throw Error("private-keychain-path ino=123 uid=456");
        },
      });
    } catch (error) {
      failure = error;
    }
    assert.ok(failure);
    const diagnostics = createElectronTestDiagnostics({ ownedRoots: [root] });
    diagnostics.phase("harness-preflight");
    diagnostics.error(failure);
    assert.equal(
      diagnostics.receipt.firstError.message,
      "Keychain metadata preflight refused startup",
    );
    assert.ok(diagnostics.receipt.firstError.keychainDiagnostic);
    assert.equal(diagnostics.receipt.firstError.stack, "");
    assert.doesNotMatch(
      JSON.stringify(diagnostics.receipt),
      /private-keychain-path|ino=123|uid=456/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a cycle is ready to advance only with guarded normal exit and settled custody", () => {
  assertStartupCycleSettled(proof());
  for (const mutate of [
    (value) => (value.guard.mainPid = 99),
    (value) => (value.guard.workerCreated = true),
    (value) => (value.exit.code = 1),
    (value) => (value.exit.signal = "SIGTERM"),
    (value) => (value.settlement.status = "unproven"),
    (value) => (value.settlement.queryFailed = true),
    (value) => (value.settlement.remainingCount = 1),
    (value) => value.observerFailures.push("query failed"),
    (value) => value.rendererErrors.push("late renderer error"),
    (value) => value.mainErrors.push("legacy-project-migration-completion-error"),
    (value) => value.deniedAttempts.push({ pid: 42, kind: "worker" }),
    (value) => value.spawnedWorkers.push({ pid: 43 }),
  ]) {
    const value = proof();
    mutate(value);
    assert.throws(() => assertStartupCycleSettled(value));
  }
});

test("caught migration IPC errors fail the final Main log gate without rejecting native warnings", () => {
  const warning = "[1234:1017/130000.000:WARNING:resource_bundle.cc] locale warning\n";
  assert.deepEqual(startupMainLogErrors(warning), []);
  assert.deepEqual(startupMainLogErrors("projectRegistry:completeLegacyMigration completed\n"), []);
  assert.deepEqual(
    startupMainLogErrors("unrelated handler Error: legacy project migration is complete\n"),
    [],
  );
  const value = proof();
  value.operations = ["cold launch", "renderer reload", "second window"];
  value.mainErrors = startupMainLogErrors(
    warning +
      "Error occurred in handler for 'projectRegistry:completeLegacyMigration': Error: legacy project migration is complete\r\n    at requirePending (file:///owned/index.mjs:1:1)\n",
  );
  assert.deepEqual(value.mainErrors, ["legacy-project-migration-completion-error"]);
  assert.throws(() => assertStartupCycleSettled(value), /Known Main startup errors/);
});

test("a late custody query failure cannot be advertised as pass even after successful UI", () => {
  const value = proof();
  value.operations = ["cold launch", "renderer reload", "second window"];
  value.settlement = { status: "unproven", queryFailed: true, remainingCount: null };
  assert.throws(() => assertStartupCycleSettled(value), /unproven/);
  // The diagnostic latch remains independently required if status is malformed.
  value.settlement.status = "cleaned";
  assert.throws(() => assertStartupCycleSettled(value), /failed custody query/);
});

test("evidence canonicalization rejects checkout/HOME aliases before creation", async () => {
  const root = await realpath(await mkdtemp(join(tmpdir(), "codeshell-startup-path-test-")));
  try {
    const checkout = join(root, "checkout"),
      home = join(root, "home"),
      artifacts = join(root, "artifacts");
    for (const path of [checkout, home, artifacts]) await mkdir(path, { mode: 0o700 });
    assert.equal(
      await resolveStartupEvidence(join(artifacts, "new"), checkout, home),
      join(artifacts, "new"),
    );
    await assert.rejects(
      resolveStartupEvidence(join(checkout, "new"), checkout, home),
      /outside the checkout/,
    );
    await assert.rejects(
      resolveStartupEvidence(join(home, "new"), checkout, home),
      /outside the outer HOME/,
    );
    const alias = join(root, "home-alias");
    await symlink(home, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      resolveStartupEvidence(join(alias, "new"), checkout, home),
      /outside the outer HOME/,
    );
    await assert.rejects(
      resolveStartupEvidence(join(artifacts, "..", "home", "new"), checkout, home),
      /outside the outer HOME/,
    );
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
