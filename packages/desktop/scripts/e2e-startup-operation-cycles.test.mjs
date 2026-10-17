import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import {
  assertStartupCycleSettled,
  resolveStartupEvidence,
} from "./e2e-startup-operation-cycles.mjs";

const proof = () => ({
  pid: 42,
  guard: { mainPid: 42, workerCreated: false },
  exit: { code: 0, signal: null },
  settlement: { status: "cleaned", queryFailed: false, remainingCount: 0 },
  observerFailures: [],
  rendererErrors: [],
  deniedAttempts: [],
  spawnedWorkers: [],
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
    (value) => value.deniedAttempts.push({ pid: 42, kind: "worker" }),
    (value) => value.spawnedWorkers.push({ pid: 43 }),
  ]) {
    const value = proof();
    mutate(value);
    assert.throws(() => assertStartupCycleSettled(value));
  }
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
