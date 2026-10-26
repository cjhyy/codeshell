import assert from "node:assert/strict";
import { after, test } from "node:test";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";
import { readFileSync } from "node:fs";
import { performance } from "node:perf_hooks";

// The initial repository imports are dependency-free observation and shutdown leaves.
// Refuse any unexpected real process effect before any repository import.
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

// Additional passive tests use actual module exports and fake EventEmitters.
// The transport import in the final case reads only its installed package version;
// it receives an entirely fake transport, never an SDK, native child or query.
const { EventEmitter, errorMonitor } = await import("node:events");
const { createHash } = await import("node:crypto");
const { createPackagedLaunchDiagnostics, hostedWindowsLaunchDiagnosticsEnabled } =
  await import("./packaged-startup-observation.mjs");
const diagnosticChild = (pid = 101) =>
  Object.assign(new EventEmitter(), {
    pid,
    exitCode: null,
    signalCode: null,
    killed: false,
    stdout: new EventEmitter(),
    stderr: new EventEmitter(),
  });
const diagnosticFixture = (options = {}) => {
  let time = 10;
  const observation = createPackagedLaunchDiagnostics({ now: () => time++, ...options });
  const child = diagnosticChild();
  observation.captured(child);
  return { observation, child };
};
const tailHash = (bytes) => createHash("sha256").update(bytes).digest("hex");

const { findCodeShellWindow } = await import("./electron-harness.mjs");
const electronWindow = (id, url = "file:///PRIVATE/renderer/index.html?secret=PRIVATE") => ({
  id,
  isDestroyed: () => false,
  isVisible: () => true,
  webContents: {
    isDestroyed: () => false,
    isCrashed: () => false,
    isLoading: () => true,
    getURL: () => url,
  },
});
const probeApp = (child, windows = [electronWindow(1)]) => ({
  process: () => child,
  windows: () => [],
  evaluate: async (callback) =>
    callback({ app: { isReady: () => true }, BrowserWindow: { getAllWindows: () => windows } }),
});

test("window probe separates Playwright count, bounds Electron windows and redacts before transport", async () => {
  const { observation, child } = diagnosticFixture();
  const windows = Array.from({ length: 12 }, (_, index) => electronWindow(index + 1));
  const app = probeApp(child, windows);
  const evaluate = app.evaluate;
  let calls = 0;
  app.windows = () => [{}, {}, {}];
  app.evaluate = async (callback) => {
    calls++;
    const transported = await evaluate(callback);
    assert.doesNotMatch(JSON.stringify(transported), /PRIVATE|secret|\/renderer/);
    return transported;
  };
  await observation.probeWindows(app);
  await observation.probeWindows(app);
  const value = observation.snapshot();
  const probe = value.launches[0].windowProbe;
  assert.equal(calls, 1);
  assert.equal(probe.status, "observed");
  assert.equal(probe.timeoutMs, 3000);
  assert.equal(probe.playwrightWindowCount, 3);
  assert.equal(probe.appReady, true);
  assert.equal(probe.browserWindowCount, 12);
  assert.equal(probe.truncated, true);
  assert.equal(probe.windows.length, 8);
  assert.deepEqual(probe.windows[0], {
    id: 1,
    visible: true,
    destroyed: false,
    crashed: false,
    loading: true,
    urlKind: "file:index.html",
  });
  probe.windows[0].id = 999;
  assert.equal(observation.snapshot().launches[0].windowProbe.windows[0].id, 1);
});

test("destroyed BrowserWindow and webContents never receive unsafe calls", async () => {
  const { observation, child } = diagnosticFixture();
  const destroyed = {
    isDestroyed: () => true,
    get id() {
      throw Error("PRIVATE destroyed id");
    },
    get webContents() {
      throw Error("PRIVATE destroyed contents");
    },
    isVisible() {
      throw Error("PRIVATE destroyed visible");
    },
  };
  const live = electronWindow(2);
  live.webContents = { isDestroyed: () => true };
  await observation.probeWindows(probeApp(child, [destroyed, live]));
  const probe = observation.snapshot().launches[0].windowProbe;
  assert.equal(probe.status, "observed");
  assert.deepEqual(probe.windows[0], {
    id: null,
    visible: null,
    destroyed: true,
    crashed: null,
    loading: null,
    urlKind: "unavailable",
  });
  assert.equal(probe.windows[1].crashed, null);
  assert.equal(probe.windows[1].urlKind, "unavailable");
});

test("probe handles rejection, hostile projection and timeout with cleared timer and late rejection", async () => {
  for (const mode of ["reject", "getter", "invalid", "timeout"]) {
    let fire,
      timerMs,
      cleared = 0,
      rejectLate;
    const observation = createPackagedLaunchDiagnostics({
      setTimer(callback, ms) {
        fire = callback;
        timerMs = ms;
        return 17;
      },
      clearTimer(timer) {
        assert.equal(timer, 17);
        cleared++;
      },
    });
    const child = diagnosticChild();
    observation.captured(child);
    const app = probeApp(child);
    app.evaluate = () => {
      if (mode === "reject") return Promise.reject(Error("PRIVATE evaluate"));
      if (mode === "getter")
        return Promise.resolve(
          Object.defineProperty({}, "appReady", {
            get() {
              throw Error("PRIVATE getter");
            },
          }),
        );
      if (mode === "invalid")
        return Promise.resolve({ appReady: true, browserWindowCount: Infinity, windows: [] });
      return new Promise((_, reject) => {
        rejectLate = reject;
      });
    };
    const pending = observation.probeWindows(app);
    if (mode === "timeout") {
      fire();
      rejectLate(Error("PRIVATE late rejection"));
    }
    await pending;
    await new Promise((resolve) => setImmediate(resolve));
    const value = observation.snapshot();
    const probe = value.launches[0].windowProbe;
    assert.equal(timerMs, 3000);
    assert.equal(cleared, 1);
    assert.equal(probe.status, mode === "timeout" ? "timeout" : "failed");
    assert.equal(value.recordingFailed, mode === "getter" || mode === "invalid");
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE|Infinity/);
  }
});

test("probe uses fixed URL classifications including credentials, query and non-file schemes", async () => {
  const { observation, child } = diagnosticFixture();
  const urls = [
    "https://PRIVATE:SECRET@host/x?PRIVATE",
    "http://host/PRIVATE",
    "data:PRIVATE",
    "about:blank",
    "file:///PRIVATE/other.html",
    "not a PRIVATE URL",
    "",
    "custom:PRIVATE",
  ];
  await observation.probeWindows(
    probeApp(
      child,
      urls.map((url, id) => electronWindow(id + 1, url)),
    ),
  );
  assert.deepEqual(
    observation.snapshot().launches[0].windowProbe.windows.map((row) => row.urlKind),
    ["https", "http", "data", "about:blank", "file:other", "invalid", "empty", "other"],
  );
});

test("timeout stays frozen after late success, settled timing and a second probe request", async () => {
  let fire,
    resolveLate,
    evaluations = 0;
  const { observation, child } = diagnosticFixture({
    setTimer(callback) {
      fire = callback;
      return 19;
    },
    clearTimer() {},
  });
  observation.watchdog(child, { snapshotTiming: timingSample() });
  observation.failed();
  const app = probeApp(child);
  app.evaluate = () => {
    evaluations++;
    return new Promise((resolve) => {
      resolveLate = resolve;
    });
  };
  const pending = observation.probeWindows(app);
  fire();
  await pending;
  const first = observation.snapshot().launches[0].windowProbe;
  resolveLate({ appReady: true, browserWindowCount: 0, windows: [] });
  await new Promise((resolve) => setImmediate(resolve));
  observation.settled();
  await observation.probeWindows(app);
  assert.deepEqual(observation.snapshot().launches[0].windowProbe, first);
  assert.equal(first.status, "timeout");
  assert.equal(evaluations, 1);
  assert.deepEqual(observation.snapshot().launches[0].snapshotTiming, {
    atFailure: timingSample(),
    settled: timingSample(),
  });
});

test("window probe refuses hostile fields and nonfinite/fractional counts without executing getters", async () => {
  const row = {
    id: 1,
    visible: true,
    destroyed: false,
    crashed: false,
    loading: false,
    urlKind: "empty",
  };
  const sample = () => ({ appReady: true, browserWindowCount: 1, windows: [{ ...row }] });
  let getters = 0;
  const badRow = Object.defineProperty({ ...row }, "id", {
    get() {
      getters++;
      throw Error("PRIVATE getter");
    },
  });
  const badArray = [{ ...row }];
  Object.defineProperty(badArray, "0", {
    get() {
      getters++;
      throw Error("PRIVATE array getter");
    },
  });
  for (const result of [
    ...[NaN, Infinity, -1, 0.5, Number.MAX_SAFE_INTEGER + 1].map((browserWindowCount) => ({
      ...sample(),
      browserWindowCount,
    })),
    ...[NaN, Infinity, -1, 0.5].map((id) => ({ ...sample(), windows: [{ ...row, id }] })),
    { ...sample(), windows: [badRow] },
    { ...sample(), windows: badArray },
    { ...sample(), windows: Array(9).fill(row) },
    { ...sample(), windows: [{ ...row, urlKind: "https://PRIVATE" }] },
  ]) {
    const { observation, child } = diagnosticFixture();
    const app = probeApp(child);
    app.evaluate = async () => result;
    await observation.probeWindows(app);
    assert.equal(observation.snapshot().recordingFailed, true);
    assert.equal(observation.snapshot().launches[0].windowProbe.status, "failed");
    assert.doesNotMatch(JSON.stringify(observation.snapshot()), /PRIVATE/);
  }
  assert.equal(getters, 0);
  const { observation, child } = diagnosticFixture();
  const good = Object.defineProperty(sample(), "secret", {
    get() {
      throw Error("unread dynamic property");
    },
  });
  const app = probeApp(child);
  app.evaluate = async () => good;
  await observation.probeWindows(app);
  good.windows[0].id = 99;
  assert.equal(observation.snapshot().launches[0].windowProbe.windows[0].id, 1);
  assert.equal(observation.snapshot().recordingFailed, false);
});

test("native destruction races and synchronous evaluation failures stay bounded", async () => {
  for (const mode of ["window-race", "contents-race", "sync-throw"]) {
    const { observation, child } = diagnosticFixture();
    const window = electronWindow(1);
    let destroyed = false;
    if (mode === "window-race") {
      window.isDestroyed = () => destroyed;
      window.isVisible = () => {
        destroyed = true;
        throw Error("PRIVATE window gone");
      };
    }
    if (mode === "contents-race")
      window.webContents.getURL = () => {
        throw Error("PRIVATE contents gone");
      };
    const app = probeApp(child, [window]);
    if (mode === "sync-throw")
      app.evaluate = () => {
        throw Error("PRIVATE synchronous failure");
      };
    await assert.doesNotReject(observation.probeWindows(app));
    const value = observation.snapshot().launches[0].windowProbe;
    assert.equal(value.status, mode === "window-race" ? "observed" : "failed");
    if (mode === "window-race") assert.equal(value.windows[0].destroyed, true);
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  }
});

test("real 3s deadline releases pending evaluate without awaiting it or delaying settlement", async () => {
  const { observation, child } = diagnosticFixture();
  const app = probeApp(child);
  let rejectLate;
  app.evaluate = () =>
    new Promise((_, reject) => {
      rejectLate = reject;
    });
  const started = performance.now();
  await observation.probeWindows(app);
  const elapsed = performance.now() - started;
  assert.ok(elapsed >= 2900 && elapsed < 4500, `controller deadline elapsed=${elapsed}`);
  assert.equal(observation.snapshot().launches[0].windowProbe.status, "timeout");
  rejectLate(Error("PRIVATE late transport close"));
  await new Promise((resolve) => setImmediate(resolve));
});

const timingSample = (count = 2) => ({
  count,
  totalMs: count * 5,
  maxMs: 5,
  recent: Array(Math.min(count, 32)).fill(5),
  maxTickGapMs: 1001,
});
const packagedDriverSource = readFileSync(
  new URL("./e2e-ui-packaged.mjs", import.meta.url),
  "utf8",
);
const firstErrorStart = packagedDriverSource.indexOf("const recordFirstError =");
const firstErrorEnd = packagedDriverSource.indexOf("const put =", firstErrorStart);
const actualFirstErrorRecorder = new Function(
  "fixture",
  "recordPackagedMainFirstError",
  "join",
  "evidence",
  `let firstError; const diagnosticRecordingFailures = []; ${packagedDriverSource.slice(firstErrorStart, firstErrorEnd)} return recordFirstError;`,
);
const packagedFixtureSource = readFileSync(
  new URL("./packaged-pet-fixture.mjs", import.meta.url),
  "utf8",
);
const bindingStart = packagedFixtureSource.indexOf(
  "passiveLaunchDiagnostics?.watchdog(child, monitor);",
);
const bindingEnd = packagedFixtureSource.indexOf("processMonitors.push(monitor);", bindingStart);
assert.ok(bindingStart >= 0 && bindingEnd > bindingStart);
const actualWatchdogBinding = new Function(
  "passiveLaunchDiagnostics",
  "child",
  "monitor",
  packagedFixtureSource.slice(bindingStart, bindingEnd),
);
const settledStart = packagedFixtureSource.indexOf(
  "const observedProcessSettlements = await Promise.all(",
);
const settledEnd = packagedFixtureSource.indexOf("const after =", settledStart);
assert.ok(settledStart >= 0 && settledEnd > settledStart);
const actualSettledCapture = new (Object.getPrototypeOf(async function () {}).constructor)(
  "processMonitors",
  "passiveLaunchDiagnostics",
  packagedFixtureSource.slice(settledStart, settledEnd) + "return observedProcessSettlements;",
);
const actualFixtureProbe = new Function(
  "passiveLaunchDiagnostics",
  `return ({${packagedFixtureSource.slice(packagedFixtureSource.indexOf("    async probeFirstWindow("), packagedFixtureSource.indexOf("    diagnosticContext()"))}}).probeFirstWindow;`,
);
const actualDriverRoute = (afterWindow = "") => {
  const start = packagedDriverSource.indexOf("      app = await fixture.launch();");
  const end = packagedDriverSource.indexOf("      win = app.windows().find", start);
  const catchStart = packagedDriverSource.indexOf(
    '  recordFirstError(error, { phase: "ui-operation"',
  );
  const catchEnd = packagedDriverSource.indexOf(
    "\nconst result = await settlePackagedPet",
    catchStart,
  );
  return new (Object.getPrototypeOf(async function () {}).constructor)(
    "fixture",
    "findCodeShellWindow",
    "recordFirstError",
    "process",
    "failures",
    "diagnosticRecordingFailures",
    `let app, win, identity; let firstWindowPending = false; try { ${packagedDriverSource.slice(start, end)} ${afterWindow} } catch(error) { ${packagedDriverSource.slice(catchStart, catchEnd)}`,
  );
};

test("probe timer cleanup failure cannot escape observation", async () => {
  const { observation, child } = diagnosticFixture({
    clearTimer() {
      throw Error("PRIVATE timer");
    },
  });
  await assert.doesNotReject(observation.probeWindows(probeApp(child)));
  assert.equal(observation.snapshot().recordingFailed, true);
});

test("actual driver retains original error and reaches cleanup even if probe unexpectedly rejects", async () => {
  const original = Error("first-window timeout");
  const app = {
    firstWindow: async () => {
      throw original;
    },
    process: () => ({ pid: 17 }),
  };
  const fixture = {
    launch: async () => app,
    probeFirstWindow: async () => {
      throw Error("PRIVATE probe failure");
    },
  };
  const failures = [],
    diagnostics = [];
  await assert.doesNotReject(
    actualDriverRoute()(fixture, findCodeShellWindow, () => {}, { pid: 23 }, failures, diagnostics),
  );
  let cleanups = 0;
  const result = await settlePackagedPet({
    failures,
    closeApp: async () => {},
    closeModel: async () => {},
    verifyUnchanged: async () => ({}),
    readNativeCalls: async () => [],
    canCleanup: async () => true,
    cleanup: async () => {
      cleanups++;
    },
    retainedHome: "owned-home",
  });
  assert.strictEqual(result.errors[0], original);
  assert.equal(cleanups, 1);
  assert.doesNotMatch(JSON.stringify(diagnostics.map((error) => error.message)), /PRIVATE/);
});

test("actual driver never probes a later UI error after first-window success", async () => {
  let probes = 0;
  const failures = [];
  const fixture = {
    launch: async () => ({ process: () => ({ pid: 17 }) }),
    probeFirstWindow: async () => {
      probes++;
    },
  };
  await actualDriverRoute('throw Error("later UI error");')(
    fixture,
    async () => {},
    () => {},
    { pid: 23 },
    failures,
    [],
  );
  assert.equal(failures[0].message, "later UI error");
  assert.equal(probes, 0);
});

test("appReady=false still samples actual Electron windows without inventing a zero", async () => {
  const { observation, child } = diagnosticFixture();
  const app = probeApp(child);
  app.evaluate = async (callback) =>
    callback({
      app: { isReady: () => false },
      BrowserWindow: { getAllWindows: () => [electronWindow(1)] },
    });
  await observation.probeWindows(app);
  const value = observation.snapshot().launches[0].windowProbe;
  assert.equal(value.appReady, false);
  assert.equal(value.browserWindowCount, 1);
});

test("real packaged driver findCodeShellWindow failure freezes first error before one probe and cleanup", async () => {
  const { observation, child } = diagnosticFixture();
  let current = timingSample(),
    cleanups = 0,
    probes = 0;
  observation.watchdog(child, {
    get snapshotTiming() {
      return current;
    },
  });
  const original = Error("electronApplication.firstWindow: Timeout 20000ms exceeded");
  const app = probeApp(child);
  app.firstWindow = async () => {
    throw original;
  };
  const evaluate = app.evaluate;
  app.evaluate = async (callback) => {
    probes++;
    assert.deepEqual(observation.snapshot().launches[0].snapshotTiming.atFailure, timingSample());
    current = timingSample(3);
    return evaluate(callback);
  };
  const fixture = {
    launch: async () => app,
    recordLaunchFailure: () => observation.failed(),
    probeFirstWindow: actualFixtureProbe(observation),
  };
  const recorded = [];
  const recordFirstError = actualFirstErrorRecorder(
    fixture,
    (_path, error) => {
      recorded.push(error);
      return { written: true };
    },
    (...paths) => paths.join("/"),
    "owned-evidence",
  );
  const launchStart = packagedDriverSource.indexOf("      app = await fixture.launch();");
  const launchEnd = packagedDriverSource.indexOf("      win = app.windows().find", launchStart);
  const catchStart = packagedDriverSource.indexOf(
    '  recordFirstError(error, { phase: "ui-operation"',
  );
  const catchEnd = packagedDriverSource.indexOf(
    "\nconst result = await settlePackagedPet",
    catchStart,
  );
  assert.ok(launchStart > 0 && launchEnd > launchStart && catchEnd > catchStart);
  const run = new (Object.getPrototypeOf(async function () {}).constructor)(
    "fixture",
    "findCodeShellWindow",
    "recordFirstError",
    "process",
    "failures",
    "diagnosticRecordingFailures",
    `let app, win, identity; let firstWindowPending = false; try { ${packagedDriverSource.slice(launchStart, launchEnd)} } catch(error) { ${packagedDriverSource.slice(catchStart, catchEnd)}`,
  );
  const failures = [];
  await run(fixture, findCodeShellWindow, recordFirstError, { pid: 23 }, failures, []);
  const result = await settlePackagedPet({
    failures,
    closeApp: async () => {},
    closeModel: async () => {},
    verifyUnchanged: async () => {
      observation.settled();
      return { packagedLaunchDiagnostics: observation.snapshot() };
    },
    readNativeCalls: async () => [],
    canCleanup: async () => true,
    cleanup: async () => {
      cleanups++;
    },
    retainedHome: "owned-home",
  });
  assert.strictEqual(result.errors[0], original);
  assert.deepEqual(recorded, [original]);
  assert.equal(probes, 1);
  assert.equal(cleanups, 1);
  assert.deepEqual(result.artifacts.packagedLaunchDiagnostics.launches[0].snapshotTiming, {
    atFailure: timingSample(),
    settled: timingSample(3),
  });
  assert.equal(
    result.artifacts.packagedLaunchDiagnostics.launches[0].windowProbe.status,
    "observed",
  );
});

test("actual packaged fixture captures settled timing only after the original monitor completes", async () => {
  const { observation, child } = diagnosticFixture();
  let complete,
    reads = 0;
  const completed = new Promise((resolve) => {
    complete = resolve;
  });
  const monitor = {
    completed,
    get snapshotTiming() {
      reads++;
      return timingSample();
    },
  };
  actualWatchdogBinding(observation, child, monitor);
  const pending = actualSettledCapture([monitor], observation);
  await Promise.resolve();
  assert.equal(reads, 0);
  assert.equal(observation.snapshot().launches[0].snapshotTiming.settled, null);
  const settlement = { status: "cleaned" };
  complete(settlement);
  assert.strictEqual((await pending)[0], settlement);
  assert.equal(reads, 1);
  assert.deepEqual(observation.snapshot().launches[0].snapshotTiming.settled, timingSample());
});

for (const throwing of [false, true])
  test(`actual packaged first-window timeout captures watchdog timing; throwing getter=${throwing} preserves error and cleanup`, async () => {
    const { observation, child } = diagnosticFixture();
    let current = timingSample(),
      reads = 0,
      cleanups = 0;
    const monitor = Object.defineProperty(() => {}, "snapshotTiming", {
      get() {
        reads++;
        if (throwing) throw Error("PRIVATE getter detail");
        return current;
      },
    });
    actualWatchdogBinding(observation, child, monitor);
    const original = Error("electronApplication.firstWindow: Timeout 20000ms exceeded");
    const recorded = [];
    const recordFirstError = actualFirstErrorRecorder(
      { recordLaunchFailure: () => observation.failed() },
      (_path, error) => {
        recorded.push(error);
        return { written: true };
      },
      (...paths) => paths.join("/"),
      "owned-evidence",
    );
    recordFirstError(original, { phase: "ui-operation", pid: child.pid });
    const first = observation.snapshot().launches[0].snapshotTiming.atFailure;
    assert.deepEqual(first, throwing ? null : timingSample());
    current.recent.fill(999);
    current = timingSample(3);
    recordFirstError(Error("later error"));
    const result = await settlePackagedPet({
      failures: [original],
      closeApp: async () => {},
      closeModel: async () => {},
      verifyUnchanged: async () => {
        observation.settled();
        return { packagedLaunchDiagnostics: observation.snapshot() };
      },
      readNativeCalls: async () => [],
      canCleanup: async () => true,
      cleanup: async () => {
        cleanups++;
      },
      retainedHome: "owned-home",
    });
    assert.strictEqual(result.errors[0], original);
    assert.deepEqual(recorded, [original]);
    assert.equal(cleanups, 1);
    assert.equal(reads, 2);
    const sidecar = result.artifacts.packagedLaunchDiagnostics;
    assert.deepEqual(sidecar.launches[0].snapshotTiming, {
      atFailure: throwing ? null : timingSample(),
      settled: throwing ? null : timingSample(3),
    });
    assert.equal(sidecar.recordingFailed, throwing);
    assert.doesNotMatch(JSON.stringify(sidecar), /PRIVATE/);
  });

test("packaged watchdog timing accepts 32 copied samples and only its captured child", () => {
  const { observation, child } = diagnosticFixture();
  const sample = { ...timingSample(32), secret: "PRIVATE" };
  const monitor = Object.defineProperty(() => {}, "snapshotTiming", { get: () => sample });
  observation.watchdog(child, monitor);
  observation.failed();
  observation.settled();
  sample.recent[0] = 999;
  const value = observation.snapshot();
  assert.deepEqual(value.launches[0].snapshotTiming.atFailure, timingSample(32));
  assert.deepEqual(value.launches[0].snapshotTiming.settled, timingSample(32));
  value.launches[0].snapshotTiming.atFailure.recent[0] = -1;
  assert.equal(observation.snapshot().launches[0].snapshotTiming.atFailure.recent[0], 5);
  assert.equal(value.recordingFailed, false);
  assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  assert.equal(observation.watchdog(diagnosticChild(child.pid), monitor), null);
  assert.equal(observation.snapshot().recordingFailed, true);
});

test("invalid packaged timing metadata and field getters are refused without being serialized", () => {
  for (const sample of [
    { ...timingSample(), count: -1 },
    { ...timingSample(), count: 1.5 },
    { ...timingSample(), totalMs: Infinity },
    { ...timingSample(), maxMs: NaN },
    { ...timingSample(), maxTickGapMs: -1 },
    { ...timingSample(), recent: Array(33).fill(5) },
    { ...timingSample(), recent: [NaN] },
    Object.defineProperty(timingSample(), "recent", {
      get() {
        throw Error("PRIVATE field getter");
      },
    }),
  ]) {
    const { observation, child } = diagnosticFixture();
    observation.watchdog(child, { snapshotTiming: sample });
    assert.doesNotThrow(() => {
      observation.failed();
      observation.settled();
    });
    const value = observation.snapshot();
    assert.equal(value.recordingFailed, true);
    assert.deepEqual(value.launches[0].snapshotTiming, { atFailure: null, settled: null });
    assert.doesNotMatch(JSON.stringify(value), /PRIVATE/);
  }
});

test("passive launch diagnostics opt in only to the existing hosted Windows CI identity", () => {
  const ci = {
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Windows",
    RUNNER_ARCH: "X64",
    RUNNER_ENVIRONMENT: "github-hosted",
    ImageOS: "win22",
    GITHUB_REPOSITORY: "cjhyy/codeshell",
    GITHUB_RUN_ID: "39101744806",
    GITHUB_SHA: "b".repeat(40),
  };
  const enabled = (env = ci, platform = "win32", arch = "x64") =>
    hostedWindowsLaunchDiagnosticsEnabled(platform, arch, env);
  assert.equal(enabled(), true);
  for (const [key, value] of [
    ["GITHUB_ACTIONS", "false"],
    ["RUNNER_OS", "Linux"],
    ["RUNNER_ARCH", "ARM64"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["ImageOS", "win25"],
    ["GITHUB_REPOSITORY", "foreign/repo"],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_SHA", "B".repeat(40)],
    ["ACT", "true"],
  ])
    assert.equal(enabled({ ...ci, [key]: value }), false);
  assert.equal(enabled(ci, "darwin"), false);
  assert.equal(enabled(ci, "win32", "arm64"), false);
  let reads = 0;
  const hostile = { ...ci };
  Object.defineProperty(hostile, "GITHUB_ACTIONS", {
    get() {
      reads++;
      throw Error("unread getter");
    },
  });
  assert.equal(enabled(hostile), false);
  assert.equal(reads, 0);
});

test("passive callback order distinguishes exit before SDK cleanup from a live-cache stderr close", () => {
  for (const exited of [true, false]) {
    const { observation, child } = diagnosticFixture();
    if (exited) {
      child.exitCode = 3221225477;
      child.emit("exit", child.exitCode, null);
    } else child.stderr.emit("close");
    const sequence = observation.cleanupRequested(child);
    child.emit("close", child.exitCode, null);
    const value = observation.snapshot();
    assert.equal(value.recordingFailed, false);
    assert.deepEqual(
      value.launches[0].events.map((event) => event.kind),
      [
        "captured",
        exited ? "child-exit" : "stderr-close",
        "sdk-taskkill-suppressed",
        "child-close",
      ],
    );
    const events = value.launches[0].events;
    assert.deepEqual(
      events.map((event) => event.sequence),
      [1, 2, 3, 4],
    );
    assert.deepEqual(
      events.map((event) => event.monotonicMs),
      [0, 1, 2, 3],
    );
    assert.equal(sequence, events[2].sequence);
    assert.equal(events[2].cached.exitCode, exited ? 3221225477 : null);
    assert.equal(events[2].cached.killed, false);
    assert.equal(child.listenerCount("exit"), 0);
    assert.equal(child.stderr.listenerCount("close"), 0);
    assert.equal(child.listenerCount(errorMonitor), 0);
  }
});

test("errorMonitor records bounded codes without consuming otherwise unhandled child or stream errors", () => {
  const { observation, child } = diagnosticFixture();
  for (const emitter of [child, child.stdout, child.stderr]) {
    const original = Object.assign(Error("private error message excluded"), { code: "EPIPE" });
    assert.equal(emitter.listenerCount("error"), 0);
    assert.throws(
      () => emitter.emit("error", original),
      (error) => error === original,
    );
    assert.equal(emitter.listenerCount("error"), 0);
  }
  const value = observation.snapshot();
  assert.equal(value.recordingFailed, false);
  assert.deepEqual(
    value.launches[0].events.slice(1).map((event) => event.errorCode),
    ["EPIPE", "EPIPE", "EPIPE"],
  );
  assert.equal(JSON.stringify(value).includes("private error"), false);
  let reads = 0;
  const hostile = Error("not projected");
  Object.defineProperty(hostile, "code", {
    get() {
      reads++;
      throw Error("unread code getter");
    },
  });
  assert.throws(
    () => child.emit("error", hostile),
    (error) => error === hostile,
  );
  assert.equal(reads, 0);
  assert.equal(observation.snapshot().recordingFailed, true);
});

test("passive caps, foreign objects and invalid clocks are explicit and do not change startup completeness", () => {
  const { observation, child } = diagnosticFixture();
  for (let index = 0; index < 70; index++) child.stdout.emit("end");
  for (let index = 1; index < 8; index++) observation.captured(diagnosticChild(101 + index));
  assert.equal(observation.captured(diagnosticChild(999)), null);
  assert.equal(
    observation.cleanupRequested(diagnosticChild(101)),
    null,
    "matching PID grants no child handle",
  );
  const value = observation.snapshot();
  assert.equal(value.launches.length, 8);
  assert.equal(value.launches[0].events.length, 64);
  assert.equal(value.launches[0].droppedEvents, 7);
  assert.equal(value.truncated, true);
  assert.equal(value.recordingFailed, true);
  const startup = createPackagedStartupObservation();
  ready(startup, startup.captured(17));
  assert.doesNotThrow(() => startup.assertComplete(1));
  const clock = diagnosticFixture({ now: () => NaN });
  assert.doesNotThrow(() => clock.child.stderr.emit("close"));
  assert.equal(clock.observation.snapshot().recordingFailed, true);
  const backwards = [10, 9];
  const earlier = diagnosticFixture({ now: () => backwards.shift() });
  earlier.observation.cleanupRequested(earlier.child);
  assert.equal(earlier.observation.snapshot().recordingFailed, true);
  const invalid = diagnosticChild();
  let reads = 0;
  Object.defineProperty(invalid, "exitCode", {
    get() {
      reads++;
      throw Error("unread exit getter");
    },
  });
  const passive = createPackagedLaunchDiagnostics();
  assert.doesNotThrow(() => passive.captured(invalid));
  assert.equal(reads, 0);
  assert.equal(passive.snapshot().launches[0].events[0].cached, null);
  assert.equal(passive.snapshot().recordingFailed, true);
});

test("successful append tails copy only the last 64KiB per stream and retain split UTF-8 bytes", () => {
  const { observation, child } = diagnosticFixture();
  const cap = 64 * 1024;
  const first = Buffer.alloc(cap, 97);
  observation.appended(child, "stdout", first);
  assert.equal(observation.snapshot().launches[0].stdout.truncated, false);
  first.fill(98);
  assert.equal(
    observation.snapshot().launches[0].stdout.rawTailSHA256,
    tailHash(Buffer.alloc(cap, 97)),
  );
  observation.appended(child, "stdout", Buffer.from("Z"));
  let value = observation.snapshot().launches[0].stdout;
  assert.equal(value.retainedBytes, cap);
  assert.equal(value.droppedBytes, 1);
  assert.equal(value.text.at(-1), "Z");
  const large = Buffer.alloc(cap * 5, 99);
  observation.appended(child, "stdout", large);
  large.fill(100);
  value = observation.snapshot().launches[0].stdout;
  assert.equal(value.rawTailSHA256, tailHash(Buffer.alloc(cap, 99)));
  assert.equal(value.observedBytes, cap * 6 + 1);
  assert.equal(value.droppedBytes, cap * 5 + 1);
  assert.equal(value.chunks, 3);
  const character = Buffer.from("界");
  observation.appended(child, "stderr", character.subarray(0, 1));
  observation.appended(child, "stderr", character.subarray(1));
  assert.equal(observation.snapshot().launches[0].stderr.text, "界");
  assert.equal(value.lastData.sequence > value.firstData.sequence, true);
});

test("rendered tails bound UTF-8 output, redact known roots and URLs, and isolate snapshot mutation", () => {
  const root = "C:\\private-owned";
  const { observation, child } = diagnosticFixture({ redactRoots: [root] });
  observation.appended(
    child,
    "stderr",
    Buffer.from(`\x1b[31m${root}\\app.js https://owned.invalid/token?a=secret\x00\n`),
  );
  const first = observation.snapshot();
  const tail = first.launches[0].stderr;
  assert.equal(tail.text, "[owned-path]\\app.js [url]\n");
  assert.deepEqual(tail.redactions, { ownedRoots: true, urls: true, ansi: true, controls: true });
  first.launches[0].events[0].cached.pid = 999;
  first.launches[0].stderr.firstData.sequence = 999;
  assert.equal(observation.snapshot().launches[0].events[0].cached.pid, 101);
  assert.notEqual(observation.snapshot().launches[0].stderr.firstData.sequence, 999);
  const cap = 64 * 1024;
  observation.appended(child, "stdout", Buffer.alloc(cap, 255));
  const rendered = observation.snapshot().launches[0].stdout;
  assert.equal(rendered.textTruncated, true);
  assert.ok(rendered.textBytes <= cap);
  assert.equal(rendered.retainedBytes, cap);
  observation.appended(child, "stderr", "not a default pipe Buffer");
  assert.equal(observation.snapshot().recordingFailed, true);
  assert.equal(observation.snapshot().launches[0].stderr.recordingFailed, true);
});

test("actual transport observes same-child SDK cleanup before terminate and callback faults never suppress custody", async () => {
  const { installWindowsElectronDirectTransport, knownPlaywrightElectronVector } =
    await import("./windows-electron-direct-transport.mjs");
  for (const outcome of ["recorded", "throw", "object"]) {
    const { observation, child } = diagnosticFixture();
    const order = [];
    const settlement = { status: "cleaned" };
    const monitor = {
      completed: Promise.resolve(settlement),
      terminate() {
        order.push("terminate");
        return this.completed;
      },
    };
    const fake = {
      spawn: () => child,
      spawnSync() {
        throw Error("No native taskkill may execute");
      },
    };
    const context = {
      executable: "C:\\owned\\electron.exe",
      args: ["--inspect-brk=0"],
      home: "C:\\owned\\home",
      cwd: "C:\\owned\\home",
      platform: "win32",
      onCapturedSpawn: (actual) => {
        assert.strictEqual(actual, child);
        return monitor;
      },
      reportFailure: () => order.push("fallback-recorded"),
      onCleanupRequested: (actual) => {
        assert.strictEqual(actual, child);
        order.push("callback");
        if (outcome === "throw") throw Error("private callback stack excluded");
        if (outcome === "object") return { text: "arbitrary output refused" };
        return observation.cleanupRequested(actual);
      },
    };
    const transport = installWindowsElectronDirectTransport(context, {
      children: fake,
      syncExports: () => {},
    });
    try {
      fake.spawn(knownPlaywrightElectronVector(context).command, [], {
        cwd: context.cwd,
        env: { HOME: context.home, USERPROFILE: context.home },
        shell: true,
        detached: false,
        stdio: ["ignore", "pipe", "pipe", "pipe", "pipe"],
      });
      child.exitCode = 3221225477;
      child.emit("exit", child.exitCode, null);
      const result = fake.spawnSync(`taskkill /pid ${child.pid} /T /F`, {
        shell: true,
        windowsHide: true,
      });
      assert.equal(result.status, null);
      assert.deepEqual(order, ["fallback-recorded", "callback", "terminate"]);
      await monitor.completed;
      await Promise.resolve();
      const request = transport.receipt().cleanupRequests[0];
      assert.equal(request.settlement.status, "cleaned");
      assert.equal(
        request.launchDiagnostics.status,
        outcome === "recorded"
          ? "recorded"
          : outcome === "throw"
            ? "callback-failed"
            : "unavailable",
      );
      if (outcome === "recorded") {
        const event = observation.snapshot().launches[0].events.at(-1);
        assert.equal(request.launchDiagnostics.sequence, event.sequence);
        assert.equal(event.kind, "sdk-taskkill-suppressed");
        assert.equal(event.cached.exitCode, 3221225477);
      } else assert.equal(request.launchDiagnostics.sequence, null);
      assert.equal(transport.receipt().unsafeFallbackDenied, true);
      assert.equal(transport.receipt().nativeTaskkillExecuted, false);
      assert.equal(transport.receipt().failures.length, 1);
      assert.equal(JSON.stringify(transport.receipt()).includes("private callback"), false);
      assert.equal(JSON.stringify(transport.receipt()).includes("arbitrary output"), false);
    } finally {
      transport.restoreSpawn();
    }
  }
});
