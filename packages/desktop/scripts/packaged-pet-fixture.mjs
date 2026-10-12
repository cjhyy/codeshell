import assert from "node:assert/strict";
import childrenModule from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync } from "node:fs";
import { readFile, realpath, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { syncBuiltinESMExports } from "node:module";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { _electron } from "playwright";
import { ensureElectronKeychainContext } from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { preloadPausedPackagedMain } from "./packaged-main-preload.mjs";
import { capturePackagedAppIntegrity } from "./packaged-app-integrity.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");

export async function preparePackagedPetFixture({
  officialApp,
  isolated,
  origin,
  fixtureRoot,
  keychainReferenceFile,
}) {
  officialApp = await realpath(resolve(officialApp));
  keychainReferenceFile = keychainReferenceFile && (await realpath(keychainReferenceFile));
  const executable = await realpath(join(officialApp, "Contents/MacOS/code-shell"));
  const resources = join(officialApp, "Contents/Resources");
  const managedNode = await realpath(join(resources, "runtimes/node/bin/node"));
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
    "LANG",
    "LC_ALL",
    "LC_CTYPE",
    "TZ",
    "USER",
    "LOGNAME",
    "SECURITYSESSIONID",
  ])
    if (process.env[key]) environment[key] = process.env[key];
  Object.assign(environment, {
    HOME: isolated.home,
    USERPROFILE: isolated.home,
    CODE_SHELL_HOME: isolated.codeShellHome,
    CODE_SHELL_TEST_HOME: isolated.codeShellHome,
    CODE_SHELL_NO_DEVTOOLS: "1",
    CODE_SHELL_DISABLE_UPDATE_CHECK: "1",
    DISABLE_AUTOUPDATER: "1",
    TMPDIR: isolated.home,
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
  const children = [];
  const workers = new Set();
  const verifiedMains = new Set();
  const verifiedWorkerMains = new Set();
  let launchFailed = false;
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
      // No app directory/script argument: this signed executable must load its
      // own Resources/app.asar Main/preload/renderer. Its actual worker uses
      // this executable in Node mode; the synthetic plugin uses managed Node.
      const spawn = childrenModule.spawn;
      let captured;
      let preload;
      let preloadFailure;
      childrenModule.spawn = function (command, args, options) {
        const owned =
          command === executable &&
          args?.includes("--inspect-brk=0") &&
          options?.env?.HOME === isolated.home;
        const child = spawn.call(this, command, args, options);
        if (owned) {
          captured = child;
          children.push(child);
          for (const stream of ["stdout", "stderr"])
            child[stream].on("data", (chunk) =>
              appendFileSync(join(isolated.home, `official-main-${child.pid}.${stream}`), chunk, {
                mode: 0o600,
              }),
            );
          preload = preloadPausedPackagedMain(child, bootstrap, {
            // Initial ESM Break-on-start precedes the first dependency body.
            // Parsing the graph is expected; ordinary later pauses are denied.
            allowedPause: (url) => url.startsWith(`file://${resources}/app.asar/out/main/`),
            isHostScript: (url) => url.includes(resources),
            allowParsedHostOnStart: true,
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
          executablePath: executable,
          args: ["--inspect-brk=0", `--user-data-dir=${isolated.userDataDir}`],
          cwd: isolated.home,
          env: environment,
          timeout: 30_000,
        });
        const startupPause = await preload;
        assert.equal(captured, app.process(), "packaged executable was not captured at spawn");
        watchElectronTestProcess(app.process(), { timeoutMs: 120_000 });
        const identity = await app.evaluate(({ app }) => ({
          packaged: app.isPackaged,
          appPath: app.getAppPath(),
          executable: process.execPath,
          resources: process.resourcesPath,
          version: app.getVersion(),
          electron: process.versions.electron,
          userData: app.getPath("userData"),
        }));
        assert.equal(identity.packaged, true);
        assert.equal(identity.appPath, join(resources, "app.asar"));
        assert.equal(identity.executable, executable);
        assert.equal(identity.resources, resources);
        assert.equal(identity.userData, isolated.userDataDir);
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
              receipt.pid === captured.pid &&
              receipt.role === "Main" &&
              receipt.negativeProbes === 7 &&
              receipt.homeId === hash(isolated.home) &&
              receipt.origin === origin,
          ),
          "packaged Main synchronous preimport guard receipt is missing",
        );
        verifiedMains.add(captured.pid);
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
            captured.kill("SIGTERM");
            await new Promise((resolve) => setTimeout(resolve, 1_000));
            if (captured.exitCode === null && captured.signalCode === null)
              captured.kill("SIGKILL");
            await new Promise((resolve) => setTimeout(resolve, 500));
            if (captured.exitCode === null && captured.signalCode === null)
              throw Error("captured packaged Main still alive; private HOME retained", {
                cause: error,
              });
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
    async assertWorker(app) {
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
      const spawned = (await readFile(join(isolated.home, "spawned-workers.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      const exits = (await readFile(join(isolated.home, "worker-exits.jsonl"), "utf8"))
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line));
      return (
        !launchFailed &&
        children.every(
          (child) =>
            verifiedMains.has(child.pid) &&
            verifiedWorkerMains.has(child.pid) &&
            (child.exitCode !== null || child.signalCode !== null),
        ) &&
        [...workers, ...spawned.map((worker) => worker.pid)].every((pid) =>
          exits.some((exit) => exit.pid === pid),
        )
      );
    },
    async verifyUnchanged() {
      const after = await capturePackagedAppIntegrity(officialApp);
      assert.equal(after.appTreeSHA256, before.appTreeSHA256, "official signed app changed");
      return {
        ...after,
        beforeAppTreeSHA256: before.appTreeSHA256,
        unchangedAfterRuntime: true,
        bootstrapSHA256: hash(await readFile(bootstrap)),
        mainExits: children.map((child) => ({
          pid: child.pid,
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
