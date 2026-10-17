import assert from "node:assert/strict";
import { after, test } from "node:test";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

// The only imported repository modules below are dependency-free observation
// and shutdown leaves. Refuse any unexpected real process effect before import.
const transports = ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"];
const originals = new Map(transports.map((name) => [name, children[name]]));
const originalKill = process.kill;
const attempts = [];
for (const name of transports)
  children[name] = () => {
    attempts.push(name);
    throw Error("Unexpected real process transport in observation contract");
  };
process.kill = () => {
  attempts.push("kill");
  throw Error("Unexpected real signal in observation contract");
};
syncBuiltinESMExports();
const { createPackagedStartupObservation } = await import("./packaged-startup-observation.mjs");
const { settlePackagedPet } = await import("./packaged-pet-shutdown.mjs");
after(() => {
  for (const [name, original] of originals) children[name] = original;
  process.kill = originalKill;
  syncBuiltinESMExports();
  assert.deepEqual(attempts, []);
});

const receipt = (pid = 17, launcherPid = pid) => ({
  pid,
  launcherPid,
  mainIdentity: {
    pid,
    ppid: 23,
    executable: "C:\\owned\\code-shell.exe",
    home: "C:\\owned\\private-home",
    argv: ["synthetic value excluded from observation"],
  },
  method: "inspect-brk first-JavaScript pause, synchronous CJS require, then resume",
  pauseURL: "file:///owned/resources/app.asar/out/main/index.mjs",
  reason: "Break on start",
  hostScriptsParsedBeforeGuard: 3,
  pausedLocation: { scriptId: "206", lineNumber: 0, columnNumber: 0 },
  firstUserInstruction: true,
  sourcePrefix: "synthetic private source prefix excluded from observation",
});
const completed = (observation, handle, value = receipt()) => {
  observation.preloadReturned(handle, value);
  observation.privateWriteStarted(handle);
  observation.privateWriteFulfilled(handle);
};
const ready = (observation, handle, value = receipt()) => {
  completed(observation, handle, value);
  observation.sdkReturned(handle);
  observation.identityRead(handle);
  observation.ready(handle);
};

test("a returned preload survives SDK rejection without claiming the SDK returned", () => {
  const observation = createPackagedStartupObservation();
  const handle = observation.captured(17);
  completed(observation, handle);
  observation.failed(handle, "playwright-launch");
  const value = observation.snapshot();
  assert.equal(value.recordingFailed, false);
  assert.equal(value.launches[0].sdkLaunchReturned, false);
  assert.equal(value.launches[0].preloadResultObserved, true);
  assert.equal(value.launches[0].privateReceiptWrite, "fulfilled");
  assert.deepEqual(value.launches[0].atFailure, {
    sdkLaunchReturned: false,
    preloadResultObserved: true,
    privateReceiptWrite: "fulfilled",
  });
  assert.equal(value.launches[0].result.firstUserInstruction, true);
  assert.throws(() => observation.assertComplete(), /not completely recorded/);
});

test("a result arriving during the existing catch await cannot rewrite the failure snapshot", async () => {
  const observation = createPackagedStartupObservation();
  const handle = observation.captured(17);
  let resolvePreload;
  const preload = new Promise((resolve) => {
    resolvePreload = resolve;
  }).then(async (value) => {
    observation.preloadReturned(handle, value);
    observation.privateWriteStarted(handle);
    await Promise.resolve(); // Pure fake of the already-existing private write.
    observation.privateWriteFulfilled(handle);
    return value;
  });
  const originalError = Error("original SDK failure");
  const order = [];
  order.push(originalError); // Fake synchronous original first-error persistence.
  observation.failed(handle, "playwright-launch");
  resolvePreload(receipt());
  await preload;
  const value = observation.snapshot().launches[0];
  assert.strictEqual(order[0], originalError);
  assert.deepEqual(value.atFailure, {
    sdkLaunchReturned: false,
    preloadResultObserved: false,
    privateReceiptWrite: "not-attempted",
  });
  assert.equal(value.preloadResultObserved, true);
  assert.equal(value.privateReceiptWrite, "fulfilled");
  assert.equal(value.sdkLaunchReturned, false);
  observation.failed(handle, "startup-barrier");
  assert.equal(observation.snapshot().launches[0].failurePhase, "playwright-launch");
});

test("private-write rejection retains the already-returned result and original rejection", async () => {
  const observation = createPackagedStartupObservation();
  const handle = observation.captured(17);
  const originalError = Error("owned private write rejected");
  const chained = Promise.resolve(receipt())
    .then(async (value) => {
      observation.preloadReturned(handle, value);
      observation.privateWriteStarted(handle);
      await Promise.reject(originalError);
    })
    .catch((error) => {
      observation.preloadRejected(handle);
      throw error;
    });
  await assert.rejects(chained, (error) => error === originalError);
  const value = observation.snapshot().launches[0];
  assert.equal(value.preloadResultObserved, true);
  assert.equal(value.privateReceiptWrite, "rejected");
  assert.equal(value.preloadChainRejected, true);
  assert.equal(value.result.pid, 17);
});

test("preload rejection has no invented successful result or private write", () => {
  const observation = createPackagedStartupObservation();
  const handle = observation.captured(17);
  observation.preloadRejected(handle);
  observation.sdkReturned(handle);
  observation.failed(handle, "startup-barrier");
  const value = observation.snapshot().launches[0];
  assert.equal(value.preloadResultObserved, false);
  assert.equal(value.preloadChainRejected, true);
  assert.equal(value.result, null);
  assert.equal(value.privateReceiptWrite, "not-attempted");
  assert.equal(value.atFailure.sdkLaunchReturned, true);
});

test("normal ready projection retains only bounded fixed fields, including an existing optional birth", () => {
  for (const birth of [undefined, "2026-10-17T18:49:32.9906110Z", "Sat Oct 17 18:49:32 2026"]) {
    const observation = createPackagedStartupObservation();
    const handle = observation.captured(17);
    const value = receipt(19, 17); // Existing AppImage runtime/Main identities may differ.
    if (birth !== undefined) value.mainIdentity.birth = birth;
    delete value.pausedLocation.columnNumber;
    ready(observation, handle, value);
    assert.doesNotThrow(() => observation.assertComplete());
    const result = observation.snapshot().launches[0].result;
    assert.deepEqual(Object.keys(result), [
      "pid",
      "launcherPid",
      "mainIdentity",
      "method",
      "reason",
      "firstUserInstruction",
      "hostScriptsParsedBeforeGuard",
      "pausedLocation",
    ]);
    assert.equal(result.pid, 19);
    assert.equal(result.launcherPid, 17);
    assert.equal(result.mainIdentity.birth, birth);
    assert.equal(result.pausedLocation.columnNumber, null);
    assert.equal(JSON.stringify(result).includes("synthetic"), false);
    assert.equal(JSON.stringify(result).includes("owned"), false);
    assert.equal(result.pauseURL, undefined);
    assert.equal(result.sourcePrefix, undefined);
  }
});

test("hostile getters and invalid sizes fail recording without interrupting the existing caller", () => {
  let getterCalls = 0;
  const getter = receipt();
  Object.defineProperty(getter, "mainIdentity", {
    get() {
      getterCalls++;
      throw Error("getter");
    },
  });
  const invalid = [getter, { ...receipt(), hostScriptsParsedBeforeGuard: 4097 }, receipt()];
  invalid[2].mainIdentity.birth = "x".repeat(97);
  for (const value of invalid) {
    const observation = createPackagedStartupObservation();
    const handle = observation.captured(17);
    assert.doesNotThrow(() => observation.preloadReturned(handle, value));
    observation.privateWriteStarted(handle);
    const originalWriteCalled = true;
    observation.privateWriteFulfilled(handle);
    assert.equal(originalWriteCalled, true);
    assert.equal(observation.snapshot().recordingFailed, true);
    assert.equal(observation.snapshot().launches[0].preloadResultObserved, true);
    assert.throws(() => observation.assertComplete(), /not completely recorded/);
  }
  assert.equal(getterCalls, 0);
});

test("explicit launch cap and unknown handles cannot silently become complete evidence", () => {
  const observation = createPackagedStartupObservation();
  for (let index = 0; index < 8; index++) {
    const pid = 17 + index;
    ready(observation, observation.captured(pid), receipt(pid));
  }
  assert.doesNotThrow(() => observation.assertComplete());
  assert.equal(observation.captured(99), undefined);
  const value = observation.snapshot();
  assert.equal(value.launches.length, 8);
  assert.equal(value.truncated, true);
  assert.equal(value.recordingFailed, true);
  assert.throws(() => observation.assertComplete(), /not completely recorded/);
  const foreign = createPackagedStartupObservation();
  foreign.sdkReturned({});
  assert.equal(foreign.snapshot().recordingFailed, true);
  // A launch rejected before capture is unobserved, not an invented result.
  const notCaptured = createPackagedStartupObservation();
  notCaptured.failed(undefined, "playwright-launch");
  assert.deepEqual(notCaptured.snapshot().launches, []);
  assert.throws(() => notCaptured.assertComplete(1), /not completely recorded/);
});

test("input and public snapshot mutation cannot backfill observations or the frozen failure state", () => {
  const observation = createPackagedStartupObservation();
  const handle = observation.captured(17);
  const value = receipt();
  completed(observation, handle, value);
  observation.failed(handle, "playwright-launch");
  value.mainIdentity.ppid = 999;
  value.pausedLocation.lineNumber = 999;
  const first = observation.snapshot();
  first.launches[0].atFailure.preloadResultObserved = false;
  first.launches[0].result.mainIdentity.ppid = 111;
  assert.equal(observation.snapshot().launches[0].result.mainIdentity.ppid, 23);
  assert.equal(observation.snapshot().launches[0].result.pausedLocation.lineNumber, 0);
  assert.equal(observation.snapshot().launches[0].atFailure.preloadResultObserved, true);
});

test("actual pure shutdown preserves artifacts and first cause before the final observer gate denies HOME cleanup", async () => {
  for (const allowed of [false, true]) {
    const observation = createPackagedStartupObservation();
    const handle = observation.captured(17);
    observation.preloadReturned(handle, { ...receipt(), firstUserInstruction: false });
    const originalError = Error("original native cause");
    const aggregate = new AggregateError([originalError], "original launch aggregate", {
      cause: originalError,
    });
    const calls = [];
    const artifacts = {
      appTreeSHA256: "owned integrity retained",
      startupObservation: observation.snapshot(),
    };
    const result = await settlePackagedPet({
      failures: [aggregate],
      closeApp: async () => calls.push("closeApp"),
      closeModel: async () => calls.push("closeModel"),
      verifyUnchanged: async () => {
        calls.push("verify");
        return artifacts;
      },
      readNativeCalls: async () => {
        calls.push("native");
        return [];
      },
      canCleanup: () =>
        Promise.resolve(allowed).then((originalAllowed) => {
          calls.push("originalGateComplete");
          if (originalAllowed) observation.assertComplete();
          return originalAllowed;
        }),
      cleanup: async () => calls.push("cleanup"),
      retainedHome: "owned fake HOME",
    });
    assert.strictEqual(result.artifacts, artifacts);
    assert.equal(result.artifacts.startupObservation.recordingFailed, true);
    assert.strictEqual(result.errors[0], aggregate);
    assert.strictEqual(result.errors[0].errors[0], originalError);
    assert.equal(result.privateHomeRemoved, false);
    assert.deepEqual(calls, ["closeApp", "closeModel", "verify", "native", "originalGateComplete"]);
    assert.equal(result.errors.length, allowed ? 3 : 2);
    assert.match(
      result.errors[1].message,
      allowed ? /not completely recorded/ : /exit was not confirmed/,
    );
    if (allowed) assert.match(result.errors[2].message, /exit was not confirmed/);
  }
});
