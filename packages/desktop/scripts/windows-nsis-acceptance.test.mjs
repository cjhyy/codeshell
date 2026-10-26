import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { win32 } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import * as acceptance from "./windows-nsis-acceptance.mjs";
import {
  NSIS_IDENTITY,
  NSIS_UI_ACTIONS,
  assertHostedWindowsNsis,
  assertInstalledPayload,
  assertInstalledRegistration,
  assertNoNamedApp,
  assertNormalNsisProcess,
  assertNsisInstalledUi,
  assertNsisPreflight,
  assertNsisPayload,
  assertNsisUninstalled,
  assertOwnedNsisCache,
  assertProductionNsis,
  nsisBuildArguments,
  nsisInstallArguments,
  nsisUninstallArguments,
  expectedRegistryRows,
} from "./windows-nsis-acceptance.mjs";

const clone = (value) => globalThis.structuredClone(value);
const root = "D:\\a\\_temp\\codeshell-nsis-owned";
const installation = `${root}\\installation`;
const sha = "a".repeat(64);
const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
const hosted = () => ({
  platform: "win32",
  arch: "x64",
  environment: {
    GITHUB_ACTIONS: "true",
    RUNNER_OS: "Windows",
    RUNNER_ENVIRONMENT: "github-hosted",
    ImageOS: "win22",
    GITHUB_REPOSITORY: "cjhyy/codeshell",
    GITHUB_RUN_ID: "123456",
    GITHUB_SHA: "b".repeat(40),
  },
});
const before = () => {
  const knownFolders = {
    desktop: "C:\\Users\\runneradmin\\Desktop",
    programs: "C:\\Users\\runneradmin\\AppData\\Roaming\\Microsoft\\Windows\\Start Menu\\Programs",
    local: "C:\\Users\\runneradmin\\AppData\\Local",
    userPrograms: "C:\\Users\\runneradmin\\AppData\\Local\\Programs",
    machine32: "C:\\Program Files (x86)",
    machine64: "C:\\Program Files",
  };
  const sources = {
    desktop: [knownFolders.desktop, "code-shell.lnk"],
    startMenu: [knownFolders.programs, "code-shell.lnk"],
    cache: [knownFolders.local, NSIS_IDENTITY.cacheDirectory],
    userDefault: [knownFolders.userPrograms, "code-shell"],
    machine32: [knownFolders.machine32, "code-shell"],
    machine64: [knownFolders.machine64, "code-shell"],
  };
  return {
    knownFolders,
    processes: [],
    registry: expectedRegistryRows().map((row) => ({ ...row, present: false, values: null })),
    paths: Object.fromEntries(
      Object.entries(sources).map(([name, parts]) => [
        name,
        {
          path: win32.join(...parts),
          kind: "absent",
          parentsPlain: true,
        },
      ]),
    ),
  };
};
const installed = () => {
  const value = before();
  for (const row of value.registry)
    if (row.hive === "CurrentUser") {
      row.present = true;
      row.values = row.key.includes("\\Uninstall\\")
        ? {
            DisplayName: `code-shell ${pkg.version}`,
            DisplayVersion: pkg.version,
            UninstallString: `"${installation}\\Uninstall code-shell.exe" /currentuser`,
            QuietUninstallString: `"${installation}\\Uninstall code-shell.exe" /currentuser /S`,
            DisplayIcon: `${installation}\\code-shell.exe,0`,
          }
        : { InstallLocation: installation, KeepShortcuts: "true", ShortcutName: "code-shell" };
    }
  for (const name of ["desktop", "startMenu"])
    Object.assign(value.paths[name], {
      kind: "file",
      target: `${installation}\\code-shell.exe`,
      arguments: "",
      appId: NSIS_IDENTITY.appId,
    });
  value.paths.cache.kind = "directory";
  return value;
};
const normal = () => ({
  result: { code: 0, signal: null },
  errors: [],
  signalRequests: [],
  child: { pid: 42, ppid: 24, birth: "2026-10-17T08:00:00.1234567Z" },
  settlement: {
    status: "cleaned",
    remainingCount: 0,
    queryFailed: false,
    evidenceTruncated: false,
    owned: [{ pid: 42, ppid: 24, birth: "2026-10-17T08:00:00.1234567Z" }],
    ownedCount: 1,
    remaining: [],
  },
});

function holderReceipt() {
  const operation = normal();
  const nonce = "0123456789abcdef0123456789abcdef";
  const script = new URL("./windows-nsis-uninstall-holder.ps1", import.meta.url);
  const sha256 = createHash("sha256").update(readFileSync(script)).digest("hex");
  const target = { pid: 43, ppid: 42, birth: "2026-10-26T02:03:04.7654321Z" };
  operation.label = "uninstall";
  operation.command = {
    executable: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    size: 1,
    sha256: sha,
  };
  operation.holder = {
    schemaVersion: 1,
    script: { path: fileURLToPath(script), sha256 },
    nonce,
    events: [
      { v: 1, event: "ready", nonce, pid: 42 },
      { v: 1, event: "target", nonce, ...target },
      { v: 1, event: "exit", nonce, code: 0 },
    ],
    target: { ...target, source: "holder-handle" },
    targetExit: { code: 0 },
    stopped: null,
  };
  return { operation, source: { fixtureSHA256: { "windows-nsis-uninstall-holder.ps1": sha256 } } };
}

test("holder acceptance replays the complete protocol and accepts an unobserved fast target", () => {
  const { operation, source } = holderReceipt();
  acceptance.assertHolderUninstallTarget(operation, source);
  operation.settlement.owned.push({
    pid: 43,
    ppid: 42,
    birth: operation.holder.target.birth.replace("7654321", "7654320"),
  });
  operation.settlement.ownedCount++;
  acceptance.assertHolderUninstallTarget(operation, source);
});

test("holder acceptance requires normal root and target zero exits with no stopped path", () => {
  for (const mutate of [
    (o) => (o.result.code = 3),
    (o) => (o.settlement.status = "unproven"),
    (o) => (o.holder.targetExit.code = 1),
    (o) => (o.holder.target.source = "snapshot"),
    (o) => (o.holder.target.ppid = 99),
    (o) => (o.holder.stopped = { reason: "stop", targetExited: true }),
    (o) => o.holder.events.pop(),
    (o) => o.holder.events.push(o.holder.events[0]),
    (o) => (o.label = "install"),
    (o) => (o.command.executable = "C:\\unreviewed\\pwsh.exe"),
  ]) {
    const { operation, source } = holderReceipt();
    mutate(operation);
    assert.throws(() => acceptance.assertHolderUninstallTarget(operation, source));
  }
});

test("holder acceptance binds script path/hash to actual fixed source and fixture manifest", () => {
  for (const mutate of [
    (o) => (o.holder.script.path = "C:\\foreign\\windows-nsis-uninstall-holder.ps1"),
    (o) => (o.holder.script.sha256 = "b".repeat(64)),
    (_o, source) => (source.fixtureSHA256["windows-nsis-uninstall-holder.ps1"] = "b".repeat(64)),
    (o, source) => {
      o.holder.script.sha256 = "b".repeat(64);
      source.fixtureSHA256["windows-nsis-uninstall-holder.ps1"] = "b".repeat(64);
    },
  ]) {
    const { operation, source } = holderReceipt();
    mutate(operation, source);
    assert.throws(() => acceptance.assertHolderUninstallTarget(operation, source));
  }
  const { operation } = holderReceipt();
  assert.throws(() => acceptance.assertHolderUninstallTarget(operation));
});

test("holder acceptance projects full handle time onto a WMI microsecond without altering the receipt", () => {
  for (const [retained, observed] of [
    ...Array.from({ length: 10 }, (_, digit) => [
      `2026-10-26T02:03:04.765432${digit}Z`,
      "2026-10-26T02:03:04.7654320Z",
    ]),
    ["2026-10-26T02:03:04.9999999Z", "2026-10-26T02:03:04.9999990Z"],
    ["2026-10-26T23:59:59.9999999Z", "2026-10-26T23:59:59.9999990Z"],
  ]) {
    const { operation, source } = holderReceipt();
    operation.holder.target.birth = retained;
    operation.holder.events[1].birth = retained;
    operation.settlement.owned.push({ pid: 43, ppid: 42, birth: observed });
    operation.settlement.ownedCount++;
    const before = clone(operation);
    acceptance.assertHolderUninstallTarget(operation, source);
    assert.deepEqual(operation, before);
  }
});

test("holder acceptance rejects different WMI microseconds and every nonzero seventh digit", () => {
  for (const mismatch of [
    { ppid: 99 },
    { ppid: "42" },
    { pid: "43" },
    { birth: "2026-10-26T02:03:04.7654310Z" },
    { birth: "2026-10-26T02:03:04.7654330Z" },
    { birth: "2026-10-26T02:03:04.7650000Z" },
    ...Array.from({ length: 9 }, (_, index) => ({
      birth: `2026-10-26T02:03:04.765432${index + 1}Z`,
    })),
  ]) {
    const { operation, source } = holderReceipt();
    operation.settlement.owned.push({
      pid: 43,
      ppid: 42,
      birth: "2026-10-26T02:03:04.7654320Z",
      ...mismatch,
    });
    operation.settlement.ownedCount++;
    assert.throws(() => acceptance.assertHolderUninstallTarget(operation, source));
  }
  for (const [retained, observed] of [
    ["2026-10-26T02:03:04.7654329Z", "2026-10-26T02:03:04.7654330Z"],
    ["2026-10-26T02:03:04.9999999Z", "2026-10-26T02:03:05.0000000Z"],
    ["2026-10-26T23:59:59.9999999Z", "2026-10-27T00:00:00.0000000Z"],
  ]) {
    const { operation, source } = holderReceipt();
    operation.holder.target.birth = retained;
    operation.holder.events[1].birth = retained;
    operation.settlement.owned.push({ pid: 43, ppid: 42, birth: observed });
    operation.settlement.ownedCount++;
    assert.throws(() => acceptance.assertHolderUninstallTarget(operation, source));
  }
});

test("holder acceptance validates both WMI and handle UTC calendars and seven-digit shapes", () => {
  for (const birth of [
    "2026-02-30T02:03:04.7654320Z",
    "2026-10-26T02:03:04.765432Z",
    "2026-10-26T02:03:04.76543200Z",
    "2026-10-26T02:03:04.7654320+00:00",
    null,
  ]) {
    for (const side of ["wmi", "handle"]) {
      const { operation, source } = holderReceipt();
      operation.settlement.owned.push({
        pid: 43,
        ppid: 42,
        birth: side === "wmi" ? birth : "2026-10-26T02:03:04.7654320Z",
      });
      operation.settlement.ownedCount++;
      if (side === "handle") {
        operation.holder.target.birth = birth;
        operation.holder.events[1].birth = birth;
      }
      assert.throws(() => acceptance.assertHolderUninstallTarget(operation, source));
    }
  }
});

test("PowerShell uninstall field selection uses the full literal key, without C/JS slash escaping", () => {
  const source = readFileSync(new URL("./windows-nsis-observe.ps1", import.meta.url), "utf8");
  assert.ok(
    source.includes('$key -eq "Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\$guid"'),
  );
  assert.ok(!source.includes("$key.Contains"));
  assert.ok(source.includes("OpenSubKey($key, $false)"));
  assert.ok(!/Set-Item|SetValue\(|CreateSubKey|Remove-Item|\.Save\(/.test(source));
});

test("only the actual reviewed hosted Windows CI environment qualifies", () => {
  assert.equal(assertHostedWindowsNsis(hosted()).runner, "github-hosted/windows-2022/x64");
  for (const mutate of [
    (v) => {
      v.platform = "darwin";
    },
    (v) => {
      v.arch = "arm64";
    },
    (v) => {
      v.environment.RUNNER_ENVIRONMENT = "self-hosted";
    },
    (v) => {
      delete v.environment.ImageOS;
    },
    (v) => {
      v.environment.ImageOS = "win25";
    },
    (v) => {
      v.environment.GITHUB_REPOSITORY = "foreign/repo";
    },
    (v) => {
      v.environment.ACT = "true";
    },
    (v) => {
      v.environment.GITHUB_SHA = "current";
    },
  ]) {
    const value = hosted();
    mutate(value);
    assert.throws(() => assertHostedWindowsNsis(value));
  }
});

test("the committed production NSIS settings remain intact and reject unreviewed authority", () => {
  assert.equal(assertProductionNsis(pkg), `code-shell-Setup-${pkg.version}.exe`);
  for (const [key, value] of [
    ["oneClick", true],
    ["perMachine", true],
    ["packElevateHelper", false],
    ["script", "custom.nsi"],
    ["include", "build/nsis-uninstaller-init.nsh"],
    ["include", ["nsis-uninstaller-init.nsh"]],
    ["createDesktopShortcut", false],
  ]) {
    const copy = clone(pkg);
    copy.build.nsis[key] = value;
    assert.throws(() => assertProductionNsis(copy));
  }
  const associations = clone(pkg);
  associations.build.fileAssociations = [{ ext: "owned" }];
  assert.throws(() => assertProductionNsis(associations));
});

test("direct Node vectors preserve silent current-user/raw final tails without a shell", () => {
  assert.deepEqual(nsisInstallArguments(installation, root), [
    "/S",
    "/currentuser",
    `/D=${installation}`,
  ]);
  assert.deepEqual(nsisUninstallArguments(installation, root), [
    "/S",
    "/currentuser",
    `_?=${installation}`,
  ]);
  const args = nsisBuildArguments({
    builderCli: "C:\\tool path\\cli.js",
    desktop: "D:\\repo",
    staging: `${root}\\staging`,
    config: `${root}\\local.json`,
    root,
  });
  assert.deepEqual(args, [
    "C:\\tool path\\cli.js",
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never",
    "--prepackaged",
    `${root}\\staging`,
    "--projectDir",
    "D:\\repo",
    "--config",
    `${root}\\local.json`,
  ]);
  for (const path of [
    "C:\\operator",
    root,
    `${root}\\..\\escape`,
    `${root}\\sp ace`,
    `${root}\\中文`,
    `${root}\\x&calc`,
    `${root}\\tail.`,
    `${root}\\NUL`,
    `${root}\\a\n/S`,
    `${root}/mixed`,
    `${root}\\x\\`,
  ])
    assert.throws(() => nsisInstallArguments(path, root), path);
});

test("preflight fails on any existing identity, same-name process, missing view or reparse parent", () => {
  assertNsisPreflight(before());
  for (const mutate of [
    (v) => {
      v.processes.push({ pid: 42, name: "code-shell.exe" });
    },
    (v) => {
      delete v.processes;
    },
    (v) => {
      v.registry.pop();
    },
    (v) => {
      v.registry[7].present = true;
    },
    (v) => {
      v.registry[0].values = {};
    },
    (v) => {
      v.paths.desktop.kind = "file";
    },
    (v) => {
      v.paths.cache.kind = "directory";
    },
    (v) => {
      v.paths.userDefault.kind = "directory";
    },
    (v) => {
      v.paths.machine32.parentsPlain = false;
    },
    (v) => {
      v.paths.startMenu.path = "C:\\foreign\\code-shell.lnk";
    },
  ]) {
    const value = before();
    mutate(value);
    assert.throws(() => assertNsisPreflight(value));
  }
});

test("installed registration requires shared HKCU views, exact shortcut targets and no HKLM/default install", () => {
  assertInstalledRegistration(installed(), installation, pkg.version, before());
  for (const mutate of [
    (v) => {
      v.registry[0].values.InstallLocation = "C:\\foreign";
    },
    (v) => {
      v.registry[2].present = false;
    },
    (v) => {
      v.registry[4].present = true;
    },
    (v) => {
      v.paths.startMenu.target = "C:\\foreign.exe";
    },
    (v) => {
      v.paths.desktop.arguments = "--force-run";
    },
    (v) => {
      v.paths.desktop.appId = "foreign";
    },
    (v) => {
      v.paths.userDefault.kind = "directory";
    },
  ]) {
    const value = installed();
    mutate(value);
    assert.throws(() => assertInstalledRegistration(value, installation, pkg.version, before()));
  }
});

test("NSIS payload may add only the pinned production elevate helper; baseline bytes cannot drift", () => {
  const base = [
    ["resources", "directory", 511],
    ["resources/app.asar", "file", 438, 3, sha],
  ];
  const elevate = ["resources/elevate.exe", "file", 438, 10, "b".repeat(64)];
  assertNsisPayload(base, [...base, elevate], elevate);
  assertNsisPayload([...base, elevate], [...base, elevate], elevate);
  assert.throws(() => assertNsisPayload(base, [...base, [...elevate.slice(0, 4), sha]], elevate));
  assert.throws(() =>
    assertNsisPayload(base, [...base, elevate, ["extra", "file", 438, 1, sha]], elevate),
  );
  assert.throws(() =>
    assertNsisPayload(
      base,
      [base[0], ["resources/app.asar", "file", 438, 4, sha], elevate],
      elevate,
    ),
  );
  assert.throws(() =>
    assertNsisPayload(base, [...base, ["escape", "link", "C:\\foreign"]], elevate),
  );
});

test("installed inventory must contain all payload bytes plus exactly its generated uninstaller", () => {
  const payload = [["code-shell.exe", "file", 438, 3, sha]];
  const uninstall = [NSIS_IDENTITY.uninstaller, "file", 438, 30, "b".repeat(64)];
  assert.deepEqual(assertInstalledPayload(payload, [...payload, uninstall]), uninstall);
  for (const value of [
    payload,
    [uninstall],
    [...payload, uninstall, ["unknown", "directory", 511]],
    [...payload, [NSIS_IDENTITY.uninstaller, "link", "foreign"]],
  ])
    assert.throws(() => assertInstalledPayload(payload, value));
});

test("cache removal requires absent-before, a plain parent and exactly the original Setup bytes", () => {
  const initial = before().paths.cache;
  const current = installed().paths.cache;
  const entry = { name: "installer.exe", kind: "file", sha256: sha };
  assert.equal(
    assertOwnedNsisCache(initial, current, [entry], sha),
    `${current.path}\\installer.exe`,
  );
  for (const [first, last, contents] of [
    [{ ...initial, kind: "directory" }, current, [entry]],
    [initial, { ...current, path: "C:\\foreign" }, [entry]],
    [initial, { ...current, kind: "reparse" }, [entry]],
    [initial, { ...current, parentsPlain: false }, [entry]],
    [initial, current, [entry, { ...entry, name: "foreign" }]],
    [initial, current, [{ ...entry, sha256: "c".repeat(64) }]],
    [initial, current, [{ ...entry, kind: "link" }]],
  ])
    assert.throws(() => assertOwnedNsisCache(first, last, contents, sha));
});

test("normal process success cannot be synthesized from cleanup or truncated/unproven custody", () => {
  assertNormalNsisProcess(normal());
  for (const mutate of [
    (v) => {
      v.result.code = 1;
    },
    (v) => {
      v.result.signal = "SIGTERM";
    },
    (v) => {
      v.signalRequests.push({ pid: 42, signal: "SIGTERM" });
    },
    (v) => {
      v.settlement.status = "unproven";
    },
    (v) => {
      v.settlement.remainingCount = 1;
    },
    (v) => {
      v.settlement.queryFailed = true;
    },
    (v) => {
      v.settlement.evidenceTruncated = true;
    },
    (v) => {
      v.errors.push("late failure");
    },
    (v) => {
      v.settlement.remaining.push(v.child);
    },
    (v) => {
      v.settlement.ownedCount = 0;
    },
    (v) => {
      v.settlement.owned[0].birth = "2026-10-17T08:00:00.123Z";
    },
    (v) => {
      v.child.birth = "2026-10-17T08:00:00.9999999Z";
    },
    (v) => {
      v.child.ppid = 99;
    },
  ]) {
    const value = normal();
    mutate(value);
    assert.throws(() => assertNormalNsisProcess(value));
  }
});

test("uninstall requires keys/shortcuts gone; retained cache is separately qualified", () => {
  const after = before();
  after.paths.cache.kind = "directory";
  assertNsisUninstalled(after, before());
  const stale = clone(after);
  stale.registry[0].present = true;
  assert.throws(() => assertNsisUninstalled(stale, before()));
  assert.throws(() => assertNsisUninstalled(installed(), before()));
  assert.throws(() => assertNoNamedApp({ processes: [{ pid: 42 }] }));
});

test("installed UI consumes real final Main/guard/transport evidence, never a wrapper or partial count", () => {
  const receipt = () => ({
    status: "passed",
    suppliedApp: installation,
    operations: NSIS_UI_ACTIONS.map((action) => ({ action })),
    errors: [],
    localModelRequests: 0,
    nativeCalls: [],
    rendererErrors: [],
    privateHomeRemoved: true,
    identity: {
      platform: "win32",
      arch: "x64",
      packaged: true,
      executable: `${installation}\\code-shell.exe`,
      resources: `${installation}\\resources`,
      appPath: `${installation}\\resources\\app.asar`,
      pid: 42,
      ppid: 24,
      noSandboxSwitch: false,
      startupPause: { firstUserInstruction: true },
    },
    processEvidence: {
      spawnedWorkers: [],
      mainGuards: [{ pid: 42, role: "Main" }],
      mainSpawnExits: [{ pid: 42, workerSpawnCount: 0 }],
    },
    artifacts: {
      unchangedAfterRuntime: true,
      mainExits: [{ pid: 42, code: 0, signal: null }],
      observedProcessSettlements: [normal().settlement],
      observedSignalRequests: { requests: [], truncated: false },
      transportFailures: [],
      windowsTransports: [
        {
          failures: [],
          cleanupRequests: [],
          nativeTaskkillExecuted: false,
        },
      ],
    },
  });
  assertNsisInstalledUi(receipt(), installation, { controllerPid: 24 });
  for (const mutate of [
    (v) => {
      v.operations.pop();
    },
    (v) => {
      v.identity.executable = "C:\\baseline\\code-shell.exe";
    },
    (v) => {
      v.artifacts.mainExits[0].code = 1;
    },
    (v) => {
      v.processEvidence.mainGuards[0].pid = 12;
    },
    (v) => {
      v.processEvidence.mainSpawnExits[0].workerSpawnCount = 1;
    },
    (v) => {
      v.artifacts.windowsTransports[0].failures.push("late taskkill");
    },
    (v) => {
      v.artifacts.windowsTransports = [];
    },
    (v) => {
      v.rendererErrors.push("late renderer error");
    },
    (v) => {
      v.privateHomeRemoved = false;
    },
    (v) => {
      v.operations[0].action = "Other action";
    },
    (v) => {
      v.identity.ppid = 99;
    },
    (v) => {
      delete v.artifacts.observedSignalRequests;
    },
    (v) => {
      v.artifacts.observedSignalRequests.truncated = true;
    },
    (v) => {
      v.artifacts.observedSignalRequests.requests.push({ sequence: 1, pid: 42, signal: "SIGTERM" });
    },
  ]) {
    const value = receipt();
    mutate(value);
    assert.throws(() => assertNsisInstalledUi(value, installation, { controllerPid: 24 }));
  }
});
