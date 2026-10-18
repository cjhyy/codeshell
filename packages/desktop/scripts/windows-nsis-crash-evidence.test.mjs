import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import {
  collectNsisCrashEvidence,
  matchNsisCrashEvents,
  windowsBirthToFileTime,
} from "./windows-nsis-crash-evidence.mjs";

const birth = "2026-10-17T13:51:50.6737150Z";
// Independently calculated using whole UTC seconds plus all seven fractional digits.
const fileTime = (
  BigInt(Date.UTC(2026, 9, 17, 13, 51, 50)) * 10000n +
  116444736000000000n +
  6737150n
).toString();
const target = {
  pid: 5196,
  birth,
  fileTime,
  path: "D:\\owned\\artifacts\\code-shell-Setup-1.0.0.exe",
  observedAt: "2026-10-17T13:51:52.0000000Z",
};
const guid = "124a3bcd-1234-5678-9012-abcdef123456";
const row = () => ({
  eventId: 1000,
  provider: "Application Error",
  eventUTC: "2026-10-17T13:51:51.1234567Z",
  processId: "0x144c",
  processCreationTime: `0x${BigInt(fileTime).toString(16)}`,
  appPath: target.path,
  exceptionCode: "c0000005",
  moduleName: "example.dll",
  faultingOffset: "0000000000001234",
  reportId: guid,
});
const wer = () => ({
  eventId: 1001,
  provider: "Windows Error Reporting",
  eventUTC: "2026-10-17T13:51:51.9999999Z",
  reportId: guid,
});
const projection = (applicationErrors = [row()], windowsErrors = [wer()]) =>
  JSON.stringify({ schemaVersion: 1, queryStatus: "ok", applicationErrors, windowsErrors });
const privateEnvironment = {
  HOME: "D:\\owned\\private-build\\home",
  USERPROFILE: "D:\\owned\\private-build\\home",
  APPDATA: "D:\\owned\\private-build\\home\\AppData\\Roaming",
  LOCALAPPDATA: "D:\\owned\\private-build\\home\\AppData\\Local",
  XDG_CONFIG_HOME: "D:\\owned\\private-build\\home\\.config",
  XDG_DATA_HOME: "D:\\owned\\private-build\\home\\.local\\share",
  XDG_CACHE_HOME: "D:\\owned\\private-build\\home\\.cache",
  XDG_STATE_HOME: "D:\\owned\\private-build\\home\\.local\\state",
  XDG_RUNTIME_DIR: "D:\\owned\\private-build\\home\\.run",
  TEMP: "D:\\owned\\private-build\\tmp",
  TMP: "D:\\owned\\private-build\\tmp",
  TMPDIR: "D:\\owned\\private-build\\tmp",
};
const options = () => ({
  root: "D:\\owned",
  ci: { runner: "github-hosted/windows-2022/x64", run: "39037383789", source: "a".repeat(40) },
  installer: { path: target.path, sha256: "b".repeat(64), size: 123 },
  environment: {
    ...privateEnvironment,
    SystemRoot: "C:\\Windows",
    PATH: "foreign",
    SECRET_TOKEN: "must not inherit",
    NODE_OPTIONS: "must not inherit",
    PSModulePath: "must not inherit",
    CODE_SHELL_HOME: "D:\\owned\\private-build\\home\\.code-shell",
    CODE_SHELL_TEST_HOME: "D:\\owned\\private-build\\home\\.code-shell",
    CODESHELL_FLAG: "must not inherit",
  },
  observedAt: target.observedAt,
  operation: {
    label: "install",
    status: "failed",
    result: { code: 3221225477, signal: null },
    exitObserved: { code: 3221225477, signal: null },
    cachedExit: { code: 3221225477, signal: null },
    errors: [],
    signalRequests: [],
    child: { pid: target.pid, ppid: 2024, birth },
    command: { executable: target.path, sha256: "b".repeat(64), size: 123 },
    settlement: {
      status: "cleaned",
      owned: [{ pid: target.pid, ppid: 2024, birth }],
      ownedCount: 1,
      remaining: [],
      remainingCount: 0,
      queryFailed: false,
      evidenceTruncated: false,
    },
  },
});
const collect = (value = options(), overrides = {}) =>
  collectNsisCrashEvidence(value, {
    platform: "win32",
    verifyExecutable: () => {},
    query: () => projection(),
    ...overrides,
  });

test("FILETIME conversion retains every CIM 100ns digit and distinguishes same millisecond births", () => {
  assert.equal(windowsBirthToFileTime(birth), fileTime);
  assert.equal(
    BigInt(windowsBirthToFileTime(birth.replace("7150", "7151"))) - BigInt(fileTime),
    1n,
  );
  assert.equal(windowsBirthToFileTime("1601-01-01T00:00:00.0000000Z"), "0");
  for (const bad of [
    "1600-12-31T23:59:59.9999999Z",
    "2026-02-30T00:00:00.0000000Z",
    birth.replace("7150", "715"),
    birth.replace("Z", "+00:00"),
    "invalid",
  ])
    assert.throws(() => windowsBirthToFileTime(bad));
});

test("a valid 1000 triple precedes ReportId-only 1001 association; public result excludes identity/raw fields", () => {
  const result = matchNsisCrashEvents(projection(), target);
  assert.equal(result.status, "matched");
  assert.deepEqual(result.applicationError, {
    eventUTC: row().eventUTC,
    exceptionCode: "0xc0000005",
    moduleBasename: "example.dll",
    faultingOffset: "0x1234",
    reportId: guid,
  });
  assert.equal(result.windowsErrorReporting.status, "matched");
  for (const forbidden of [
    target.path,
    "processId",
    "processCreationTime",
    "appPath",
    "Message",
    "XML",
    "5196",
  ])
    assert.equal(JSON.stringify(result).includes(forbidden), false);
  assert.equal(matchNsisCrashEvents(projection([], [wer()]), target).status, "unknown");
});

test("PID reuse, one 100ns birth change, foreign path and path aliases cannot bind", () => {
  for (const changes of [
    { processId: "0x144d" },
    { processCreationTime: `0x${(BigInt(fileTime) + 1n).toString(16)}` },
    { appPath: "D:\\foreign\\Setup.exe" },
    { appPath: "D:\\owned\\artifacts\\..\\artifacts\\code-shell-Setup-1.0.0.exe" },
  ]) {
    assert.equal(
      matchNsisCrashEvents(projection([{ ...row(), ...changes }]), target).status,
      "unknown",
    );
  }
  assert.equal(
    matchNsisCrashEvents(projection([{ ...row(), appPath: target.path.toUpperCase() }]), target)
      .status,
    "matched",
  );
});

test("missing/foreign schema, unsafe modules, event-window mismatch and unbound WER stay unknown", () => {
  for (const changes of [
    { provider: "Foreign" },
    { eventId: 1001 },
    { processCreationTime: undefined },
    { message: "private raw text" },
    { moduleName: "C:\\private\\bad.dll" },
    { moduleName: ".." },
    { exceptionCode: "nothex" },
    { faultingOffset: "1".repeat(17) },
    { reportId: "bad" },
    { reportId: "00000000-0000-0000-0000-000000000000" },
    { eventUTC: "2026-10-17T13:51:49.0000000Z" },
    { eventUTC: "2026-10-17T13:51:53.0000000Z" },
  ])
    assert.equal(
      matchNsisCrashEvents(projection([{ ...row(), ...changes }]), target).status,
      "unknown",
    );
  assert.equal(
    matchNsisCrashEvents(
      projection([row()], [{ ...wer(), reportId: "224a3bcd-1234-5678-9012-abcdef123456" }]),
      target,
    ).status,
    "unknown",
  );
  assert.equal(
    matchNsisCrashEvents(projection([row()], [{ ...wer(), eventUTC: birth }]), target).status,
    "unknown",
  );
  assert.equal(
    matchNsisCrashEvents(projection([row()], []), target).windowsErrorReporting.reason,
    "no-related-event",
  );
});

test("bounded parser rejects overflow, invalid JSON, extra root data, permission and duplicate matches", () => {
  for (const output of [
    "x".repeat(65537),
    "{",
    projection(Array.from({ length: 9 }, row)),
    projection([row(), row()]),
    JSON.stringify({ ...JSON.parse(projection()), environment: "private" }),
  ])
    assert.equal(matchNsisCrashEvents(output, target).status, "unknown");
  for (const queryStatus of [
    "permission",
    "event-limit",
    "event-shape",
    "query-failed",
    "input-invalid",
  ])
    assert.equal(
      matchNsisCrashEvents(
        JSON.stringify({ schemaVersion: 1, queryStatus, applicationErrors: [], windowsErrors: [] }),
        target,
      ).reason,
      queryStatus,
    );
});

test("single fixed PS7 query has original 30s read-only budget, stdin identity and scrubbed environment", () => {
  let calls = 0;
  const result = collect(options(), {
    query: (exe, args, config) => {
      calls++;
      assert.equal(exe, "C:\\Program Files\\PowerShell\\7\\pwsh.exe");
      assert.deepEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-File"]);
      assert.ok(args[4].endsWith("windows-nsis-crash-evidence.ps1"));
      assert.deepEqual(JSON.parse(config.input), {
        pid: target.pid,
        path: target.path,
        fileTime,
        observedFileTime: windowsBirthToFileTime(target.observedAt),
      });
      assert.equal(
        config.input.includes("2026-"),
        false,
        "JSON timestamps must not be auto-coerced by PowerShell",
      );
      assert.deepEqual(config.env, {
        ...privateEnvironment,
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
      });
      assert.equal(config.timeout, 30000);
      assert.equal(config.maxBuffer, 65536);
      assert.equal(config.shell, false);
      assert.deepEqual(config.stdio, ["pipe", "pipe", "pipe"]);
      assert.equal(config.windowsHide, true);
      return projection();
    },
  });
  assert.equal(calls, 1);
  assert.equal(result.status, "matched");
  assert.match(result.scriptSHA256, /^[a-f0-9]{64}$/);
});

test("all actual owned HOME/config/temp keys are required; missing/foreign/alias never queries", () => {
  for (const key of Object.keys(privateEnvironment)) {
    for (const replacement of [
      undefined,
      "C:\\Users\\foreign",
      "D:\\owned\\private-build\\home\\..\\home",
    ]) {
      const value = options();
      value.environment[key] = replacement;
      let queries = 0;
      const result = collect(value, {
        query: () => {
          queries++;
          return projection();
        },
      });
      assert.equal(queries, 0);
      assert.equal(result.queried, false);
      assert.equal(result.reason, "unproven-query-isolation");
    }
  }
});

test("no query without original actual exit, exact pinned owned birth and completed clean custody", () => {
  const mutations = [
    (v) => {
      v.operation.result.code = 0;
    },
    (v) => {
      delete v.operation.exitObserved;
    },
    (v) => {
      v.operation.cachedExit.code = 1;
    },
    (v) => {
      v.operation.result.signal = "SIGKILL";
    },
    (v) => {
      v.operation.settlement.status = "unproven";
    },
    (v) => {
      v.operation.settlement.queryFailed = true;
    },
    (v) => {
      v.operation.settlement.evidenceTruncated = true;
    },
    (v) => {
      v.operation.settlement.remainingCount = 1;
    },
    (v) => {
      v.operation.settlement.owned[0].birth = birth.replace("7150", "7151");
    },
    (v) => {
      v.operation.signalRequests.push({ pid: target.pid, signal: "SIGTERM" });
    },
    (v) => {
      v.operation.errors.push("failed");
    },
    (v) => {
      v.operation.child.pid = 0;
    },
    (v) => {
      v.installer.sha256 = "c".repeat(64);
    },
    (v) => {
      v.installer.path = "D:\\foreign\\Setup.exe";
    },
    (v) => {
      v.ci.runner = "self-hosted";
    },
    (v) => {
      v.observedAt = "2026-10-17T14:51:50.6737150Z";
    },
  ];
  for (const mutate of mutations) {
    const value = options();
    mutate(value);
    assert.equal(
      collect(value, {
        query: () => {
          throw Error("Query must not run");
        },
      }).queried,
      false,
    );
  }
  assert.equal(collectNsisCrashEvidence(options(), { platform: "darwin" }).queried, false);
  let calls = 0;
  const unavailable = collect(options(), {
    verifyExecutable: () => {
      throw Error("private path");
    },
    query: () => {
      calls++;
    },
  });
  assert.equal(calls, 0);
  assert.equal(unavailable.reason, "query-executable-unavailable");
});

test("timeout/permission/output failure execute once, never leak native error and never turn acceptance green", () => {
  for (const [code, reason] of [
    ["ETIMEDOUT", "query-timeout"],
    ["EACCES", "permission"],
    ["ENOBUFS", "output-limit"],
    ["other", "query-failed"],
  ]) {
    let calls = 0;
    const value = options();
    const result = collect(value, {
      query: () => {
        calls++;
        throw Object.assign(Error("SECRET path argv env"), { code });
      },
    });
    assert.equal(calls, 1);
    assert.equal(result.reason, reason);
    assert.equal(result.status, "unknown");
    assert.equal(JSON.stringify(result).includes("SECRET"), false);
    assert.equal(value.operation.status, "failed");
    assert.equal(value.operation.result.code, 3221225477);
  }
  const hostile = collect(options(), {
    query: () => {
      throw Object.defineProperty({}, "code", {
        get() {
          throw Error("private");
        },
      });
    },
  });
  assert.equal(hostile.reason, "query-failed");
});

test("actual PS source is finite/read-only and requires full identity before WER query", () => {
  const ps = readFileSync(new URL("./windows-nsis-crash-evidence.ps1", import.meta.url), "utf8");
  assert.equal((ps.match(/Get-WinEvent /g) ?? []).length, 1);
  assert.match(
    ps,
    /LogName = 'Application'; ProviderName = \$provider; Id = \$id; StartTime = \$start; EndTime = \$end/,
  );
  assert.match(ps, /\$filter.ReportId = \$reportId/);
  assert.match(ps, /-MaxEvents 9 -ErrorAction Stop/);
  assert.match(ps, /ToFileTimeUtc\(\) -ne \$birthExpected/);
  assert.match(ps, /\[DateTime\]::FromFileTimeUtc/);
  assert.doesNotMatch(ps, /ParseExact|-DateKind/);
  assert.match(
    ps,
    /\$eventPid -ne \$pidExpected -or \$eventBirth -ne \$birthExpected -or -not \[string\]::Equals\(\$fields.AppPath, \$target.path/,
  );
  assert.ok(
    ps.indexOf("$result.applicationErrors = $application") <
      ps.indexOf("Read-Events 'Windows Error Reporting'"),
  );
  for (const forbidden of [
    /\.Message\s*\)/,
    /Get-Process/,
    /Get-CimInstance/,
    /Set-Item/,
    /New-Item/,
    /Start-Process/,
    /ExecutionPolicy/,
    /Write-Host/,
    /Write-Error/,
  ])
    assert.doesNotMatch(ps, forbidden);
});

const runnerSource = readFileSync(
  new URL("./smoke-windows-nsis-install.mjs", import.meta.url),
  "utf8",
).replace(/\r\n/g, "\n");
const catchStart = runnerSource.indexOf('  } catch (error) {\n    report.status = "failed";');
const catchBoundary = "\n  } finally {";
const catchEnd = runnerSource.indexOf(catchBoundary, catchStart) + 1;
assert.ok(
  catchStart > 0 && catchEnd > catchStart,
  "Actual runner outer failure boundary must be present",
);
assert.equal(
  runnerSource.indexOf(catchBoundary, catchEnd),
  -1,
  "Actual runner outer finally must be unique after the catch",
);
const catchBody = runnerSource.slice(catchStart + "  } catch (error) {".length, catchEnd);
const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const runCatch = new AsyncFunction(
  "error",
  "report",
  "safeError",
  "checkpoint",
  "process",
  "collectNsisCrashEvidence",
  "root",
  "ci",
  "environment",
  "writeExclusive",
  "join",
  "recordingFailure",
  catchBody,
);

for (const mode of ["match", "unknown", "query-throw", "write-throw", "other-stage"]) {
  test(`actual runner catch keeps original failure before passive query; ${mode}`, async () => {
    const original = Error("original install failure");
    const report = {
      phase: mode === "other-stage" ? "preflight" : "install",
      failures: [],
      processes: [{ label: "install", settlement: { status: "cleaned" } }],
      installer: {},
    };
    const fakeProcess = { exitCode: 0 },
      seen = [],
      recorded = [];
    await runCatch(
      original,
      report,
      (error) => ({ name: error.name, message: error.message }),
      (kind, _details, diagnostic) => {
        assert.equal(kind, "first-error");
        assert.equal(diagnostic.error.message, original.message);
        seen.push(kind);
      },
      fakeProcess,
      (value) => {
        seen.push("query");
        assert.equal(fakeProcess.exitCode, 1);
        assert.equal(report.firstError.message, original.message);
        assert.equal(value.operation.settlement.status, "cleaned");
        assert.match(value.observedAt, /\.\d{7}Z$/);
        if (mode === "query-throw") throw Error("private query error");
        return { status: mode === "unknown" ? "unknown" : "matched" };
      },
      "D:\\owned",
      {},
      {},
      async (path, value) => {
        seen.push("write");
        assert.equal(path, "D:\\owned/install-crash-evidence.json");
        assert.equal(value, report.installCrashEvidence);
        if (mode === "write-throw") throw Error("private IO error");
      },
      (root, name) => `${root}/${name}`,
      (message) => recorded.push(message),
    );
    assert.deepEqual(
      seen,
      mode === "other-stage"
        ? ["first-error"]
        : mode === "query-throw"
          ? ["first-error", "query"]
          : ["first-error", "query", "write"],
    );
    assert.equal(report.status, "failed");
    assert.equal(fakeProcess.exitCode, 1);
    assert.deepEqual(report.failures, [
      { phase: report.phase, name: "Error", message: original.message },
    ]);
    assert.deepEqual(
      recorded,
      mode.endsWith("throw") ? ["Passive installer event evidence recording failed"] : [],
    );
  });
}
