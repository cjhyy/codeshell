import { deepStrictEqual, doesNotMatch, equal, match, throws } from "node:assert/strict";
import { test } from "node:test";
import {
  parsePosixProcessSnapshot,
  parseWindowsProcessSnapshot,
  snapshotElectronTestProcesses,
} from "./electron-test-process-snapshot.mjs";

const windowsRows = [
  { ProcessId: 10, ParentProcessId: 1, CreationDate: "2026-10-16T05:06:07.1234567Z" },
  { ProcessId: 11, ParentProcessId: 10, CreationDate: "2026-10-16T05:06:08.7654321Z" },
];
const posixRows = "   10 1 Fri Oct 16 05:06:07 2026\n11 10 Fri Oct 16 05:06:08 2026\n";

test("Windows metadata parsing preserves full creation precision and only identity fields", () => {
  deepStrictEqual(parseWindowsProcessSnapshot(`\uFEFF${JSON.stringify(windowsRows)}`), [
    { pid: 10, ppid: 1, birth: windowsRows[0].CreationDate },
    { pid: 11, ppid: 10, birth: windowsRows[1].CreationDate },
  ]);
  deepStrictEqual(parseWindowsProcessSnapshot("[]"), []);
  deepStrictEqual(
    parseWindowsProcessSnapshot(JSON.stringify([{ ...windowsRows[0], ParentProcessId: 0 }])),
    [{ pid: 10, ppid: 0, birth: windowsRows[0].CreationDate }],
  );
});

test("Windows malformed, ambiguous or extra metadata is rejected without exposing payload", () => {
  const secret = "PRIVATE_SYNTHETIC_PROCESS_OUTPUT";
  for (const output of [
    secret,
    JSON.stringify(windowsRows[0]),
    JSON.stringify([windowsRows[0], windowsRows[0]]),
    ...[
      { ProcessId: 0 },
      { ProcessId: -10 },
      { ProcessId: 1.5 },
      { ProcessId: Number.MAX_SAFE_INTEGER + 1 },
      { ParentProcessId: -1 },
      { CreationDate: null },
      { CreationDate: "2026-02-30T05:06:07.1234567Z" },
      { CreationDate: "2026-10-16T05:06:07.1234567+01:00" },
      { CommandLine: secret },
    ].map((change) => JSON.stringify([{ ...windowsRows[0], ...change }])),
  ])
    throws(
      () => parseWindowsProcessSnapshot(output),
      (error) => {
        equal(error.code, "ELECTRON_TEST_PROCESS_SNAPSHOT_INVALID");
        doesNotMatch(error.message, /PRIVATE_SYNTHETIC/);
        equal(error.cause, undefined);
        return true;
      },
    );
});

test("POSIX metadata parsing accepts native ps spacing and excludes kernel PID zero", () => {
  deepStrictEqual(parsePosixProcessSnapshot(`0 0 Fri Oct 16 05:06:06 2026\n${posixRows}`), [
    { pid: 10, ppid: 1, birth: "Fri Oct 16 05:06:07 2026" },
    { pid: 11, ppid: 10, birth: "Fri Oct 16 05:06:08 2026" },
  ]);
  deepStrictEqual(parsePosixProcessSnapshot("\n"), []);
  for (const output of ["PID PPID STARTED", "10 1 unknown", `${posixRows}${posixRows}`])
    throws(() => parsePosixProcessSnapshot(output), /Invalid.*metadata/);
});

test("both parsers reject oversized output before accepting partial identities", () => {
  const oversized = " ".repeat(8 * 1024 * 1024 + 1);
  throws(() => parsePosixProcessSnapshot(oversized), /Invalid.*metadata/);
  throws(() => parseWindowsProcessSnapshot(oversized), /Invalid.*metadata/);
});

test("Windows query uses fixed native PowerShell without profiles, bypass or sensitive fields", () => {
  let calls = 0;
  const rows = snapshotElectronTestProcesses({
    platform: "win32",
    environment: { SystemRoot: "C:\\Windows", PRIVATE_PROVIDER_KEY: "operator-secret" },
    execFile(executable, args, options) {
      calls++;
      equal(executable, "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe");
      deepStrictEqual(args.slice(0, 4), ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command"]);
      match(
        args[4],
        /Get-CimInstance -ClassName Win32_Process -Property ProcessId,ParentProcessId,CreationDate/,
      );
      doesNotMatch(
        args.join(" "),
        /ExecutionPolicy|Bypass|CommandLine|Environment|Invoke-Expression/i,
      );
      deepStrictEqual(options.env, {
        SystemRoot: "C:\\Windows",
        WINDIR: "C:\\Windows",
        PATH: "C:\\Windows\\System32",
      });
      equal(options.timeout, 5_000);
      equal(options.maxBuffer, 8 * 1024 * 1024);
      equal(options.windowsHide, true);
      equal(options.shell, undefined);
      deepStrictEqual(options.stdio, ["ignore", "pipe", "pipe"]);
      return JSON.stringify(windowsRows);
    },
  });
  equal(calls, 1);
  equal(rows.length, 2);
});

for (const platform of ["darwin", "linux"])
  test(`${platform} queries the same bounded ps identity columns with a fixed locale`, () => {
    snapshotElectronTestProcesses({
      platform,
      environment: { NODE_OPTIONS: "untrusted", PRIVATE_PROVIDER_KEY: "operator-secret" },
      execFile(executable, args, options) {
        equal(executable, "/bin/ps");
        deepStrictEqual(args, ["-axo", "pid=,ppid=,lstart="]);
        deepStrictEqual(options.env, { PATH: "/usr/bin:/bin", LC_ALL: "C" });
        equal(options.timeout, 1_500);
        return posixRows;
      },
    });
  });

test("unsupported platform and non-canonical Windows roots fail before any query", () => {
  let calls = 0;
  const execFile = () => calls++;
  throws(() => snapshotElectronTestProcesses({ platform: "freebsd", execFile }), /Unsupported/);
  for (const SystemRoot of [undefined, "powershell.exe", "C:\\Windows\\..\\other", "C:\\Windows\n"])
    throws(
      () =>
        snapshotElectronTestProcesses({ platform: "win32", environment: { SystemRoot }, execFile }),
      /canonical SystemRoot/,
    );
  equal(calls, 0);
});

test("native query failure fails closed without raw stderr, cause or fallback query", () => {
  for (const platform of ["darwin", "linux", "win32"]) {
    let calls = 0;
    throws(
      () =>
        snapshotElectronTestProcesses({
          platform,
          environment: { SystemRoot: "C:\\Windows" },
          execFile() {
            calls++;
            throw Object.assign(new Error("PRIVATE_SYNTHETIC_QUERY_SECRET"), {
              stderr: "PRIVATE_SYNTHETIC_STDERR",
            });
          },
        }),
      (error) => {
        equal(error.code, "ELECTRON_TEST_PROCESS_QUERY_FAILED");
        doesNotMatch(error.message, /PRIVATE_SYNTHETIC/);
        equal(error.cause, undefined);
        return true;
      },
    );
    equal(calls, 1);
  }
});

test("the current real host returns the test controller's own PID and parent metadata", () => {
  const rows = snapshotElectronTestProcesses();
  const own = rows.find((row) => row.pid === process.pid);
  equal(own?.ppid, process.ppid);
  equal(typeof own?.birth, "string");
  equal(own.birth.length > 0, true);
  deepStrictEqual(Object.keys(own).sort(), ["birth", "pid", "ppid"]);
});
