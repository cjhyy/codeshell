/* Actual cold Main/reload/second-window startup with unchanged production Pet IPC.
 * Use run-isolated-node-smoke.mjs and --evidence-dir <new outside directory>. */
/* global window */
import assert from "node:assert/strict";
import children from "node:child_process";
import { createHash } from "node:crypto";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import {
  captureRendererErrors,
  findCodeShellWindow,
  launchCodeShellElectron,
  makeIsolatedElectronHome,
} from "./electron-harness.mjs";
import { prepareConfinedElectronFixture } from "./confined-electron-fixture.mjs";
import {
  ensureElectronKeychainContext,
  getElectronKeychainPreflightDiagnostic,
} from "./electron-keychain-preflight.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

const outside = (parent, child) => {
  const part = relative(parent, child);
  return part === ".." || part.startsWith(`..${sep}`) || isAbsolute(part);
};

/** Resolve before mkdir; aliases cannot put evidence in a disposable HOME. */
export async function resolveStartupEvidence(requested, repository, outerHome) {
  const path = resolve(requested);
  const evidence = join(await realpath(dirname(path)), basename(path));
  assert.ok(outside(await realpath(repository), evidence), "Evidence must be outside the checkout");
  assert.ok(
    outside(await realpath(outerHome), evidence),
    "Evidence must be outside the outer HOME",
  );
  return evidence;
}

/** Electron can log a caught IPC failure while the renderer still looks healthy. */
export function startupMainLogErrors(stderr) {
  return stderr
    .split(/\r?\n/)
    .some(
      (line) =>
        line.includes("projectRegistry:completeLegacyMigration") &&
        /\bError:?\s+legacy project migration is complete\b/.test(line),
    )
    ? ["legacy-project-migration-completion-error"]
    : [];
}

/** Cleanup proves disappearance; normal application exit is a separate requirement. */
export function assertStartupCycleSettled(cycle) {
  assert.ok(Number.isSafeInteger(cycle.pid) && cycle.pid > 0, "Main PID must be captured at spawn");
  assert.equal(cycle.guard?.mainPid, cycle.pid, "This exact Main must have its pre-Core guard");
  assert.equal(cycle.guard.workerCreated, false);
  assert.deepEqual(cycle.exit, { code: 0, signal: null }, "Main must exit normally");
  assert.equal(cycle.settlement?.status, "cleaned", "Main/observed descendant exit is unproven");
  assert.equal(cycle.settlement.queryFailed, false, "A failed custody query must fail this cycle");
  assert.equal(cycle.settlement.remainingCount, 0);
  assert.deepEqual(cycle.observerFailures, [], "Custody observer failed");
  assert.deepEqual(cycle.rendererErrors, [], "Renderer errors were observed through shutdown");
  assert.deepEqual(
    cycle.mainErrors,
    [],
    "Known Main startup errors were observed through shutdown",
  );
  assert.deepEqual(cycle.deniedAttempts, [], "Forbidden runtime attempt observed");
  assert.deepEqual(cycle.spawnedWorkers, [], "Startup must not create an Engine worker");
}

async function bounded(promise, timeout, label) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(Error(label)), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function runStartupOperationCycles(args) {
  assert.equal(process.env.NODE_ENV, "test", "Use the isolated native smoke runner");
  assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
  assert.ok(
    args.length === 2 && args[0] === "--evidence-dir" && args[1],
    "Expected --evidence-dir <new outside directory>",
  );
  const appDir = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const repository = await realpath(resolve(appDir, "../.."));
  const outerHome = await realpath(process.env.HOME);
  const evidence = await resolveStartupEvidence(args[1], repository, outerHome);
  await mkdir(evidence, { mode: 0o700 });
  const isolated = await makeIsolatedElectronHome("codeshell-startup-cycles-");
  assert.ok(
    outside(outerHome, isolated.home),
    "Private native HOME must survive the outer runner on failure",
  );
  const write = async (file, value) => {
    await mkdir(dirname(file), { recursive: true, mode: 0o700 });
    await writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
      mode: 0o600,
    });
  };
  const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
  const cycles = [],
    failures = [];
  const report = {
    fixture: "real-startup-operation-cycles",
    status: "failed",
    platform: process.platform,
    arch: process.arch,
    evidence,
    privateHome: isolated.home,
    privateHomeRemoved: false,
    cycles,
    failures,
    boundary:
      "Actual compiled Main/preload/renderer and unchanged Pet IPC. Same owned HOME across three cold processes and one production second window. Pre-Core HTTP/worker/native-crypto/OS-open denial; observed process identity custody, not an OS sandbox or proof of every descendant. Earlier Windows query failure cause remains unknown.",
  };
  let active, app, win, fixture;
  const loadLog = join(isolated.home, "startup-renderer-loads.jsonl");
  const rows = async (name) =>
    (
      await readFile(join(isolated.home, name), "utf8").catch((error) => {
        if (error.code === "ENOENT") return "";
        throw error;
      })
    )
      .trim()
      .split("\n")
      .filter(Boolean)
      .map(JSON.parse);
  async function closeCycle() {
    const resource = active,
      application = app;
    active = app = win = undefined;
    if (!resource) return;
    const errors = [];
    try {
      if (application && resource.monitor)
        await bounded(application.close(), 8000, "Owned startup graceful close timed out");
    } catch (error) {
      errors.push(error);
    }
    try {
      assert.ok(
        resource.monitor,
        "Main birth identity was never established; unsafe close skipped",
      );
      resource.proof.settlement = await resource.monitor.terminate();
      resource.proof.exit = await bounded(resource.closed, 3000, "Main close event unavailable");
    } catch (error) {
      errors.push(error);
    }
    resource.proof.rendererErrors = resource.errors.flat().map((error) => error.message);
    resource.proof.mainErrors = startupMainLogErrors(resource.logs.stderr);
    try {
      resource.proof.deniedAttempts = await rows("startup-denied-attempts.jsonl");
      resource.proof.spawnedWorkers = await rows("spawned-workers.jsonl");
      assertStartupCycleSettled(resource.proof);
      // The first launch pins metadata. Reuse that exact reference after each
      // shutdown; never refresh a changed identity or substitute native crypto.
      const context = ensureElectronKeychainContext({
        home: isolated.home,
        environment: {
          ...fixture.env,
          HOME: isolated.home,
          USERPROFILE: isolated.home,
          CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE:
            process.env.CODESHELL_MACOS_DEFAULT_KEYCHAIN_REFERENCE,
        },
      });
      if (process.platform === "darwin") assert.equal(context?.reused, true);
      resource.proof.keychainMetadataRechecked = process.platform === "darwin";
    } catch (error) {
      errors.push(error);
    }
    for (const stream of ["stdout", "stderr"])
      await write(
        join(evidence, `main-${resource.proof.cycle}.${stream}.log`),
        resource.logs[stream],
      );
    if (resource.proof.settlement?.status !== "cleaned") {
      resource.child?.unref();
      resource.child?.stdout?.unref?.();
      resource.child?.stderr?.unref?.();
    }
    if (!errors.length) resource.proof.status = "passed";
    await write(join(evidence, `cycle-${resource.proof.cycle}.json`), resource.proof);
    if (errors.length) throw new AggregateError(errors, "Startup cycle did not settle safely");
  }
  try {
    await write(join(isolated.codeShellHome, "settings.json"), { autoUpdates: false });
    const guard = join(isolated.home, "startup-guard.mjs");
    await write(
      guard,
      `
import children from "node:child_process";
import http from "node:http"; import https from "node:https";
import {appendFileSync} from "node:fs";
import {syncBuiltinESMExports} from "node:module";
await import(${JSON.stringify(new URL("./runtime-cost-gui-guard.mjs", import.meta.url).href)});
const attempts=${JSON.stringify(join(isolated.home, "startup-denied-attempts.jsonl"))};
const deny=kind=>{appendFileSync(attempts,JSON.stringify({pid:process.pid,kind})+"\\n",{mode:0o600});throw Error("Startup fixture denied "+kind);};
globalThis.fetch=()=>deny("network");
for(const transport of [http,https])for(const name of ["get","request"])transport[name]=()=>deny("network");
const spawn=children.spawn;
children.spawn=function(command,args,options){if(args?.some(arg=>String(arg).includes("agent-server-stdio")))return deny("worker");return spawn.call(this,command,args,options);};
syncBuiltinESMExports();
const {app,BrowserWindow,ipcMain,net,safeStorage,shell}=await import("electron");
net.request=net.fetch=()=>deny("network");
for(const name of ["isEncryptionAvailable","getSelectedStorageBackend","encryptString","decryptString"])if(typeof safeStorage[name]==="function")safeStorage[name]=()=>deny("crypto");
for(const name of ["openPath","openExternal","showItemInFolder"])shell[name]=()=>deny("OS-open");
app.on("web-contents-created",(_event,contents)=>contents.session.webRequest.onBeforeRequest({urls:["http://*/*","https://*/*"]},()=>deny("network")));
for(const method of ["loadFile","loadURL"]){const original=BrowserWindow.prototype[method];BrowserWindow.prototype[method]=function(...args){const missing=["pet:get-snapshot","pet:set-active-session","pet:get-attention"].filter(channel=>!ipcMain._invokeHandlers.has(channel));appendFileSync(${JSON.stringify(loadLog)},JSON.stringify({pid:process.pid,method,source:String(args[0]).slice(0,1024),missing,windowId:this.id})+"\\n",{mode:0o600});return original.apply(this,args);};}
`,
    );
    fixture = await prepareConfinedElectronFixture({
      appDir,
      isolated,
      origin: "http://127.0.0.1:9",
      guardModule: pathToFileURL(guard).href,
    });
    fixture.env.CODESHELL_COST_GUI_GUARD_LOG = join(isolated.home, "cost-gui-guard.jsonl");
    report.build = {
      sourceHead: children
        .execFileSync("git", ["rev-parse", "HEAD"], {
          cwd: repository,
          encoding: "utf8",
          timeout: 5000,
        })
        .trim(),
      sourceDirty:
        children
          .execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
            cwd: repository,
            encoding: "utf8",
            timeout: 5000,
          })
          .trim() !== "",
      fixtureSHA256: hash(await readFile(fileURLToPath(import.meta.url))),
      guardSHA256: hash(await readFile(guard)),
      mainSHA256: hash(await readFile(join(appDir, "out/main/index.mjs"))),
      preloadSHA256: hash(await readFile(join(appDir, "out/preload/index.cjs"))),
      rendererHTMLSHA256: hash(await readFile(join(appDir, "out/renderer/index.html"))),
    };
    const executable = await realpath(createRequire(import.meta.url)("electron"));
    for (let cycle = 1; cycle <= 3; cycle++) {
      const proof = { cycle, status: "failed", observerFailures: [], operations: [] };
      cycles.push(proof);
      const resource = (active = { proof, errors: [], logs: { stdout: "", stderr: "" } });
      const originalSpawn = children.spawn;
      children.spawn = function (command, args, options) {
        const child = originalSpawn.call(this, command, args, options);
        if (command === executable && options?.env?.HOME === isolated.home) {
          assert.equal(resource.child, undefined, "One Main per cold launch");
          resource.child = child;
          proof.pid = child.pid;
          resource.closed = new Promise((done) =>
            child.once("close", (code, signal) => done({ code, signal })),
          );
          child.once("error", () => proof.observerFailures.push("Owned Electron spawn error"));
          for (const stream of ["stdout", "stderr"])
            child[stream]?.on(
              "data",
              (chunk) =>
                (resource.logs[stream] = (resource.logs[stream] + chunk).slice(-1024 * 1024)),
            );
          resource.monitor = watchElectronTestProcess(child, {
            timeoutMs: 120000,
            reportFailure: (message) => proof.observerFailures.push(message),
          });
        }
        return child;
      };
      syncBuiltinESMExports();
      try {
        app = await launchCodeShellElectron(
          { appDir, ...isolated, env: fixture.env, mainEntry: fixture.mainEntry },
          { watch: () => {} },
        );
      } finally {
        children.spawn = originalSpawn;
        syncBuiltinESMExports();
      }
      assert.equal(
        resource.child,
        app.process(),
        "Early Main custody must bind the actual application",
      );
      win = await findCodeShellWindow(app);
      win.setDefaultTimeout(15000);
      resource.errors.push(captureRendererErrors(win));
      proof.guard = await fixture.assertWorker(app, { requireWorker: false });
      proof.runtime = await app.evaluate(({ app }) => ({
        appPath: app.getAppPath(),
        userData: app.getPath("userData"),
        platform: process.platform,
        arch: process.arch,
      }));
      assert.equal(proof.runtime.appPath, appDir);
      assert.equal(proof.runtime.userData, isolated.userDataDir);
      assert.equal(proof.runtime.platform, process.platform);
      assert.equal(proof.runtime.arch, process.arch);
      const checkPet = async (page) => {
        await page.locator("#root").waitFor();
        await page.locator('[data-sidebar-action="toggle"]').waitFor({ state: "visible" });
        assert.equal(
          new URL(page.url()).pathname,
          new URL(pathToFileURL(join(appDir, "out/renderer/index.html"))).pathname,
        );
        await page.waitForFunction(() => Boolean(window.codeshell?.pet));
        const result = await page.evaluate(async () => ({
          active: await window.codeshell.pet.setActiveSession(null),
          snapshot: await window.codeshell.pet.getSnapshot(),
          attention: await window.codeshell.pet.getAttentionSnapshot(),
        }));
        assert.deepEqual(result.active, { ok: true });
        assert.ok(result.snapshot && typeof result.snapshot === "object");
        assert.ok(result.attention && typeof result.attention === "object");
        return { activeSessionCleared: true, snapshotRead: true, attentionRead: true };
      };
      proof.operations.push({
        operation: "cold renderer real Pet IPC",
        result: await checkPet(win),
      });
      await win.reload();
      proof.operations.push({
        operation: "renderer reload real Pet IPC",
        result: await checkPet(win),
      });
      await win.screenshot({ path: join(evidence, `cycle-${cycle}-reload.png`) });
      if (cycle === 1) {
        const opened = app.waitForEvent("window", { timeout: 15000 });
        opened.catch(() => {});
        await win.evaluate(() => window.codeshell.newWindow());
        const other = await opened;
        resource.errors.push(captureRendererErrors(other));
        proof.operations.push({
          operation: "production second window real Pet IPC",
          result: await checkPet(other),
        });
        await other.screenshot({ path: join(evidence, "second-window.png") });
        await other.close();
      }
      await closeCycle(); // Prove this cycle before starting the next Main.
    }
  } catch (error) {
    const diagnostic = getElectronKeychainPreflightDiagnostic(error);
    failures.push({
      message: diagnostic ? "Keychain metadata preflight refused startup" : error.message,
      keychainDiagnostic: diagnostic,
      errors: error.errors?.map((item) => ({
        message: item.message,
        keychainDiagnostic: getElectronKeychainPreflightDiagnostic(item),
      })),
    });
    await win?.screenshot({ path: join(evidence, "failure.png"), timeout: 2000 }).catch(() => {});
  } finally {
    try {
      await closeCycle();
    } catch (error) {
      failures.push({
        message: error.message,
        errors: error.errors?.map((item) => ({
          message: item.message,
          keychainDiagnostic: getElectronKeychainPreflightDiagnostic(item),
        })),
      });
    }
    for (const name of [
      "startup-renderer-loads.jsonl",
      "startup-denied-attempts.jsonl",
      "spawned-workers.jsonl",
      "network-guard.jsonl",
      "cost-gui-guard.jsonl",
      "real-keyring-bootstrap.jsonl",
    ]) {
      try {
        const content = await readFile(join(isolated.home, name), "utf8").catch((error) => {
          if (error.code === "ENOENT") return "";
          throw error;
        });
        await write(join(evidence, name), content);
      } catch (error) {
        failures.push({ message: `Cannot preserve ${name}`, code: error.code });
      }
    }
    try {
      // Preserve the actual load observations even when a cycle failed at shutdown.
      report.loads = await rows("startup-renderer-loads.jsonl");
      assert.equal(cycles.length, 3);
      for (const cycle of cycles) assertStartupCycleSettled(cycle);
      assert.equal(report.loads.length, 4, "Three cold loads plus one production second window");
      assert.ok(
        report.loads.every((entry) => entry.missing.length === 0),
        "Pet handlers must precede every native renderer load",
      );
      assert.ok(
        report.loads.every(
          (entry) =>
            entry.method === "loadFile" && entry.source === join(appDir, "out/renderer/index.html"),
        ),
        "Native loads must target this own compiled renderer",
      );
      assert.ok(
        cycles.every(
          (cycle) =>
            report.loads.filter((load) => load.pid === cycle.pid).length ===
            (cycle.cycle === 1 ? 2 : 1),
        ),
      );
      assert.deepEqual(failures, []);
      await isolated.cleanup();
      report.privateHomeRemoved = true;
      report.status = "passed";
    } catch (error) {
      if (!failures.length) failures.push({ message: error.message });
    }
    await write(join(evidence, "receipt.json"), report);
  }
  console.log(
    JSON.stringify({
      status: report.status,
      evidence,
      cycles: cycles.length,
      privateHomeRemoved: report.privateHomeRemoved,
    }),
  );
  assert.equal(
    report.status,
    "passed",
    "Startup acceptance failed; evidence and private HOME retained",
  );
  return report;
}

if (
  process.argv[1] &&
  fileURLToPath(import.meta.url) === (await realpath(process.argv[1]).catch(() => null))
)
  await runStartupOperationCycles(process.argv.slice(2));
