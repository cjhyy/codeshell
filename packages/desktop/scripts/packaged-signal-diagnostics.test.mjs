import assert from "node:assert/strict";
import { test } from "node:test";
import { createPackagedSignalDiagnostics } from "./packaged-signal-diagnostics.mjs";

test("actual authorized callback is recorded before the identical signal delegation", () => {
  const calls = [];
  const ledger = createPackagedSignalDiagnostics((pid, signal) => {
    assert.deepEqual(ledger.receipt().requests.at(-1), { sequence: calls.length + 1, pid, signal });
    calls.push({ pid, signal });
    return "delegated";
  });
  assert.equal(ledger.request(42, "SIGTERM"), "delegated");
  assert.equal(ledger.request(43, "SIGKILL"), "delegated");
  assert.deepEqual(calls, [
    { pid: 42, signal: "SIGTERM" },
    { pid: 43, signal: "SIGKILL" },
  ]);
  assert.equal(ledger.receipt().truncated, false);
  const snapshot = ledger.receipt();
  snapshot.requests[0].pid = 100;
  assert.equal(ledger.receipt().requests[0].pid, 42);
});

test("delegation failures remain failures and bounded observation never skips cleanup", () => {
  const failure = Error("owned signal rejected");
  const broken = createPackagedSignalDiagnostics(() => {
    throw failure;
  });
  assert.throws(
    () => broken.request(42, "SIGTERM"),
    (error) => error === failure,
  );
  assert.equal(broken.receipt().requests.length, 1);
  let calls = 0;
  const bounded = createPackagedSignalDiagnostics(() => {
    calls++;
  });
  for (let index = 0; index < 515; index++) bounded.request(42, "SIGTERM");
  assert.equal(calls, 515);
  assert.equal(bounded.receipt().requests.length, 512);
  assert.equal(bounded.receipt().truncated, true);
});
