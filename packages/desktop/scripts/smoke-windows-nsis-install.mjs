/** Actual production NSIS, only on the reviewed disposable hosted Windows VM.
 * Never run locally/self-hosted. No publication, signer or installer-driven App cleanup. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants, renameSync, writeFileSync } from "node:fs";
import {
  cp,
  lstat,
  mkdir,
  open,
  readFile,
  readdir,
  realpath,
  rmdir,
  statfs,
  unlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve, win32 } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";
import { createNsisCheckpointDiagnostics } from "./windows-nsis-checkpoint-diagnostics.mjs";
import { collectNsisCrashEvidence } from "./windows-nsis-crash-evidence.mjs";
import { observeNsisUninstallLeftovers } from "./windows-nsis-leftover-metadata.mjs";
import { runNsisGatedUninstall } from "./windows-nsis-uninstall-holder.mjs";
import { createNsisReplacementRoleObserver } from "./windows-nsis-process-roles.mjs";
import { localPackageConfiguration } from "./smoke-local-package.mjs";
import { readPackagedUiBuildReceipt } from "./run-packaged-ui-acceptance.mjs";
import {
  capturePackagedAppIntegrity,
  inventoryAppTree,
  sha256,
} from "./packaged-app-integrity.mjs";
import {
  NSIS_BOUNDARY,
  NSIS_IDENTITY,
  assertHostedWindowsNsis,
  assertProductionNsis,
  assertNsisOwnedPath,
  windowsInside,
  nsisBuildArguments,
  nsisInstallArguments,
  assertNsisPreflight,
  assertNoNamedApp,
  assertInstalledRegistration,
  assertNsisUninstalled,
  assertSnapshotPaths,
  assertNsisPayload,
  assertInstalledPayload,
  assertOwnedNsisCache,
  assertNormalNsisProcess,
  assertHolderUninstallTarget,
  assertNsisInstalledUi,
} from "./windows-nsis-acceptance.mjs";

const MAX_LOG = 1024 * 1024;
const MAX_JOURNAL = 512 * 1024;
const MAX_EVENTS = 256;
const BUDGETS = Object.freeze({
  build: 600_000,
  installer: 180_000,
  uiController: 300_000,
  readonlyQuery: 30_000,
  closeAfterCustody: 5_000,
});
const here = dirname(fileURLToPath(import.meta.url));
const desktop = resolve(here, "..");
const repo = resolve(desktop, "../..");

const safeError = (error) => {
  try {
    return {
      name: typeof error?.name === "string" ? error.name.slice(0, 80) : "Error",
      message: String(error?.message ?? error ?? "Unknown caught value").slice(0, 2048),
    };
  } catch {
    return { name: "Error", message: "Caught value could not be described" };
  }
};

export function parseNsisArguments(args) {
  const options = new Map();
  for (let i = 0; i < args.length; i += 2) {
    assert.ok(
      ["--build-receipt", "--evidence-dir"].includes(args[i]) &&
        args[i + 1] &&
        !options.has(args[i]),
    );
    options.set(args[i], resolve(args[i + 1]));
  }
  assert.equal(options.size, 2, "Expected --build-receipt <file> --evidence-dir <new-directory>");
  return { buildReceipt: options.get("--build-receipt"), evidence: options.get("--evidence-dir") };
}

async function absent(path) {
  await lstat(path).then(
    () => {
      throw Error("Preexisting owned destination refused");
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
}
async function plainParents(path) {
  let current = dirname(path);
  while (true) {
    try {
      const info = await lstat(current);
      assert.ok(info.isDirectory() && !info.isSymbolicLink(), "Non-plain owned parent refused");
      assert.equal((await realpath(current)).toLowerCase(), resolve(current).toLowerCase());
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const next = dirname(current);
    if (next === current) return;
    current = next;
  }
}
async function plainFile(path) {
  await plainParents(path);
  const info = await lstat(path);
  assert.ok(info.isFile() && !info.isSymbolicLink(), "Pinned executable must be a plain file");
  return { size: info.size, sha256: sha256(await readFile(path)) };
}
async function writeExclusive(path, value) {
  await writeFile(path, typeof value === "string" ? value : JSON.stringify(value, null, 2) + "\n", {
    flag: "wx",
    mode: 0o600,
  });
}

/** Setup calls retain the real spawn/watch defaults. Pure contracts replace
 * effects; the separate desktop collector's real adapters only add its stdin
 * gate and preserve the original snapshot/fresh-birth signaling authority. */
export async function runNsisOwnedProcess({
  executable,
  args,
  environment,
  cwd,
  label,
  timeoutMs,
  report,
  checkpoint,
  spawnProcess = spawn,
  watch = watchElectronTestProcess,
  takeSnapshot = snapshotElectronTestProcesses,
  replacementRoles,
}) {
  const operation = {
    label,
    status: "incomplete",
    result: null,
    settlement: null,
    errors: [],
    signalRequests: [],
    logs: {},
    child: null,
  };
  report.processes.push(operation);
  let child, monitor;
  const roleObserver =
    label === "replace" && replacementRoles
      ? createNsisReplacementRoleObserver({ ...replacementRoles, environment })
      : null;
  if (roleObserver) operation.roleObservation = roleObserver.receipt;
  const tails = { stdout: Buffer.alloc(0), stderr: Buffer.alloc(0) };
  let closeTimer;
  const recordError = (message) => {
    if (operation.errors.length < 32) operation.errors.push(message);
  };
  const observeLog = (name, bytes) => {
    try {
      const log = operation.logs[name];
      log.observedBytes += bytes.length;
      tails[name] = Buffer.concat([tails[name], bytes]).subarray(-MAX_LOG);
      log.retainedBytes = tails[name].length;
      log.truncated = log.observedBytes > MAX_LOG;
      writeFileSync(join(cwd, `${label}.${name}.log`), tails[name], { mode: 0o600 });
    } catch {
      recordError("Bounded process log recording failed");
    }
  };
  try {
    operation.command = { executable, ...(await plainFile(executable)) };
    for (const name of ["stdout", "stderr"]) {
      operation.logs[name] = { observedBytes: 0, retainedBytes: 0, truncated: false };
      writeFileSync(join(cwd, `${label}.${name}.log`), "", { flag: "wx", mode: 0o600 });
    }
    child = spawnProcess(executable, args, {
      cwd,
      env: environment,
      shell: false,
      windowsVerbatimArguments: false,
      windowsHide: true,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const completion = new Promise((done) => {
      child.once("error", (error) =>
        done({ code: null, signal: null, error: safeError(error).message }),
      );
      child.once("exit", (code, signal) => {
        operation.exitObserved = { code, signal };
        checkpoint("process-exit", { label });
      });
      child.once("close", (code, signal) => done({ code, signal }));
    });
    child.stdout?.on("data", (bytes) => observeLog("stdout", bytes));
    child.stderr?.on("data", (bytes) => observeLog("stderr", bytes));
    operation.child = {
      pid: child.pid ?? null,
      ppid: process.pid,
      boundary: "ChildProcess PID; birth authority is exclusively the watchdog's fresh snapshot",
    };
    checkpoint("process-spawn", { label });
    assert.ok(child.pid, "No spawned PID; custody is unproven");
    const candidate = watch(child, {
      timeoutMs,
      snapshotProcesses: () => {
        const rows = roleObserver ? roleObserver.snapshot() : takeSnapshot();
        const pinned = rows.find(
          (row) => row.pid === child.pid && row.ppid === process.pid && row.birth,
        );
        operation.child.birth ??= pinned?.birth;
        return rows;
      },
      onInitialIdentityFailure: (observation) => {
        operation.initialIdentityObservation = observation;
      },
      reportFailure: (message) => {
        recordError(message);
        checkpoint("custody-error", { label });
        roleObserver?.markFailure(); // Original error is recorded before advisory metadata.
      },
      signalProcess: (pid, signal) => {
        // Called only after the unchanged watchdog has freshly authorized this birth.
        if (operation.signalRequests.length < 512) operation.signalRequests.push({ pid, signal });
        else recordError("Signal-request evidence truncated");
        checkpoint("cleanup-signal-request", { label });
        process.kill(pid, signal);
      },
      ...(roleObserver
        ? {
            onOwnedSnapshot: roleObserver.onOwnedSnapshot,
          }
        : {}),
    });
    assert.ok(
      typeof candidate === "function" &&
        candidate.completed?.then &&
        typeof candidate.terminate === "function",
      "Required process-custody API absent",
    );
    monitor = candidate;
    operation.result = await Promise.race([
      completion,
      monitor.completed.then(
        () =>
          new Promise((_, reject) => {
            closeTimer = setTimeout(
              () => reject(Error("Observed custody settled but child close is unproven")),
              BUDGETS.closeAfterCustody,
            );
          }),
      ),
    ]);
    operation.settlement = await monitor.completed;
    assertNormalNsisProcess(operation);
    assert.deepEqual(await plainFile(executable), {
      size: operation.command.size,
      sha256: operation.command.sha256,
    });
    operation.status = "passed";
  } catch (error) {
    operation.status = "failed";
    operation.failure = safeError(error);
    checkpoint("process-first-error", { label }, () => ({
      error: operation.failure,
      status: operation.status,
      child: operation.child,
      cachedExit: { code: child?.exitCode ?? null, signal: child?.signalCode ?? null },
      result: operation.result,
      logs: operation.logs,
      stderr: tails.stderr,
    })); // Observed data only; provider evaluation is inside the mirror's nonthrowing boundary.
    if (monitor) {
      checkpoint("process-cleanup-start", { label });
      try {
        operation.settlement = await monitor.terminate();
      } catch {
        recordError("Owned process cleanup failed");
      }
      checkpoint("process-cleanup-settled", { label });
    } else if (child) {
      report.unprovenProcess = true;
      child.unref(); // No custody: no close, signal or SDK force fallback.
      child.stdout?.destroy();
      child.stderr?.destroy();
    }
    throw error;
  } finally {
    clearTimeout(closeTimer);
    if (child && operation.settlement?.status !== "cleaned") report.unprovenProcess = true;
    monitor?.();
    operation.cachedExit = {
      code: child?.exitCode ?? null,
      signal: child?.signalCode ?? null,
      boundary: "Cached ChildProcess observation, not OS liveness",
    };
    checkpoint("process-final", { label });
  }
  return operation;
}

export async function runWindowsNsisAcceptance(args) {
  const ci = assertHostedWindowsNsis(); // Before any output or OS product observation.
  const options = parseNsisArguments(args);
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repo,
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
  assert.equal(ci.source, sourceHead, "CI source must be the actual clean checkout");
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repo,
      encoding: "utf8",
      timeout: 5_000,
    }).trim(),
    "",
  );
  const original = await readPackagedUiBuildReceipt(options.buildReceipt, { sourceHead });
  const parent = await realpath(dirname(options.evidence));
  const root = join(parent, basename(options.evidence));
  assertNsisOwnedPath(join(root, "installation"), root);
  for (const excluded of [repo, process.env.HOME, userInfo().homedir, original.output].filter(
    Boolean,
  )) {
    assert.ok(
      root.toLowerCase() !== resolve(excluded).toLowerCase() &&
        !windowsInside(excluded, root) &&
        !windowsInside(root, excluded),
      "Output must be disjoint from checkout, outer/actual HOME and baseline output",
    );
  }
  await plainParents(root);
  await absent(root);
  await mkdir(root, { mode: 0o700 });
  const report = {
    fixture: "owned-windows-production-nsis-install",
    schemaVersion: 1,
    status: "incomplete",
    sourceHead,
    platform: process.platform,
    arch: process.arch,
    ci,
    root,
    budgetsMs: BUDGETS,
    boundary: NSIS_BOUNDARY,
    started: new Date().toISOString(),
    phase: "initial",
    processes: [],
    failures: [],
    recordingFailures: [],
    operations: [],
    retainedOwnedRoot: root,
    nativeSignature: "not_verified",
    publishing: false,
    developerIdentity: false,
    userdataAcrossReplacement: "Not tested; both installed UI invocations use fresh private HOME",
    replacementDesktopObservation: {
      status: "not-enabled",
      enabled: false,
      reason: "production-validation-without-collector",
    },
    readonlyMetadataBoundary:
      "Fixed bounded PowerShell product observations use execFileSync, not the App/installer custody API. A query timeout stops all later stages and is not an all-descendant cleanup proof.",
  };
  let seq = 0,
    journalBytes = 0;
  const started = performance.now();
  const recordingFailure = (message) => {
    if (!report.recordingFailures.includes(message) && report.recordingFailures.length < 8)
      report.recordingFailures.push(message);
  };
  const checkpointDiagnostics = createNsisCheckpointDiagnostics({ recordingFailure });
  report.checkpointMirror = checkpointDiagnostics.receipt;
  const save = () => {
    try {
      writeFileSync(join(root, "receipt.json.tmp"), JSON.stringify(report, null, 2) + "\n", {
        mode: 0o600,
      });
      renameSync(join(root, "receipt.json.tmp"), join(root, "receipt.json"));
      return true;
    } catch {
      recordingFailure("Receipt recording failed");
      return false;
    }
  };
  const checkpoint = (kind, details = {}, diagnostic) => {
    let event;
    try {
      event = {
        sequence: ++seq,
        elapsedMs: performance.now() - started,
        phase: report.phase,
        kind,
        ...details,
      };
      const line = JSON.stringify(event) + "\n";
      const bytes = Buffer.byteLength(line);
      if (seq > MAX_EVENTS || journalBytes + bytes > MAX_JOURNAL) throw Error("Journal cap");
      // No error stack/env/request contents; these fixed events are advisory only.
      writeFileSync(join(root, "journal.jsonl"), line, { flag: "a", mode: 0o600 });
      journalBytes += bytes;
    } catch {
      recordingFailure("Journal recording failed/truncated");
    }
    checkpointDiagnostics.checkpoint(event, diagnostic);
    save();
  };
  process.once("exit", (code) => {
    report.controllerExit = {
      code,
      boundary: "Controller exit and cached child state only; not Main normal exit or OS liveness",
    };
    if (!save()) process.exitCode = 1;
  });
  const at = async (phase, action) => {
    report.phase = phase;
    checkpoint("stage-start");
    assert.deepEqual(report.recordingFailures, []);
    const result = await action();
    report.operations.push({ phase, status: "passed" });
    checkpoint("stage-complete");
    assert.deepEqual(report.recordingFailures, []);
    return result;
  };
  checkpoint("initial-pending");
  const privateBuild = join(root, "private-build");
  const temporary = join(root, "tmp");
  let environment;
  const processStep = (label, executable, argv, env, timeoutMs, replacementRoles) =>
    runNsisOwnedProcess({
      label,
      executable,
      args: argv,
      environment: env,
      cwd: root,
      timeoutMs,
      report,
      checkpoint,
      ...(replacementRoles ? { replacementRoles } : {}),
    });
  let baselineInventory;
  let postUninstallAbsenceFailed = false;
  let postUninstallAbsenceError;
  try {
    await mkdir(temporary, { recursive: true, mode: 0o700 });
    environment = {
      ...createBunTestEnvironment(process.env, privateBuild),
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      ELECTRON_BUILDER_CACHE: join(privateBuild, "electron-builder-cache"),
      CODESHELL_NODE_CACHE: join(privateBuild, "node-cache"),
      TMP: temporary,
      TEMP: temporary,
      TMPDIR: temporary,
    };
    const space = await statfs(root);
    report.space = { available: space.bavail * space.bsize, required: 10 * 1024 ** 3 };
    assert.ok(report.space.available >= report.space.required);
    const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
    const artifactName = assertProductionNsis(pkg);
    for (const name of ["installer.nsh", "installer.nsi", "uninstallerIcon.ico"])
      await absent(join(desktop, "build", name));
    const nsisUninstallerInit = join(desktop, "build", pkg.build.nsis.include);
    const nsisUninstallerInitIdentity = await plainFile(nsisUninstallerInit);
    const nsisPerUserInstallModeName = "nsis-safe-per-user-install-mode.nsh";
    const nsisPerUserInstallMode = join(desktop, "build", nsisPerUserInstallModeName);
    const nsisPerUserInstallModeIdentity = await plainFile(nsisPerUserInstallMode);
    const observer = join(here, "windows-nsis-observe.ps1");
    const systemRoot = process.env.SystemRoot ?? process.env.SYSTEMROOT;
    assert.match(systemRoot ?? "", /^[a-z]:\\[^\r\n\0]+$/i);
    const powershell = join(systemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe");
    await plainFile(powershell);
    const observe = async (label) => {
      const output = execFileSync(
        powershell,
        ["-NoLogo", "-NoProfile", "-NonInteractive", "-File", observer],
        {
          cwd: root,
          env: environment,
          encoding: "utf8",
          timeout: BUDGETS.readonlyQuery,
          maxBuffer: 2 * MAX_LOG,
          windowsHide: true,
        },
      );
      const snapshot = JSON.parse(output.replace(/^\uFEFF/, ""));
      assertSnapshotPaths(snapshot);
      await writeExclusive(join(root, `${label}.json`), snapshot);
      return snapshot;
    };
    report.source = {
      nsisUninstallerInit: {
        include: pkg.build.nsis.include,
        ...nsisUninstallerInitIdentity,
      },
      nsisPerUserInstallMode: {
        include: nsisPerUserInstallModeName,
        ...nsisPerUserInstallModeIdentity,
      },
      directoryBuildReceiptSHA256: sha256(await readFile(options.buildReceipt)),
      directoryBuild: original,
      fixtureSHA256: Object.fromEntries(
        await Promise.all(
          [
            "smoke-windows-nsis-install.mjs",
            "windows-nsis-desktop-observation.mjs",
            "windows-nsis-desktop-observation.ps1",
            "windows-nsis-acceptance.mjs",
            "windows-nsis-observe.ps1",
            "e2e-ui-packaged.mjs",
            "packaged-pet-fixture.mjs",
            "packaged-pet-bootstrap.mjs",
            "electron-test-watchdog.mjs",
            "windows-nsis-crash-evidence.mjs",
            "windows-nsis-crash-evidence.ps1",
            "windows-nsis-leftover-metadata.mjs",
            "windows-nsis-process-roles.mjs",
            "windows-nsis-uninstall-holder.mjs",
            "windows-nsis-uninstall-holder.ps1",
          ].map(async (file) => [file, sha256(await readFile(join(here, file)))]),
        ),
      ),
    };
    const initial = await at("preflight", async () => {
      const value = await observe("preflight");
      assertNsisPreflight(value);
      return value;
    });
    const baseline = await at("baseline", async () => {
      const value = await capturePackagedAppIntegrity(original.appRoot);
      assert.equal(value.asarSHA256, original.appAsarSha256);
      assert.equal(value.executableSHA256, original.executable.sha256);
      assert.equal(value.managedNodeManifestSHA256, original.managedNodeManifestSha256);
      baselineInventory = await inventoryAppTree(original.appRoot);
      await writeExclusive(join(root, "baseline-inventory.json"), baselineInventory);
      report.baseline = value;
      return value;
    });
    const staging = join(root, "staging"),
      installation = join(root, NSIS_IDENTITY.product);
    const artifacts = join(root, "artifacts");
    await at("stage-copy", async () => {
      await absent(staging);
      await absent(installation);
      await mkdir(artifacts);
      await cp(original.appRoot, staging, {
        recursive: true,
        force: false,
        errorOnExist: true,
        preserveTimestamps: true,
      });
      assert.deepEqual(await inventoryAppTree(staging), baselineInventory);
    });
    const require = createRequire(join(desktop, "package.json"));
    report.phase = "toolchain";
    checkpoint("stage-start");
    const builderPackage = require.resolve("electron-builder/package.json");
    const builderCli = join(dirname(builderPackage), "cli.js");
    const builderRequire = createRequire(builderPackage);
    const libraryPackage = builderRequire.resolve("app-builder-lib/package.json");
    const library = dirname(libraryPackage);
    assert.equal(JSON.parse(await readFile(libraryPackage, "utf8")).version, "25.1.8");
    const runtime = createRequire(libraryPackage)("builder-util-runtime");
    assert.equal(
      runtime.UUID.v5(pkg.build.appId, runtime.UUID.parse("50e065bc-3134-11e6-9bab-38c9862bdaf3")),
      NSIS_IDENTITY.guid,
    );
    const vendor = [
      "out/targets/nsis/NsisTarget.js",
      "out/targets/nsis/nsisUtil.js",
      "templates/nsis/installer.nsi",
      "templates/nsis/installSection.nsh",
      "templates/nsis/include/allowOnlyOneInstallerInstance.nsh",
      "templates/nsis/include/installer.nsh",
      "templates/nsis/include/installUtil.nsh",
      "templates/nsis/uninstaller.nsh",
    ];
    const perUserModeVendor = [
      "templates/nsis/multiUser.nsh",
      "templates/nsis/multiUserUi.nsh",
      "templates/nsis/assistedInstaller.nsh",
    ];
    report.toolchain = {
      appBuilder: "25.1.8",
      sha256: Object.fromEntries(
        await Promise.all(
          vendor.map(async (file) => [file, sha256(await readFile(join(library, file)))]),
        ),
      ),
      perUserModeSourceSHA256: Object.fromEntries(
        await Promise.all(
          perUserModeVendor.map(async (file) => [
            file,
            sha256(await readFile(join(library, file))),
          ]),
        ),
      ),
    };
    report.toolchain.builderCli = { path: builderCli, ...(await plainFile(builderCli)) };
    const electronDist = await realpath(
      join(dirname(require.resolve("electron/package.json")), "dist"),
    );
    const config = localPackageConfiguration(pkg.build, { output: artifacts, electronDist });
    const configFile = join(root, "electron-builder.nsis-local.json");
    await writeExclusive(configFile, config);
    report.configurationSHA256 = sha256(await readFile(configFile));
    report.operations.push({ phase: "toolchain", status: "passed" });
    checkpoint("stage-complete");
    await at("nsis-build", () =>
      processStep(
        "nsis-build",
        process.execPath,
        nsisBuildArguments({ builderCli, desktop, staging, config: configFile, root }),
        environment,
        BUDGETS.build,
      ),
    );
    assert.deepEqual(await plainFile(nsisUninstallerInit), nsisUninstallerInitIdentity);
    assert.deepEqual(await plainFile(nsisPerUserInstallMode), nsisPerUserInstallModeIdentity);
    for (const file of perUserModeVendor)
      assert.equal(
        sha256(await readFile(join(library, file))),
        report.toolchain.perUserModeSourceSHA256[file],
      );
    assert.equal((await plainFile(builderCli)).sha256, report.toolchain.builderCli.sha256);
    report.phase = "payload-identity";
    checkpoint("stage-start");
    const payload = await inventoryAppTree(staging);
    const cacheInventory = await inventoryAppTree(environment.ELECTRON_BUILDER_CACHE);
    const helpers = cacheInventory.filter(
      (row) => win32.basename(row[0]).toLowerCase() === "elevate.exe",
    );
    assert.equal(helpers.length, 1, "Audited NSIS cache must supply one elevate.exe");
    const elevate = ["resources/elevate.exe", ...helpers[0].slice(1)];
    assertNsisPayload(baselineInventory, payload, elevate);
    await writeExclusive(join(root, "payload-inventory.json"), payload);
    report.payload = await capturePackagedAppIntegrity(staging);
    for (const key of ["asarSHA256", "executableSHA256", "managedNodeManifestSHA256"])
      assert.equal(report.payload[key], baseline[key]);
    assert.deepEqual(await inventoryAppTree(original.appRoot), baselineInventory);
    const setup = join(artifacts, artifactName);
    report.installer = { path: setup, ...(await plainFile(setup)) };
    report.operations.push({ phase: "payload-identity", status: "passed" });
    checkpoint("stage-complete");
    const assertInstallationSiblings = async (present) => {
      assert.deepEqual(
        (await readdir(root)).filter((name) =>
          name.toLowerCase().startsWith(NSIS_IDENTITY.product),
        ),
        present ? [NSIS_IDENTITY.product] : [],
        "Retained/unknown installation sibling refused",
      );
    };
    const verifyInstalled = async (label) => {
      await assertInstallationSiblings(true);
      assertInstalledRegistration(
        await observe(`${label}-registration`),
        installation,
        pkg.version,
        initial,
      );
      const records = await inventoryAppTree(installation);
      const uninstaller = assertInstalledPayload(payload, records);
      await writeExclusive(join(root, `${label}-inventory.json`), records);
      const integrity = await capturePackagedAppIntegrity(installation);
      for (const key of ["asarSHA256", "executableSHA256", "managedNodeManifestSHA256"])
        assert.equal(integrity[key], report.payload[key]);
      return { integrity, uninstaller };
    };
    const install = async (label, first) => {
      const snapshot = await observe(`${label}-before`);
      if (first) {
        assertNsisPreflight(snapshot);
        await absent(installation);
      } else assertInstalledRegistration(snapshot, installation, pkg.version, initial);
      assertNoNamedApp(snapshot);
      assert.equal((await plainFile(setup)).sha256, report.installer.sha256);
      await processStep(
        label,
        setup,
        nsisInstallArguments(installation, root),
        environment,
        BUDGETS.installer,
        label === "replace"
          ? {
              root,
              setup,
              uninstaller: join(installation, NSIS_IDENTITY.uninstaller),
              temporary,
            }
          : undefined,
      );
    };
    const runUi = async (label, expected) => {
      const env = createBunTestEnvironment(process.env, join(root, `${label}-private`));
      const controller = await processStep(
        label,
        process.execPath,
        [
          join(here, "e2e-ui-packaged.mjs"),
          "--packaged-app",
          installation,
          "--evidence-dir",
          join(root, label),
        ],
        env,
        BUDGETS.uiController,
      );
      const ui = JSON.parse(await readFile(join(root, label, "receipt.json"), "utf8"));
      assertNsisInstalledUi(ui, installation, { controllerPid: controller.child.pid });
      assert.equal(ui.identity.version, pkg.version);
      for (const key of [
        "asarSHA256",
        "executableSHA256",
        "managedNodeManifestSHA256",
        "appTreeSHA256",
      ])
        assert.equal(ui.artifacts[key], expected.integrity[key]);
      assert.equal(ui.artifacts.beforeAppTreeSHA256, expected.integrity.appTreeSHA256);
      return {
        receiptSHA256: sha256(await readFile(join(root, label, "receipt.json"))),
        identity: ui.identity,
        main: ui.artifacts.mainExits[0],
        operations: ui.operations.length,
        privateHomeRemoved: ui.privateHomeRemoved,
      };
    };
    await at("install", () => install("install", true));
    report.firstInstalled = await at("installed-identity", () => verifyInstalled("first"));
    report.firstUi = await at("installed-ui", () => runUi("ui-first", report.firstInstalled));
    const marker = join(installation, "owned-replacement-marker.txt");
    await at("replacement-marker", async () => {
      assertInstalledRegistration(
        await observe("marker-before"),
        installation,
        pkg.version,
        initial,
      );
      assertInstalledPayload(payload, await inventoryAppTree(installation));
      await writeExclusive(marker, "Owned same-build replacement must remove this file.\n");
    });
    await at("replace", () => install("replace", false));
    await absent(marker);
    report.replacementInstalled = await at("replacement-identity", () =>
      verifyInstalled("replacement"),
    );
    report.replacementUi = await at("replacement-ui", () =>
      runUi("ui-replaced", report.replacementInstalled),
    );
    await at("uninstall", async () => {
      assertInstalledRegistration(
        await observe("uninstall-before"),
        installation,
        pkg.version,
        initial,
      );
      assertInstalledPayload(payload, await inventoryAppTree(installation));
      const uninstaller = join(installation, NSIS_IDENTITY.uninstaller);
      const pin = await plainFile(uninstaller);
      assert.equal(pin.sha256, report.replacementInstalled.uninstaller[4]);
      const copied = join(root, "owned-uninstaller.exe");
      await cp(uninstaller, copied, { errorOnExist: true, force: false });
      assert.deepEqual(await plainFile(copied), pin);
      const uninstall = await runNsisGatedUninstall({
        target: copied,
        installDir: installation,
        root,
        environment,
        timeoutMs: BUDGETS.installer,
        report,
        checkpoint,
        runProcess: runNsisOwnedProcess,
      });
      assertHolderUninstallTarget(uninstall, report.source);
      assert.deepEqual(await plainFile(copied), pin);
      try {
        await absent(installation);
      } catch (error) {
        postUninstallAbsenceFailed = true;
        postUninstallAbsenceError = error;
        throw error;
      }
      await assertInstallationSiblings(false);
      assertNsisUninstalled(await observe("uninstalled"), initial);
    });
    await at("cache-cleanup", async () => {
      const current = await observe("cache-before-cleanup");
      assertNsisUninstalled(current, initial);
      const cache = current.paths.cache;
      await plainParents(join(cache.path, "installer.exe"));
      const names = await readdir(cache.path);
      const entries = await Promise.all(
        names.map(async (name) => ({
          name,
          kind: (await lstat(join(cache.path, name))).isSymbolicLink()
            ? "link"
            : (await lstat(join(cache.path, name))).isFile()
              ? "file"
              : "other",
          ...(name === "installer.exe" ? await plainFile(join(cache.path, name)) : {}),
        })),
      );
      const file = assertOwnedNsisCache(
        initial.paths.cache,
        cache,
        entries,
        report.installer.sha256,
      );
      const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
      try {
        const info = await handle.stat(),
          actual = await lstat(file);
        assert.ok(info.isFile() && actual.isFile() && !actual.isSymbolicLink());
        assert.equal(info.dev, actual.dev);
        assert.equal(info.ino, actual.ino);
        assert.equal(sha256(await handle.readFile()), report.installer.sha256);
      } finally {
        await handle.close();
      }
      assert.deepEqual(await readdir(cache.path), ["installer.exe"]);
      await plainParents(file);
      assert.equal((await plainFile(file)).sha256, report.installer.sha256);
      await unlink(file);
      await rmdir(cache.path); // Empty exact product cache only, never its parent.
      report.cacheCleanup = { file, directory: cache.path, parentRemoved: false };
      assertNsisPreflight(await observe("final-os-state"));
    });
    await at("final-integrity", async () => {
      assert.deepEqual(await inventoryAppTree(original.appRoot), baselineInventory);
      assert.deepEqual(await inventoryAppTree(staging), payload);
      assert.equal((await plainFile(setup)).sha256, report.installer.sha256);
      assert.deepEqual(report.recordingFailures, []);
      assert.ok(report.processes.every((operation) => operation.status === "passed"));
      assert.equal(report.unprovenProcess, undefined);
    });
    report.status = "passed";
  } catch (error) {
    report.status = "failed";
    report.firstError = { phase: report.phase, ...safeError(error) };
    report.failures.push(report.firstError);
    // Synchronous first error before other observations; no compensating
    // installer/registry/delete action is attempted after a failed stage.
    checkpoint("first-error", {}, { error: report.firstError });
    process.exitCode = 1;
    if (
      report.phase === "uninstall" &&
      postUninstallAbsenceFailed &&
      error === postUninstallAbsenceError
    ) {
      report.postUninstallObservation = await observeNsisUninstallLeftovers({
        root,
        installation: join(root, NSIS_IDENTITY.product),
      });
    }
    // The failed process helper has already mirrored its original error/exit and
    // awaited existing custody cleanup. This one passive query cannot advance a stage.
    if (report.phase === "install") {
      try {
        report.installCrashEvidence = collectNsisCrashEvidence({
          operation: report.processes.find((operation) => operation.label === "install"),
          installer: report.installer,
          root,
          ci,
          environment,
          observedAt: new Date().toISOString().replace("Z", "0000Z"),
        });
        await writeExclusive(
          join(root, "install-crash-evidence.json"),
          report.installCrashEvidence,
        );
      } catch {
        recordingFailure("Passive installer event evidence recording failed");
      }
    }
  } finally {
    report.finished = new Date().toISOString();
    checkpoint("controller-final");
    if (report.recordingFailures.length) {
      report.status = "failed";
      process.exitCode = 1;
      save();
    }
  }
  assert.equal(report.status, "passed", "Windows NSIS acceptance failed; owned state retained");
  console.log(
    JSON.stringify({
      status: report.status,
      evidence: root,
      sourceHead,
      installedUiOperations: report.firstUi.operations + report.replacementUi.operations,
    }),
  );
  return report;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  runWindowsNsisAcceptance(process.argv.slice(2)).catch((error) => {
    console.error(safeError(error).message);
    process.exitCode = 1;
  });
}
