import assert from "node:assert/strict";
import childrenModule from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath, pathToFileURL } from "node:url";
import { build } from "esbuild";
import { _electron } from "playwright";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";
import { preloadPausedPackagedMain } from "./packaged-main-preload.mjs";
import { capturePackagedAppIntegrity } from "./packaged-app-integrity.mjs";
import { canCleanupPackagedProcesses } from "./packaged-process-exits.mjs";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";
import { readPackagedLinuxEnvironment } from "./packaged-linux-environment.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function preparePackagedPetFixture({
  officialApp,
  isolated,
  origin,
  fixtureRoot,
  keychainReferenceFile,
  requireWorkerEvidence = true,
  appImageRuntime,
}) {
  assert.equal(typeof requireWorkerEvidence, "boolean");
  if (appImageRuntime) {
    assert.equal(process.platform, "linux");
    assert.equal(requireWorkerEvidence, false, "AppImage fixture covers manifest UI only");
    assert.equal(officialApp, appImageRuntime.appRoot);
  }
  officialApp = await realpath(resolve(officialApp));
  keychainReferenceFile = keychainReferenceFile && (await realpath(keychainReferenceFile));
  const layout = describePackagedAppLayout(officialApp);
  const executable = await realpath(layout.executable);
  const launcherExecutable = appImageRuntime?.launcherExecutable ?? executable;
  const { resources } = layout;
  const resourcesURLPrefix = pathToFileURL(resources + sep).href;
  const managedNode = await realpath(layout.managedNode);
  const before = await capturePackagedAppIntegrity(officialApp);
  // Persist before starting Electron, so assertion failures cannot lose the
  // baseline needed for a complete before/after failure receipt.
  await writeFile(join(fixtureRoot, "official-app-before.json"), JSON.stringify(before), {
    mode: 0o600,
    flag: "wx",
  });
  const bootstrap = join(isolated.home, "packaged-pet-bootstrap.cjs");
  await build({
    entryPoints: [fileURLToPath(new URL("./packaged-pet-bootstrap.mjs", import.meta.url))],
    outfile: bootstrap,
    bundle: true,
    platform: "node",
    format: "cjs",
    target: "node20",
    external: ["electron"],
  });
  const environment = {};
  for (const key of [
    "PATH",
    "PATHEXT",
    "SYSTEMROOT",
    "SYSTEMDRIVE",
    "WINDIR",
    "COMSPEC",
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "USER",
    "USERNAME",
    "LOGNAME",
    "SECURITYSESSIONID",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  const temporary = join(isolated.home, "tmp");
  await mkdir(temporary, { mode: 0o700 });
  if (process.platform === "win32") {
    environment.APPDATA = join(isolated.home, "AppData/Roaming");
    environment.LOCALAPPDATA = join(isolated.home, "AppData/Local");
    await Promise.all(
      [environment.APPDATA, environment.LOCALAPPDATA].map((path) =>
        mkdir(path, { recursive: true, mode: 0o700 }),
      ),
    );
  }
  if (process.platform === "linux") Object.assign(environment, readPackagedLinuxEnvironment());
  Object.assign(environment, {
    HOME: isolated.home,
    USERPROFILE: isolated.home,
    CODE_SHELL_HOME: isolated.codeShellHome,
    CODE_SHELL_TEST_HOME: isolated.codeShellHome,
    CODE_SHELL_NO_DEVTOOLS: "1",
    CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
    DISABLE_AUTOUPDATER: "1",
    TMPDIR: temporary,
    TEMP: temporary,
    TMP: temporary,
    XDG_CONFIG_HOME: join(isolated.home, ".config"),
    XDG_DATA_HOME: join(isolated.home, ".local/share"),
    NODE_USE_ENV_PROXY: "0",
    CODESHELL_COST_SMOKE_ORIGIN: origin,
    CODESHELL_COST_SMOKE_HOME_ID: hash(isolated.home),
    CODESHELL_COST_SMOKE_GUARD_LOG: join(isolated.home, "network-guard.jsonl"),
    CODESHELL_OFFICIAL_FIXTURE_ROOT: fixtureRoot,
    CODESHELL_OFFICIAL_NODE: managedNode,
    CODESHELL_OFFICIAL_WORKER_EXECUTABLE: executable,
    CODESHELL_OFFICIAL_BOOTSTRAP: bootstrap,
    CODESHELL_OFFICIAL_USER_DATA: isolated.userDataDir,
  });
  // Never inherit APPIMAGE/APPDIR. Only the actual ELF runtime may supply them.
  if (appImageRuntime) Object.assign(environment, appImageRuntime.environment);
  const children = [];
  const processMonitors = [];
  const monitorsByChild = new Map();
  const workers = new Set();
  const verifiedMains = new Set();
  const verifiedWorkerMains = new Set();
  const mainPidByChild = new Map();
  const mainBirthByChild = new Map();
  let launchFailed = false;
  const terminateChild = async (child) => {
    const monitor = monitorsByChild.get(child);
    assert.ok(monitor?.terminate, "Captured Main identity is unproven; private HOME retained");
    const settlement = await monitor.terminate();
    assert.equal(settlement.status, "cleaned", "Captured Main exit is unproven; HOME retained");
    return settlement;
  };
  return {
    env: environment,
    managedNode,
    managedNodeVersion: before.managedNode.version,
    async launch() {
      ensureElectronKeychainContext({
        home: isolated.home,
        environment: {
          ...environment,
          CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE: keychainReferenceFile,
        },
      });
      // No app directory/script argument: this executable must load its
      // own Resources/app.asar Main/preload/renderer. Its actual worker uses
      // this executable in Node mode; the synthetic plugin uses managed Node.
      const spawn = childrenModule.spawn;
      let captured;
      let preload;
      let preloadFailure;
      childrenModule.spawn = function (command, args, options) {
        const owned =
          command === launcherExecutable &&
          args?.includes("--inspect-brk=0") &&
          options?.env?.HOME === isolated.home;
        const child = spawn.call(this, command, args, options);
        if (owned) {
          assert.equal(captured, undefined, "Packaged launcher captured more than once");
          captured = child;
          children.push(child);
          let rootIdentity;
          const monitor = watchElectronTestProcess(child, {
            timeoutMs: 120_000,
            ...(appImageRuntime
              ? {
                  snapshotProcesses: () => {
                    const rows = snapshotElectronTestProcesses();
                    rootIdentity ??= rows.find(
                      (row) => row.pid === child.pid && row.ppid === process.pid,
                    );
                    return rows;
                  },
                }
              : {}),
          });
          processMonitors.push(monitor);
          monitorsByChild.set(child, monitor);
          for (const stream of ["stdout", "stderr"])
            child[stream].on("data", (chunk) =>
              appendFileSync(join(isolated.home, `official-main-${child.pid}.${stream}`), chunk, {
                mode: 0o600,
              }),
            );
          preload = preloadPausedPackagedMain(child, bootstrap, {
            // Initial ESM Break-on-start precedes the first dependency body.
            // Parsing the graph is expected; ordinary later pauses are denied.
            allowedPause: (url) => url.startsWith(layout.mainURLPrefix),
            isHostScript: (url) => url.startsWith(resourcesURLPrefix),
            allowParsedHostOnStart: true,
            terminateChild: () => terminateChild(child),
            launcherOwnsInspector: !appImageRuntime,
            verifyPausedIdentity: async (evaluate) => {
              const main = await evaluate(
                `({pid:process.pid,ppid:process.ppid,executable:process.execPath,appImage:process.env.APPIMAGE,appDir:process.env.APPDIR,home:process.env.HOME,argv:process.argv,noSandboxSwitch:require("electron").app.commandLine.hasSwitch("no-sandbox")})`,
              );
              assert.equal(
                main.noSandboxSwitch,
                false,
                "Actual packaged Main disabled the sandbox",
              );
              assert.ok(!main.argv.some((arg) => /^--no-sandbox(?:=|$)/.test(arg)));
              const identity = appImageRuntime
                ? appImageRuntime.verifyPaused(rootIdentity, main)
                : main;
              if (appImageRuntime) {
                const pinned = monitor.bindObservedDescendant(identity.pid);
                assert.deepEqual(
                  pinned,
                  { pid: identity.pid, ppid: identity.ppid, birth: identity.birth },
                  "Paused Main was not bound to active runtime birth custody",
                );
              }
              assert.equal(identity.pid, appImageRuntime ? main.pid : child.pid);
              return { ...identity, chromiumSandboxRequested: true };
            },
          }).then(async (receipt) => {
            await writeFile(
              join(isolated.home, `startup-pause-${child.pid}.json`),
              JSON.stringify(receipt),
              { mode: 0o600 },
            );
            return receipt;
          });
          preload.catch((error) => {
            preloadFailure = error;
          });
        }
        return child;
      };
      syncBuiltinESMExports();
      let app;
      try {
        app = await _electron.launch({
          executablePath: launcherExecutable,
          chromiumSandbox: true,
          args: ["--inspect-brk=0", `--user-data-dir=${isolated.userDataDir}`],
          cwd: isolated.home,
          env: environment,
          timeout: 30_000,
        });
        const startupPause = await preload;
        assert.equal(captured, app.process(), "packaged executable was not captured at spawn");
        const identity = await app.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          executable: process.execPath,
          resources: process.resourcesPath,
          version: app.getVersion(),
          electron: process.versions.electron,
          platform: process.platform,
          arch: process.arch,
          userData: app.getPath("userData"),
          pid: process.pid,
          ppid: process.ppid,
          appImage: process.env.APPIMAGE ?? null,
          appDir: process.env.APPDIR ?? null,
          noSandboxSwitch: app.commandLine.hasSwitch("no-sandbox"),
        }));
        assert.equal(identity.packaged, true);
        assert.equal(identity.appPath, join(resources, "app.asar"));
        assert.equal(identity.executable, executable);
        assert.equal(identity.resources, resources);
        assert.equal(identity.userData, isolated.userDataDir);
        assert.equal(identity.platform, process.platform);
        assert.equal(identity.arch, process.arch);
        assert.equal(identity.noSandboxSwitch, false);
        identity.chromiumSandboxRequested = true;
        const mainPid = startupPause.pid;
        assert.equal(identity.pid, mainPid, "Main identity changed after startup guard");
        if (appImageRuntime) {
          assert.equal(identity.appImage, launcherExecutable);
          assert.equal(identity.appDir, officialApp);
          assert.equal(identity.ppid, captured.pid);
          mainPidByChild.set(captured, mainPid);
          mainBirthByChild.set(captured, startupPause.mainIdentity.birth);
        } else assert.equal(mainPid, captured.pid);
        await writeFile(
          join(isolated.home, `packaged-identity-${captured.pid}.json`),
          JSON.stringify(identity),
          { mode: 0o600 },
        );
        const receipts = (await readFile(environment.CODESHELL_COST_SMOKE_GUARD_LOG, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.ok(
          receipts.some(
            (receipt) =>
              receipt.pid === mainPid &&
              receipt.role === "Main" &&
              receipt.negativeProbes === 7 &&
              receipt.homeId === hash(isolated.home) &&
              receipt.origin === origin,
          ),
          "packaged Main synchronous preimport guard receipt is missing",
        );
        verifiedMains.add(mainPid);
        app.__packagedIdentity = identity;
        app.__startupPause = startupPause;
      } catch (error) {
        launchFailed = true;
        if (preload)
          await preload.catch((failure) => {
            preloadFailure = failure;
          });
        // A failed Playwright handshake gives no safe app-control object. Only
        // the exact process captured from this launch may be terminated.
        const errors = [
          error,
          ...(preloadFailure && preloadFailure !== error ? [preloadFailure] : []),
        ];
        if (captured && captured.exitCode === null && captured.signalCode === null) {
          try {
            await terminateChild(captured);
          } catch (closeError) {
            errors.push(closeError);
          }
        }
        throw new AggregateError(errors, "packaged launch/identity failed; private HOME retained", {
          cause: error,
        });
      } finally {
        childrenModule.spawn = spawn;
        syncBuiltinESMExports();
      }
      return app;
    },
    terminateChild,
    async assertWorker(app) {
      assert.ok(!appImageRuntime, "AppImage acceptance never starts an Engine/Worker");
      const pid = app.process().pid;
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        const receipts = (await readFile(environment.CODESHELL_COST_SMOKE_GUARD_LOG, "utf8"))
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        const spawned = (
          await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8").catch(() => "")
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        assert.ok(
          receipts.every(
            (receipt) => receipt.origin === origin && receipt.homeId === hash(isolated.home),
          ),
        );
        if (
          receipts.some(
            (receipt) =>
              receipt.pid === pid && receipt.role === "Main" && receipt.negativeProbes === 7,
          ) &&
          spawned.length &&
          spawned.every(
            (worker) =>
              worker.command === executable &&
              receipts.some(
                (receipt) =>
                  receipt.pid === worker.pid &&
                  receipt.ppid === pid &&
                  receipt.role === "worker" &&
                  receipt.electron === app.__packagedIdentity.electron &&
                  receipt.negativeProbes === 7,
              ),
          )
        ) {
          for (const worker of spawned) {
            workers.add(worker.pid);
            await writeFile(join(isolated.home, `worker-${worker.pid}.permit`), "verified", {
              mode: 0o600,
            });
          }
          verifiedWorkerMains.add(pid);
          return {
            mainPid: pid,
            homeId: hash(isolated.home),
            receipts,
            spawned,
            workerCreated: true,
            packagedIdentity: app.__packagedIdentity,
            startupPause: app.__startupPause,
          };
        }
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw Error("actual packaged Main/Node-mode worker preimport receipts were not verified");
    },
    async canCleanup() {
      const settlements = await Promise.all(processMonitors.map((monitor) => monitor.completed));
      if (
        processMonitors.length !== children.length ||
        settlements.some((result) => result?.status !== "cleaned")
      )
        return false;
      if (
        appImageRuntime &&
        children.some(
          (child, index) =>
            !settlements[index].owned.some(
              (row) =>
                row.pid === mainPidByChild.get(child) &&
                row.birth === mainBirthByChild.get(child) &&
                row.ppid === child.pid,
            ),
        )
      )
        return false;
      return canCleanupPackagedProcesses({
        home: isolated.home,
        requireWorkerEvidence,
        launchFailed,
        children,
        verifiedMains,
        verifiedWorkerMains,
        workers,
        mainPidByChild,
      });
    },
    async verifyUnchanged() {
      const observedProcessSettlements = await Promise.all(
        processMonitors.map((monitor) => monitor.completed),
      );
      const after = await capturePackagedAppIntegrity(officialApp);
      assert.equal(after.appTreeSHA256, before.appTreeSHA256, "official signed app changed");
      const runtime = appImageRuntime && (await appImageRuntime.verifyUnchanged());
      return {
        ...after,
        beforeAppTreeSHA256: before.appTreeSHA256,
        unchangedAfterRuntime: true,
        ...(runtime ? { appImageRuntime: runtime } : {}),
        observedProcessSettlements,
        bootstrapSHA256: hash(await readFile(bootstrap)),
        mainExits: children.map((child) => ({
          pid: child.pid,
          mainPid: mainPidByChild.get(child) ?? child.pid,
          code: child.exitCode,
          signal: child.signalCode,
        })),
        workerExits: (
          await readFile(join(isolated.home, "worker-exits.jsonl"), "utf8").catch(() => "")
        )
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line)),
      };
    },
  };
}
