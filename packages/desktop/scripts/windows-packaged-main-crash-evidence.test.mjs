import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, existsSync } from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import { join, win32 } from "node:path";
import { test } from "node:test";

// Install before importing either actual leaf. No native transport is permitted.
process.env.GITHUB_ACTIONS = "false";
let nativeAttempts = 0;
const forbidden = () => {
  nativeAttempts++;
  throw Error("Native operation forbidden by this pure contract");
};
for (const key of ["spawn", "spawnSync", "exec", "execSync", "execFile", "execFileSync", "fork"])
  children[key] = forbidden;
process.kill = forbidden;
syncBuiltinESMExports();
const {
  capturePackagedMainDiagnosticSources,
  collectPackagedMainCrashEvidence,
  recordPackagedMainFirstError,
} = await import("./windows-packaged-main-crash-evidence.mjs");
const { createBunTestEnvironment } = await import("../../../scripts/bun-test-completion.mjs");
const { createPackagedStartupObservation } = await import("./packaged-startup-observation.mjs");

const sha = (bytes) => createHash("sha256").update(bytes).digest("hex");
const birth = "2026-10-17T17:45:00.5206260Z";
const fileTime = (
  BigInt(Date.UTC(2026, 9, 17, 17, 45)) * 10_000n +
  116_444_736_000_000_000n +
  5_206_260n
).toString();
const home = "C:\\owned\\codeshell-packaged-ui-JQIJE4\\home";
const executable = "D:\\owned\\package\\win-unpacked\\code-shell.exe";
const guid = "124a3bcd-1234-5678-9012-abcdef123456";
const ci = {
  GITHUB_ACTIONS: "true",
  RUNNER_OS: "Windows",
  RUNNER_ARCH: "X64",
  RUNNER_ENVIRONMENT: "github-hosted",
  ImageOS: "win22",
  GITHUB_REPOSITORY: "cjhyy/codeshell",
  GITHUB_RUN_ID: "39054487947",
  GITHUB_SHA: "a".repeat(40),
};
const sourceRead = (path) => Buffer.from(`owned source for ${path}`);
const sourcePins = capturePackagedMainDiagnosticSources(sourceRead);
const applicationRow = () => ({
  eventId: 1000,
  provider: "Application Error",
  eventUTC: "2026-10-17T17:45:01.1234567Z",
  processId: "0x788",
  processCreationTime: `0x${BigInt(fileTime).toString(16)}`,
  appPath: executable,
  exceptionCode: "c0000005",
  moduleName: "owned-example.dll",
  faultingOffset: "0000000000001234",
  reportId: guid,
});
const wer = () => ({
  eventId: 1001,
  provider: "Windows Error Reporting",
  eventUTC: "2026-10-17T17:45:01.9999999Z",
  reportId: guid,
});
const projection = (rows = [applicationRow()], windowsErrors = rows.length === 1 ? [wer()] : []) =>
  // Historical unbound-WER input is intentionally schema 1; PS v2 never emits it.
  rows.length === 0 && windowsErrors.length > 0
    ? JSON.stringify({
        schemaVersion: 1,
        queryStatus: "ok",
        applicationErrors: rows,
        windowsErrors,
      })
    : JSON.stringify({
        schemaVersion: 2,
        queryStatus: "ok",
        applicationErrors: rows,
        windowsErrors,
        accounting: {
          windowStartUTC: birth,
          windowEndUTC: "2026-10-17T17:45:03.0000000Z",
          queryStartedUTC: "2026-10-17T17:45:03.1000000Z",
          queryFinishedUTC: "2026-10-17T17:45:03.2000000Z",
          application: {
            providerRows: rows.length,
            rejectedPid: 0,
            rejectedBirth: 0,
            rejectedPath: 0,
            acceptedTriple: rows.length,
            sameMicrosecondDifferentBirth: 0,
          },
          werQueried: rows.length === 1,
          werProviderRows: windowsErrors.length,
        },
      });
const options = () => ({
  failed: true,
  ci: { ...ci },
  firstError: {
    written: true,
    sha256: "e".repeat(64),
    bytes: 4096,
    truncated: false,
    pid: 1928,
    ppid: 1772,
  },
  context: {
    root: win32.dirname(home),
    home,
    appRoot: win32.dirname(executable),
    executable,
    executableSHA256: "b".repeat(64),
    appTreeSHA256: "c".repeat(64),
  },
  artifacts: {
    platform: "win32",
    arch: "x64",
    unchangedAfterRuntime: true,
    executableSHA256: "b".repeat(64),
    appTreeSHA256: "c".repeat(64),
    beforeAppTreeSHA256: "c".repeat(64),
    asarSHA256: "d".repeat(64),
    managedNodeManifestSHA256: "f".repeat(64),
    mainExits: [{ pid: 1928, mainPid: 1928, code: 3221225477, signal: null }],
    observedProcessSettlements: [
      {
        status: "cleaned",
        queryFailed: false,
        evidenceTruncated: false,
        owned: [{ pid: 1928, ppid: 1772, birth }],
        ownedCount: 1,
        remaining: [],
        remainingCount: 0,
      },
    ],
    observedSignalRequests: { requests: [], truncated: false },
    windowsTransports: [
      {
        pid: 1928,
        directMain: true,
        nativeTaskkillExecuted: false,
        failures: [
          "Playwright requested forced cleanup; native taskkill suppressed for owned custody",
        ],
        cleanupRequests: [{ method: "taskkill suppressed; captured monitor.terminate requested" }],
      },
    ],
  },
  mainGuards: [
    { role: "Main", pid: 1928, ppid: 1772, executable, homeId: sha(home), negativeProbes: 7 },
  ],
  environment: {
    SYSTEMROOT: "C:\\Windows",
    HOME: home,
    USERPROFILE: home,
    APPDATA: win32.join(home, "AppData", "Roaming"),
    LOCALAPPDATA: win32.join(home, "AppData", "Local"),
    XDG_CONFIG_HOME: win32.join(home, ".config"),
    XDG_DATA_HOME: win32.join(home, ".local", "share"),
    TEMP: win32.join(home, "tmp"),
    TMP: win32.join(home, "tmp"),
    TMPDIR: win32.join(home, "tmp"),
    PATH: "must not inherit",
    SECRET_TOKEN: "must not inherit",
    NODE_OPTIONS: "must not inherit",
    PSModulePath: "must not inherit",
    CODESHELL_FLAG: "must not inherit",
  },
  sourcePins: { ...sourcePins },
  observedAt: "2026-10-17T17:45:03.0000000Z",
});
const collect = (value = options(), overrides = {}) =>
  collectPackagedMainCrashEvidence(value, {
    platform: "win32",
    arch: "x64",
    query: () => projection(),
    verifyExecutable: () => {},
    readSource: sourceRead,
    ...overrides,
  });
const refusal = (change) => {
  const value = options();
  change(value);
  let calls = 0;
  const result = collect(value, {
    query: () => {
      calls++;
      return projection();
    },
  });
  assert.equal(result.status, "unknown");
  assert.equal(result.queried, false);
  assert.equal(calls, 0);
};

test("imports and every pure contract run with real native process operations blocked", () => {
  assert.equal(nativeAttempts, 0);
  assert.equal(process.env.GITHUB_ACTIONS, "false");
});

test("exact abnormal guarded Main performs one fixed query and retains the full 100ns birth", () => {
  let calls = 0;
  const result = collect(options(), {
    query: (file, args, opts) => {
      calls++;
      assert.equal(file, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
      assert.equal(args.length, 5);
      assert.ok(args[4].endsWith("windows-nsis-crash-evidence.ps1"));
      assert.deepEqual(JSON.parse(opts.input), {
        pid: 1928,
        path: executable,
        fileTime,
        observedFileTime: (BigInt(fileTime) - 5_206_260n + 30_000_000n).toString(),
      });
      assert.equal(opts.timeout, 30_000);
      assert.equal(opts.maxBuffer, 65536);
      assert.equal(opts.shell, false);
      assert.equal(opts.windowsHide, true);
      assert.deepEqual(opts.stdio, ["pipe", "pipe", "pipe"]);
      assert.deepEqual(
        Object.keys(opts.env).sort(),
        [
          "SystemRoot",
          "WINDIR",
          "PATH",
          "HOME",
          "USERPROFILE",
          "APPDATA",
          "LOCALAPPDATA",
          "XDG_CONFIG_HOME",
          "XDG_DATA_HOME",
          "TEMP",
          "TMP",
          "TMPDIR",
        ].sort(),
      );
      assert.equal(opts.env.PATH, "C:\\Windows\\System32");
      assert.equal(opts.env.HOME, home);
      return projection();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "matched");
  assert.equal(result.applicationError.exceptionCode, "0xc0000005");
  assert.equal(result.windowsErrorReporting.status, "matched");
  assert.equal(result.executableSHA256, "b".repeat(64));
  assert.deepEqual(result.sourcePins, sourcePins);
  assert.deepEqual(result.applicationError, {
    eventUTC: applicationRow().eventUTC,
    exceptionCode: "0xc0000005",
    moduleBasename: "owned-example.dll",
    faultingOffset: "0x1234",
    reportId: guid,
  });
  assert.deepEqual(
    Object.keys(result.windowsErrorReporting).sort(),
    ["status", "eventUTC", "reportId"].sort(),
  );
  for (const value of [executable, home, "SECRET_TOKEN", "processCreationTime", "appPath"])
    assert.equal(JSON.stringify(result).includes(value), false);
});

test("same PID with changed full birth, foreign executable and unrelated WER do not associate", () => {
  for (const change of [
    { processId: "0x789" },
    { processCreationTime: `0x${(BigInt(fileTime) + 1n).toString(16)}` },
    { appPath: "D:\\foreign\\code-shell.exe" },
    { eventUTC: "2026-10-17T17:44:59.9999999Z" },
  ]) {
    const result = collect(options(), {
      query: () => projection([{ ...applicationRow(), ...change }]),
    });
    assert.equal(result.queried, true);
    assert.equal(result.status, "unknown");
  }
  assert.equal(
    collect(options(), {
      query: () => projection([applicationRow()], [{ ...wer(), reportId: "a".repeat(36) }]),
    }).status,
    "unknown",
  );
  assert.equal(
    collect(options(), { query: () => projection([], [wer()]) }).reason,
    "no-exact-application-event",
  );
});

test("non-hosted, wrong image/repository/source/run or unsupported actual platform never query", () => {
  for (const [key, value] of [
    ["GITHUB_ACTIONS", "false"],
    ["RUNNER_OS", "Linux"],
    ["RUNNER_ARCH", "ARM64"],
    ["RUNNER_ENVIRONMENT", "self-hosted"],
    ["ImageOS", "win25"],
    ["GITHUB_REPOSITORY", "foreign/repo"],
    ["GITHUB_RUN_ID", undefined],
    ["GITHUB_RUN_ID", "0"],
    ["GITHUB_SHA", "bad"],
    ["ACT", "true"],
  ])
    refusal((row) => {
      row.ci[key] = value;
    });
  for (const overrides of [{ platform: "darwin" }, { platform: "linux" }, { arch: "arm64" }]) {
    let calls = 0;
    assert.equal(
      collect(options(), {
        ...overrides,
        query: () => {
          calls++;
        },
      }).queried,
      false,
    );
    assert.equal(calls, 0);
  }
});

test("success, missing/unwritten/truncated first error and unproven child IDs never query", () => {
  refusal((row) => {
    row.failed = false;
  });
  refusal((row) => {
    row.firstError = undefined;
  });
  for (const [key, value] of [
    ["written", false],
    ["truncated", true],
    ["sha256", "bad"],
    ["bytes", 0],
    ["bytes", 65537],
    ["pid", null],
    ["ppid", 0],
  ])
    refusal((row) => {
      row.firstError[key] = value;
    });
});

test("package tree/executable pins, canonical owned HOME and exact executable must match", () => {
  for (const change of [
    (row) => {
      row.context.executable = "D:\\foreign\\code-shell.exe";
    },
    (row) => {
      row.context.home = "C:\\foreign\\home";
    },
    (row) => {
      row.context.root = "C:\\owned\\foreign";
    },
    (row) => {
      row.context.executableSHA256 = "0".repeat(64);
    },
    (row) => {
      row.artifacts.appTreeSHA256 = "0".repeat(64);
    },
    (row) => {
      row.artifacts.beforeAppTreeSHA256 = "0".repeat(64);
    },
    (row) => {
      row.artifacts.unchangedAfterRuntime = false;
    },
    (row) => {
      row.artifacts.asarSHA256 = "bad";
    },
    (row) => {
      row.artifacts.platform = "linux";
    },
  ])
    refusal(change);
});

test("normal exit, signal, wrapper PID and absent/non-direct transport cannot qualify", () => {
  for (const [key, value] of [
    ["code", 0],
    ["code", null],
    ["signal", "SIGTERM"],
    ["mainPid", 1772],
  ])
    refusal((row) => {
      row.artifacts.mainExits[0][key] = value;
    });
  refusal((row) => {
    row.artifacts.mainExits.push({ ...row.artifacts.mainExits[0] });
  });
  for (const [key, value] of [
    ["pid", 1772],
    ["directMain", false],
    ["nativeTaskkillExecuted", true],
  ])
    refusal((row) => {
      row.artifacts.windowsTransports[0][key] = value;
    });
});

test("unproven/queryfailed/truncated/nonempty custody and observed signals cannot qualify", () => {
  for (const [key, value] of [
    ["status", "unproven"],
    ["queryFailed", true],
    ["evidenceTruncated", true],
    ["remainingCount", null],
    ["remaining", [{ pid: 1928 }]],
    ["ownedCount", 2],
  ])
    refusal((row) => {
      row.artifacts.observedProcessSettlements[0][key] = value;
    });
  refusal((row) => {
    row.artifacts.observedSignalRequests.truncated = true;
  });
  refusal((row) => {
    row.artifacts.observedSignalRequests.requests.push({ pid: 1928, signal: "SIGTERM" });
  });
});

test("parent/birth/chronology/cycle/guard and diagnostic time-window contradictions fail closed", () => {
  for (const change of [
    (row) => {
      row.artifacts.observedProcessSettlements[0].owned[0].ppid = 100;
    },
    (row) => {
      row.artifacts.observedProcessSettlements[0].owned[0].birth = birth.slice(0, -2) + "Z";
    },
    (row) => {
      row.artifacts.observedProcessSettlements[0].owned.push({
        pid: 100,
        ppid: 1928,
        birth: "2026-10-17T17:44:59.9999999Z",
      });
      row.artifacts.observedProcessSettlements[0].ownedCount++;
    },
    (row) => {
      row.artifacts.observedProcessSettlements[0].owned.push({ pid: 1772, ppid: 1928, birth });
      row.artifacts.observedProcessSettlements[0].ownedCount++;
    },
    (row) => {
      row.mainGuards[0].homeId = "0".repeat(64);
    },
    (row) => {
      row.mainGuards[0].negativeProbes = 6;
    },
    (row) => {
      row.mainGuards[0].executable = "D:\\foreign\\code-shell.exe";
    },
    (row) => {
      row.mainGuards.push({ ...row.mainGuards[0] });
    },
    (row) => {
      row.observedAt = "2026-10-17T17:44:59.9999999Z";
    },
    (row) => {
      row.observedAt = "2026-10-17T17:55:01.0000000Z";
    },
  ])
    refusal(change);
});

test("all nine existing packaged HOME keys are mandatory; NSIS layout and path aliases are refused", () => {
  for (const key of [
    "HOME",
    "USERPROFILE",
    "APPDATA",
    "LOCALAPPDATA",
    "XDG_CONFIG_HOME",
    "XDG_DATA_HOME",
    "TEMP",
    "TMP",
    "TMPDIR",
  ]) {
    refusal((row) => {
      delete row.environment[key];
    });
    refusal((row) => {
      row.environment[key] = "C:\\foreign\\home";
    });
  }
  refusal((row) => {
    row.environment.TEMP = win32.join(win32.dirname(home), "private-build", "tmp");
  });
  refusal((row) => {
    row.environment.HOME = home + "\\..\\home";
  });
});

test("missing/changed/oversized diagnostic source refuses before any query", () => {
  refusal((row) => {
    delete row.sourcePins.script;
  });
  refusal((row) => {
    row.sourcePins.fixture = "0".repeat(64);
  });
  let calls = 0;
  assert.equal(
    collect(options(), {
      readSource: () => Buffer.alloc(65537),
      query: () => {
        calls++;
      },
    }).queried,
    false,
  );
  assert.equal(
    collect(options(), {
      readSource: () => {
        throw Error("missing");
      },
      query: () => {
        calls++;
      },
    }).queried,
    false,
  );
  assert.equal(calls, 0);
});

test("one query can return only matched/unknown; missing executable, timeout/permission/byte cap remain unknown", () => {
  let calls = 0;
  assert.equal(
    collect(options(), {
      verifyExecutable: () => {
        throw Error("missing");
      },
      query: () => {
        calls++;
      },
    }).queried,
    false,
  );
  assert.equal(calls, 0);
  for (const [code, reason] of [
    ["ETIMEDOUT", "query-timeout"],
    ["EACCES", "permission"],
    ["ENOBUFS", "output-limit"],
    ["other", "query-failed"],
  ]) {
    let count = 0;
    const result = collect(options(), {
      query: () => {
        count++;
        throw Object.assign(Error("private raw cause"), { code });
      },
    });
    assert.equal(count, 1);
    assert.equal(result.queried, true);
    assert.equal(result.status, "unknown");
    assert.equal(result.reason, reason);
    assert.equal(JSON.stringify(result).includes("private raw cause"), false);
  }
  for (const output of [
    "x".repeat(65537),
    "not json",
    projection([applicationRow(), applicationRow()]),
    JSON.stringify({
      schemaVersion: 1,
      queryStatus: "permission",
      applicationErrors: [],
      windowsErrors: [],
    }),
  ])
    assert.equal(collect(options(), { query: () => output }).status, "unknown");
});

test("first cause is synchronously written once to an owned file and existing bytes are never overwritten", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-packaged-first-error-test-"));
  try {
    const file = join(root, "first-error.json");
    const error = Error("original launch failure", { cause: Error("original cause") });
    const result = recordPackagedMainFirstError(file, error, {
      phase: "playwright-launch",
      pid: 1928,
      ppid: 1772,
    });
    assert.equal(result.written, true);
    const bytes = readFileSync(file);
    assert.equal(result.sha256, sha(bytes));
    assert.equal(result.bytes, bytes.length);
    assert.deepEqual(JSON.parse(bytes).firstError, {
      name: "Error",
      message: "original launch failure",
      cause: { name: "Error", message: "original cause" },
    });
    assert.equal(recordPackagedMainFirstError(file, Error("later"), {}).written, false);
    assert.deepEqual(readFileSync(file), bytes);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("diagnostic IO/hostile error cannot throw over original cleanup; large first cause disallows query", () => {
  const hostile = Object.defineProperty({}, "name", {
    get() {
      throw Error("getter");
    },
  });
  let bytes;
  assert.doesNotThrow(() =>
    recordPackagedMainFirstError(
      "unused",
      hostile,
      {},
      {
        write: (_file, value) => {
          bytes = value;
        },
      },
    ),
  );
  assert.equal(JSON.parse(bytes).firstError.message, "Uninspectable thrown value");
  assert.deepEqual(
    recordPackagedMainFirstError(
      "unused",
      Error("first"),
      {},
      {
        write: () => {
          throw Error("IO");
        },
      },
    ),
    { written: false, reason: "first-error-recording-failed" },
  );
  const value = recordPackagedMainFirstError(
    "unused",
    Error("x".repeat(20000)),
    { phase: "playwright-launch", pid: 1928, ppid: 1772 },
    { write: () => {} },
  );
  assert.equal(value.truncated, true);
  refusal((row) => {
    row.firstError = value;
  });
});

const fixtureSource = readFileSync(
  new URL("./packaged-pet-fixture.mjs", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const marker = fixtureSource.indexOf("launchFailed = true;");
const catchStart =
  fixtureSource.lastIndexOf("} catch (error) {", marker) + "} catch (error) {".length;
const catchEnd = fixtureSource.indexOf("} finally {", marker);
const actualCatch = fixtureSource.slice(catchStart, catchEnd);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runCatch = new AsyncFunction(
  "error",
  "onLaunchError",
  "preload",
  "captured",
  "terminateChild",
  "process",
  "startupObservation",
  "startupRecord",
  `
  let launchFailed = false, preloadFailure;
  const launchPhase = "playwright-launch";
  try { ${actualCatch} } catch (caught) {
    return { caught, launchFailed, startupObservation: startupObservation.snapshot() };
  }
`,
);

test("actual fixture catch persists original first cause before preload await and same captured cleanup", async () => {
  assert(marker >= 0 && catchStart > 0 && catchEnd > marker);
  const startupObservation = createPackagedStartupObservation();
  const startupRecord = startupObservation.captured(1928);
  const events = [],
    original = Error("first launch error"),
    child = { pid: 1928, exitCode: null, signalCode: null };
  const result = await runCatch(
    original,
    (error, detail) => {
      events.push("first-error-write");
      assert.equal(startupObservation.snapshot().launches[0].atFailure, null);
      assert.equal(error, original);
      assert.deepEqual(detail, { phase: "playwright-launch", pid: 1928, ppid: 1772 });
    },
    {
      catch: () => {
        events.push("preload-await");
        return Promise.resolve();
      },
    },
    child,
    async (actual) => {
      assert.equal(actual, child);
      events.push("same-custody-cleanup");
    },
    { pid: 1772 },
    startupObservation,
    startupRecord,
  );
  assert.deepEqual(events, ["first-error-write", "preload-await", "same-custody-cleanup"]);
  assert.equal(result.caught.cause, original);
  assert.equal(result.caught.errors[0], original);
  assert.equal(result.launchFailed, true);
  assert.equal(result.startupObservation.recordingFailed, false);
  assert.equal(result.startupObservation.launches[0].failurePhase, "playwright-launch");
  assert.equal(result.startupObservation.launches[0].sdkLaunchReturned, false);
  assert.deepEqual(result.startupObservation.launches[0].atFailure, {
    sdkLaunchReturned: false,
    preloadResultObserved: false,
    privateReceiptWrite: "not-attempted",
  });
});

test("actual fixture catch retains callback IO failure second and still performs original cleanup", async () => {
  const startupObservation = createPackagedStartupObservation();
  const startupRecord = startupObservation.captured(1928);
  const events = [],
    original = Error("original"),
    secondary = Error("recording IO");
  const result = await runCatch(
    original,
    () => {
      events.push("first-write-failed");
      assert.equal(startupObservation.snapshot().launches[0].atFailure, null);
      throw secondary;
    },
    {
      catch: () => {
        events.push("preload-await");
        return Promise.resolve();
      },
    },
    { pid: 1928, exitCode: null, signalCode: null },
    async () => {
      events.push("cleanup");
    },
    { pid: 1772 },
    startupObservation,
    startupRecord,
  );
  assert.deepEqual(events, ["first-write-failed", "preload-await", "cleanup"]);
  assert.equal(result.caught.cause, original);
  assert.deepEqual(result.caught.errors, [original, secondary]);
  assert.equal(result.startupObservation.recordingFailed, false);
  assert.equal(result.startupObservation.launches[0].failurePhase, "playwright-launch");
  assert.equal(result.startupObservation.launches[0].sdkLaunchReturned, false);
  assert.deepEqual(result.startupObservation.launches[0].atFailure, {
    sdkLaunchReturned: false,
    preloadResultObserved: false,
    privateReceiptWrite: "not-attempted",
  });
});

test("actual driver diagnostic call is after settlement; success and unavailable durable flag never query", () => {
  const source = readFileSync(new URL("./e2e-ui-packaged.mjs", import.meta.url), "utf8").replace(
    /\r\n/g,
    "\n",
  );
  const start = source.indexOf("const packagedMainCrashEvidence =");
  const end = source.indexOf("if (result.nativeCalls", start);
  assert(start > source.indexOf("const result = await settlePackagedPet({"));
  assert(end > start);
  const invoke = new Function(
    "result",
    "firstError",
    "diagnosticSourcePins",
    "process",
    "fixture",
    "processEvidence",
    "collectPackagedMainCrashEvidence",
    source.slice(start, end) + "return packagedMainCrashEvidence;",
  );
  let calls = 0;
  const run = (result, firstError, collectFn) =>
    invoke(
      result,
      firstError,
      sourcePins,
      { env: ci },
      { diagnosticContext: () => options().context, env: options().environment },
      { mainGuards: options().mainGuards },
      collectFn,
    );
  assert.equal(
    run({ errors: [] }, undefined, () => {
      calls++;
    }),
    0,
  );
  assert.equal(calls, 0);
  const result = run(
    { errors: [Error("original")], artifacts: options().artifacts },
    { written: false },
    (value) =>
      collect(value, {
        query: () => {
          calls++;
          return projection();
        },
      }),
  );
  assert.equal(result.queried, false);
  assert.equal(calls, 0);
});

test("two actual isolation layers preserve only new CI metadata while provider flags are scrubbed and HOME changes", () => {
  const root = mkdtempSync(join(tmpdir(), "codeshell-packaged-ci-environment-test-"));
  try {
    const base = {
      ...ci,
      HOME: "foreign",
      USERPROFILE: "foreign",
      PROVIDER_TOKEN: "secret",
      ARBITRARY_SECRET: "secret",
      CODESHELL_PROVIDER_FLAGS: "secret",
      NODE_OPTIONS: "secret",
    };
    const outer = createBunTestEnvironment(base, join(root, "outer"));
    const inner = createBunTestEnvironment(outer, join(root, "inner"));
    for (const row of [outer, inner]) {
      for (const key of ["GITHUB_RUN_ID", "RUNNER_ENVIRONMENT", "ImageOS"])
        assert.equal(row[key], ci[key]);
      for (const key of [
        "PROVIDER_TOKEN",
        "ARBITRARY_SECRET",
        "CODESHELL_PROVIDER_FLAGS",
        "NODE_OPTIONS",
      ])
        assert.equal(row[key], undefined);
      assert.equal(existsSync(row.HOME), true);
      assert.equal(row.HOME, row.USERPROFILE);
      assert.equal(row.CODE_SHELL_TEST_HOME, join(row.HOME, ".code-shell"));
    }
    assert.notEqual(outer.HOME, inner.HOME);
    assert.notEqual(inner.HOME, base.HOME);
    assert.equal(nativeAttempts, 0);
  } finally {
    rmSync(root, { recursive: true });
  }
});

test("shared Main collector consumes schema 2 accounting through one injected transport", () => {
  let calls = 0;
  const result = collect(options(), {
    query: () => {
      calls++;
      return projection();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "matched");
  assert.equal(result.queryAccounting.application.acceptedTriple, 1);
  assert.equal(result.queryAccounting.windowStartUTC, birth);
  assert.equal(result.queryAccounting.werQueried, true);
  assert.equal(nativeAttempts, 0);
});

test("shared Main near-birth accounting remains unknown and malformed accounting fails closed", () => {
  const value = JSON.parse(projection([], []));
  Object.assign(value.accounting.application, {
    providerRows: 1,
    rejectedBirth: 1,
    sameMicrosecondDifferentBirth: 1,
  });
  const result = collect(options(), { query: () => JSON.stringify(value) });
  assert.equal(result.status, "unknown");
  assert.equal(result.reason, "no-exact-application-event");
  assert.equal(result.queryAccounting.application.sameMicrosecondDifferentBirth, 1);
  assert.equal(Object.hasOwn(result, "applicationError"), false);
  value.accounting.queryFinishedUTC = "malformed";
  assert.equal(
    collect(options(), { query: () => JSON.stringify(value) }).reason,
    "invalid-projection",
  );
  assert.equal(nativeAttempts, 0);
});
