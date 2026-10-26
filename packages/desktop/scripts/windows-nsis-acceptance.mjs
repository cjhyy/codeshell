/** Finite contracts for an unsigned production NSIS test on a disposable hosted VM.
 * Environment checks are a launch refusal policy, not OS sandbox attestation. */
import assert from "node:assert/strict";
import { win32 } from "node:path";
import {
  parseHolderProtocol,
  readNsisHolderScriptPin,
  wmiRowMatchesNsisHolderTarget,
} from "./windows-nsis-uninstall-holder.mjs";

export const NSIS_IDENTITY = Object.freeze({
  appId: "com.cjhyy.codeshell",
  product: "code-shell",
  executable: "code-shell.exe",
  guid: "e769f1fe-3645-5ce2-ae3e-b8919c42060e",
  cacheDirectory: "@cjhyycode-shell-desktop-updater",
  uninstaller: "Uninstall code-shell.exe",
});
export const NSIS_BOUNDARY =
  "Only a fresh exclusive GitHub-hosted windows-2022 VM. Production NSIS can taskkill by executable name and username; absence checks are not kernel confinement or fresh-birth authorization inside NSIS. The driver never uses the installer to close an App. Observed process custody does not prove every OS descendant was observed. Unsigned silent per-user installation and same-build manual replacement, not SmartScreen, Authenticode, GUI Finish auto-launch, cross-version migration or release Updater acceptance.";

export const NSIS_UI_ACTIONS = Object.freeze([
  "Start the supplied package with first-instruction Main guard and private HOME",
  "Open Settings and Appearance through the account menu",
  "Import an owned local theme through native picker, review and Install",
  ...[1280, 768, 390].flatMap((width) => [
    `Navigate General and Appearance in a real ${width}px content window`,
    `Choose light, decode cstheme assets and inspect ${width}px layout`,
    `Choose dark, decode cstheme assets and inspect ${width}px layout`,
  ]),
  "Reload the packaged renderer and retain selected mode and installed theme",
]);

export function assertHostedWindowsNsis({
  platform = process.platform,
  arch = process.arch,
  environment = process.env,
} = {}) {
  assert.equal(platform, "win32", "NSIS acceptance requires actual Windows");
  assert.equal(arch, "x64");
  assert.equal(environment.GITHUB_ACTIONS, "true");
  assert.equal(environment.RUNNER_OS, "Windows");
  assert.equal(environment.RUNNER_ENVIRONMENT, "github-hosted", "Self-hosted is forbidden");
  assert.equal(environment.ImageOS, "win22", "Only the reviewed windows-2022 image is allowed");
  assert.equal(environment.GITHUB_REPOSITORY, "cjhyy/codeshell");
  assert.match(environment.GITHUB_RUN_ID ?? "", /^[1-9]\d{0,19}$/);
  assert.match(environment.GITHUB_SHA ?? "", /^[a-f0-9]{40}$/);
  assert.equal(environment.ACT, undefined);
  return {
    run: environment.GITHUB_RUN_ID,
    source: environment.GITHUB_SHA,
    runner: "github-hosted/windows-2022/x64",
    boundary: "Caller environment checks; not a cryptographic VM attestation",
  };
}

export function assertProductionNsis(pkg) {
  assert.equal(pkg.build.appId, NSIS_IDENTITY.appId);
  assert.equal(pkg.build.productName, NSIS_IDENTITY.product);
  assert.equal(pkg.name, "@cjhyy/code-shell-desktop");
  assert.match(pkg.version, /^\d+\.\d+\.\d+$/);
  assert.deepEqual(pkg.build.win.target, ["nsis"]);
  assert.equal(pkg.build.directories.buildResources, "build");
  assert.deepEqual(pkg.build.nsis, {
    artifactName: "${productName}-Setup-${version}.${ext}",
    include: "nsis-uninstaller-init.nsh",
    oneClick: false,
    allowToChangeInstallationDirectory: true,
    perMachine: false,
    createDesktopShortcut: true,
    createStartMenuShortcut: true,
  });
  for (const field of ["fileAssociations", "protocols"])
    assert.equal(pkg.build[field], undefined, `Unreviewed ${field}`);
  return `${NSIS_IDENTITY.product}-Setup-${pkg.version}.exe`;
}

export function windowsInside(parent, child) {
  const part = win32.relative(parent, child);
  return Boolean(part && part !== ".." && !part.startsWith("..\\") && !win32.isAbsolute(part));
}

/** NSIS consumes /D and _?= as raw final command-line tails. The first contract
 * deliberately refuses whitespace/metacharacters rather than inventing quoting. */
export function assertNsisOwnedPath(path, root) {
  assert.ok(typeof path === "string" && /^[A-Za-z]:\\[A-Za-z0-9_.\\-]+$/.test(path));
  assert.equal(win32.normalize(path), path, "Noncanonical NSIS tail path");
  assert.ok(path.length < 180, "Unreviewed long NSIS tail path");
  for (const part of path.slice(3).split("\\"))
    assert.ok(
      part && !part.endsWith(".") && !/^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part),
      "Windows alias/reserved path refused",
    );
  assert.ok(windowsInside(root, path), "NSIS destination escaped owned root");
  return path;
}

export function nsisInstallArguments(installation, root) {
  return ["/S", "/currentuser", `/D=${assertNsisOwnedPath(installation, root)}`];
}
export function nsisUninstallArguments(installation, root) {
  return ["/S", "/currentuser", `_?=${assertNsisOwnedPath(installation, root)}`];
}
export function nsisBuildArguments({ builderCli, desktop, staging, config, root }) {
  assertNsisOwnedPath(staging, root);
  return [
    builderCli,
    "--win",
    "nsis",
    "--x64",
    "--publish",
    "never",
    "--prepackaged",
    staging,
    "--projectDir",
    desktop,
    "--config",
    config,
  ];
}

export function expectedRegistryRows() {
  return ["CurrentUser", "LocalMachine"].flatMap((hive) =>
    ["Registry32", "Registry64"].flatMap((view) =>
      [
        `Software\\${NSIS_IDENTITY.guid}`,
        `Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\${NSIS_IDENTITY.guid}`,
      ].map((key) => ({ hive, view, key })),
    ),
  );
}

export function assertNoNamedApp(snapshot) {
  assert.ok(Array.isArray(snapshot.processes), "Missing all-user process query");
  assert.deepEqual(snapshot.processes, [], "A preexisting same-name App forbids NSIS execution");
}

export function assertSnapshotPaths(snapshot) {
  const folders = snapshot.knownFolders;
  assert.deepEqual(Object.keys(folders).sort(), [
    "desktop",
    "local",
    "machine32",
    "machine64",
    "programs",
    "userPrograms",
  ]);
  for (const value of Object.values(folders)) assert.ok(win32.isAbsolute(value));
  const paths = {
    desktop: win32.join(folders.desktop, "code-shell.lnk"),
    startMenu: win32.join(folders.programs, "code-shell.lnk"),
    cache: win32.join(folders.local, NSIS_IDENTITY.cacheDirectory),
    userDefault: win32.join(folders.userPrograms, NSIS_IDENTITY.product),
    machine32: win32.join(folders.machine32, NSIS_IDENTITY.product),
    machine64: win32.join(folders.machine64, NSIS_IDENTITY.product),
  };
  assert.deepEqual(Object.keys(snapshot.paths).sort(), Object.keys(paths).sort());
  for (const [name, path] of Object.entries(paths)) {
    assert.equal(snapshot.paths[name].path, path, "KnownFolder path identity mismatch");
    assert.equal(snapshot.paths[name].parentsPlain, true, "Reparse/unknown parent refused");
  }
}

export function assertNsisPreflight(snapshot) {
  assertSnapshotPaths(snapshot);
  assertNoNamedApp(snapshot);
  const expected = expectedRegistryRows();
  assert.equal(snapshot.registry.length, expected.length, "Incomplete registry views");
  expected.forEach((row, index) => {
    assert.deepEqual(
      snapshot.registry[index],
      { ...row, present: false, values: null },
      "Existing/unknown product registry state",
    );
  });
  for (const [name, record] of Object.entries(snapshot.paths)) {
    assert.ok(win32.isAbsolute(record.path), `Missing actual KnownFolder ${name}`);
    assert.equal(record.kind, "absent", `Preexisting ${name} forbids installation`);
  }
}

export function assertInstalledRegistration(snapshot, installation, version, initial) {
  assertSnapshotPaths(snapshot);
  assertNoNamedApp(snapshot);
  assert.deepEqual(snapshot.knownFolders, initial.knownFolders, "Actual KnownFolders changed");
  const rows = expectedRegistryRows();
  assert.equal(snapshot.registry.length, rows.length);
  rows.forEach((row, index) => {
    const actual = snapshot.registry[index];
    assert.deepEqual(
      { hive: actual.hive, view: actual.view, key: actual.key },
      row,
      "Registry query identity changed",
    );
    // These HKCU Software keys are shared across WOW64 views on Windows 7+;
    // checking both still detects preexisting state without inventing a second hive.
    // https://learn.microsoft.com/windows/win32/winprog64/shared-registry-keys
    if (row.hive === "CurrentUser") {
      assert.equal(actual.present, true);
      if (row.key.endsWith(`Uninstall\\${NSIS_IDENTITY.guid}`)) {
        assert.deepEqual(actual.values, {
          DisplayName: `${NSIS_IDENTITY.product} ${version}`,
          DisplayVersion: version,
          UninstallString: `"${win32.join(installation, NSIS_IDENTITY.uninstaller)}" /currentuser`,
          QuietUninstallString: `"${win32.join(installation, NSIS_IDENTITY.uninstaller)}" /currentuser /S`,
          DisplayIcon: `${win32.join(installation, NSIS_IDENTITY.executable)},0`,
        });
      } else {
        assert.deepEqual(actual.values, {
          InstallLocation: installation,
          KeepShortcuts: "true",
          ShortcutName: NSIS_IDENTITY.product,
        });
      }
    } else assert.deepEqual(actual, { ...row, present: false, values: null });
  });
  for (const key of ["desktop", "startMenu"]) {
    const item = snapshot.paths[key];
    assert.equal(item.path, initial.paths[key].path);
    assert.equal(item.kind, "file");
    assert.equal(item.target, win32.join(installation, NSIS_IDENTITY.executable));
    assert.equal(item.arguments, "");
    assert.equal(item.appId, NSIS_IDENTITY.appId);
  }
  for (const key of ["userDefault", "machine32", "machine64"])
    assert.deepEqual(snapshot.paths[key], initial.paths[key], "Foreign/default directory changed");
  assert.equal(snapshot.paths.cache.path, initial.paths.cache.path);
  assert.equal(snapshot.paths.cache.kind, "directory");
}

export function assertNsisUninstalled(snapshot, initial) {
  assertSnapshotPaths(snapshot);
  assertNoNamedApp(snapshot);
  assert.deepEqual(snapshot.knownFolders, initial.knownFolders);
  assert.deepEqual(snapshot.registry, initial.registry);
  for (const name of ["desktop", "startMenu", "userDefault", "machine32", "machine64"])
    assert.deepEqual(snapshot.paths[name], initial.paths[name], "Uninstall left product state");
}

function recordsByPath(records) {
  assert.ok(Array.isArray(records));
  const result = new Map();
  for (const record of records) {
    const name = record[0].replaceAll("\\", "/");
    assert.ok(name && !name.startsWith("/") && !name.split("/").includes(".."));
    assert.ok(!result.has(name), "Duplicate payload entry");
    assert.ok(["file", "directory"].includes(record[1]), "Links/special payload entries refused");
    result.set(name, [name, ...record.slice(1)]);
  }
  return result;
}

export function assertNsisPayload(baseline, payload, elevateRecord) {
  const before = recordsByPath(baseline),
    after = recordsByPath(payload);
  const elevate = recordsByPath([elevateRecord]).get("resources/elevate.exe");
  assert.ok(elevate?.[1] === "file", "Audited elevate.exe source is required");
  for (const [name, value] of before)
    if (name !== "resources/elevate.exe") assert.deepEqual(after.get(name), value);
  assert.deepEqual(after.get("resources/elevate.exe"), elevate);
  assert.equal(after.size, before.size + (before.has("resources/elevate.exe") ? 0 : 1));
}

export function assertInstalledPayload(payload, installed) {
  const before = recordsByPath(payload),
    after = recordsByPath(installed);
  for (const [name, value] of before) assert.deepEqual(after.get(name), value);
  const uninstaller = after.get(NSIS_IDENTITY.uninstaller);
  assert.equal(uninstaller?.[1], "file");
  assert.ok(uninstaller[3] > 0 && /^[a-f0-9]{64}$/.test(uninstaller[4]));
  assert.equal(after.size, before.size + 1, "Unknown installed extras");
  return uninstaller;
}

/** Cache cleanup authority comes only from zero-before, exactly-one-created-file
 * and exact Setup bytes. This never authorizes deleting the LocalAppData parent. */
export function assertOwnedNsisCache(initial, current, entries, setupSHA256) {
  assert.equal(initial.kind, "absent");
  assert.equal(initial.parentsPlain, true);
  assert.equal(current.path, initial.path);
  assert.equal(current.kind, "directory");
  assert.equal(current.parentsPlain, true);
  assert.match(setupSHA256, /^[a-f0-9]{64}$/);
  assert.equal(entries.length, 1, "Unknown cache contents; retain, do not clean");
  const [entry] = entries;
  assert.equal(entry.name, "installer.exe");
  assert.equal(entry.kind, "file");
  assert.equal(entry.sha256, setupSHA256);
  return win32.join(current.path, "installer.exe");
}

export function assertNormalNsisProcess(operation) {
  assert.equal(operation.result.error, undefined);
  assert.equal(operation.result.code, 0);
  assert.equal(operation.result.signal, null);
  assert.deepEqual(operation.errors, []);
  assert.deepEqual(operation.signalRequests, [], "Cleanup signals cannot count as normal success");
  assert.equal(operation.settlement?.status, "cleaned");
  assert.equal(operation.settlement.remainingCount, 0);
  assert.equal(operation.settlement.queryFailed, false);
  assert.equal(operation.settlement.evidenceTruncated, false);
  const owned = operation.settlement.owned;
  assert.ok(Array.isArray(owned) && owned.length > 0 && owned.length <= 512);
  assert.equal(operation.settlement.ownedCount, owned.length);
  assert.deepEqual(operation.settlement.remaining, []);
  assert.equal(new Set(owned.map((row) => row.pid)).size, owned.length);
  for (const row of owned) {
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
    assert.ok(Number.isSafeInteger(row.ppid) && row.ppid >= 0);
    assert.match(row.birth, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/);
    const milliseconds = `${row.birth.slice(0, 23)}Z`;
    assert.equal(new Date(milliseconds).toISOString(), milliseconds);
  }
  const root = operation.child;
  assert.ok(Number.isSafeInteger(root?.pid) && root.pid > 0);
  assert.ok(Number.isSafeInteger(root.ppid) && root.ppid > 0);
  assert.match(root.birth, /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{7}Z$/);
  assert.equal(
    owned.filter(
      (row) => row.pid === root.pid && row.ppid === root.ppid && row.birth === root.birth,
    ).length,
    1,
  );
}

/** The sixth controller root is now the gated holder. Its own zero exit and
 * watchdog settlement cannot substitute for the target handle's zero exit. */
export function assertHolderUninstallTarget(operation, source) {
  assertNormalNsisProcess(operation);
  assert.equal(operation.label, "uninstall");
  const holder = operation.holder;
  assert.deepEqual(Object.keys(holder).sort(), [
    "events",
    "nonce",
    "schemaVersion",
    "script",
    "stopped",
    "target",
    "targetExit",
  ]);
  assert.equal(holder.schemaVersion, 1);
  const script = readNsisHolderScriptPin();
  assert.deepEqual(holder.script, script, "Holder script path/hash differs from fixed source");
  assert.equal(
    source?.fixtureSHA256?.["windows-nsis-uninstall-holder.ps1"],
    script.sha256,
    "Holder script differs from fixture manifest",
  );
  const command = operation.command?.executable;
  assert.ok(typeof command === "string" && /^[a-z]:\\/i.test(command));
  assert.equal(
    command,
    win32.join(win32.parse(command).root, "Program Files", "PowerShell", "7", "pwsh.exe"),
  );
  assert.ok(Array.isArray(holder.events) && holder.events.length === 3);
  const parsed = parseHolderProtocol(
    holder.events.map((row) => JSON.stringify(row)).join("\n") + "\n",
    {
      nonce: holder.nonce,
      holderPid: operation.child.pid,
      complete: true,
    },
  );
  assert.deepEqual(
    parsed.events.map((row) => row.event),
    ["ready", "target", "exit"],
  );
  assert.deepEqual(holder.target, parsed.target);
  assert.deepEqual(holder.targetExit, { code: 0 });
  assert.deepEqual(parsed.targetExit, holder.targetExit);
  assert.equal(holder.stopped, null);
  assert.equal(parsed.stopped, null);
  assert.notEqual(holder.target.pid, operation.child.ppid);
  for (const row of operation.settlement.owned)
    if (row.pid === holder.target.pid)
      assert.ok(
        wmiRowMatchesNsisHolderTarget(row, holder.target),
        "Observed uninstall target identity differs from retained handle",
      );
}

export function assertNsisInstalledUi(receipt, installed, { controllerPid }) {
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.suppliedApp, installed);
  assert.deepEqual(
    receipt.operations.map((row) => row.action),
    NSIS_UI_ACTIONS,
  );
  assert.equal(receipt.localModelRequests, 0);
  assert.deepEqual(receipt.nativeCalls, []);
  assert.deepEqual(receipt.rendererErrors, []);
  assert.deepEqual(receipt.errors, []);
  assert.deepEqual(receipt.processEvidence.spawnedWorkers, []);
  assert.equal(receipt.privateHomeRemoved, true);
  assert.equal(receipt.artifacts.unchangedAfterRuntime, true);
  assert.equal(receipt.identity.platform, "win32");
  assert.equal(receipt.identity.arch, "x64");
  assert.equal(receipt.identity.packaged, true);
  assert.equal(receipt.identity.executable, win32.join(installed, NSIS_IDENTITY.executable));
  assert.equal(receipt.identity.resources, win32.join(installed, "resources"));
  assert.equal(receipt.identity.appPath, win32.join(installed, "resources", "app.asar"));
  assert.equal(receipt.identity.ppid, controllerPid);
  assert.equal(receipt.identity.noSandboxSwitch, false);
  assert.equal(receipt.identity.startupPause.firstUserInstruction, true);
  const mains = receipt.artifacts.mainExits;
  assert.equal(mains.length, 1);
  assert.ok(Number.isSafeInteger(mains[0].pid) && mains[0].pid > 0);
  assert.equal(mains[0].code, 0);
  assert.equal(mains[0].signal, null);
  assert.equal(receipt.identity.pid, mains[0].pid);
  const settlements = receipt.artifacts.observedProcessSettlements;
  assert.equal(settlements.length, 1);
  const signalLedger = receipt.artifacts.observedSignalRequests;
  assert.equal(signalLedger.truncated, false);
  assert.ok(Array.isArray(signalLedger.requests) && signalLedger.requests.length <= 512);
  signalLedger.requests.forEach((row, index) => {
    assert.equal(row.sequence, index + 1);
    assert.ok(Number.isSafeInteger(row.pid) && row.pid > 0);
    assert.ok(["SIGTERM", "SIGKILL"].includes(row.signal));
    assert.notEqual(row.pid, mains[0].pid, "Main received an observed cleanup signal request");
  });
  const pinned = settlements[0].owned.find(
    (row) => row.pid === mains[0].pid && row.ppid === controllerPid,
  );
  assertNormalNsisProcess({
    result: mains[0],
    settlement: settlements[0],
    errors: [],
    signalRequests: signalLedger.requests.filter((row) => row.pid === mains[0].pid),
    child: pinned,
  });
  assert.deepEqual(receipt.artifacts.transportFailures, []);
  const guards = receipt.processEvidence.mainGuards.filter((row) => row.role === "Main");
  assert.equal(guards.length, 1);
  assert.equal(guards[0].pid, mains[0].pid);
  const exits = receipt.processEvidence.mainSpawnExits;
  assert.equal(exits.length, 1);
  assert.equal(exits[0].pid, mains[0].pid);
  assert.equal(exits[0].workerSpawnCount, 0);
  assert.equal(receipt.artifacts.windowsTransports.length, 1);
  for (const transport of receipt.artifacts.windowsTransports) {
    assert.deepEqual(transport.failures, []);
    assert.deepEqual(transport.cleanupRequests, []);
    assert.equal(transport.nativeTaskkillExecuted, false);
  }
}
