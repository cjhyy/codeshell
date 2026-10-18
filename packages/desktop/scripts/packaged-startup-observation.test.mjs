import assert from "node:assert/strict";
import { after, test } from "node:test";
import children from "node:child_process";
import { syncBuiltinESMExports } from "node:module";

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
