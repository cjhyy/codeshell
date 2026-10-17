/** The real type-2 runtime owns APPIMAGE/APPDIR and forks its actual Main.
 * Extract once into a private cache to configure ONLY its setuid sandbox;
 * launch the unchanged image in its production extract-and-run mode. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { constants } from "node:fs";
import { chmod, lstat, mkdir, open, readFile, realpath, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { hashAppImage } from "./build-local-appimage.mjs";
import {
  capturePackagedAppIntegrity,
  inventoryAppTree,
  sha256,
} from "./packaged-app-integrity.mjs";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";
import { readPackagedUiBuildReceipt } from "./run-packaged-ui-acceptance.mjs";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

const inside = (parent, child) => {
  const part = relative(parent, child);
  return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};
const minimalEnvironment = (home, temporary) => ({
  PATH: "/usr/bin:/bin",
  LC_ALL: "C",
  HOME: home,
  TMPDIR: temporary,
  TEMP: temporary,
  TMP: temporary,
});

export function assertAppImageMainIdentity(root, main, rows, expected) {
  assert.ok(root?.birth && Number.isSafeInteger(root.pid));
  const freshRoot = rows.find((row) => row.pid === root.pid);
  assert.deepEqual(freshRoot, root, "AppImage runtime parent incarnation changed");
  assert.ok(Number.isSafeInteger(main?.pid) && main.pid > 0 && main.pid !== root.pid);
  assert.equal(main.ppid, root.pid, "Paused Main is not a direct child of the captured runtime");
  const freshMain = rows.find((row) => row.pid === main.pid);
  assert.ok(freshMain?.birth && freshMain.ppid === root.pid, "Paused Main birth is unproven");
  for (const key of ["executable", "appImage", "appDir", "home"])
    assert.equal(main[key], expected[key], `Runtime-owned Main ${key} mismatch`);
  assert.ok(Array.isArray(main.argv) && !main.argv.some((arg) => /^--no-sandbox(?:=|$)/.test(arg)));
  return { ...main, ...freshMain, launcher: root };
}

export function assertAppImagePayload(source, extracted) {
  const entries = new Map(extracted.map((entry) => [entry[0], entry]));
  for (const entry of source) {
    // SquashFS extraction may normalize directory access modes. File bytes,
    // permissions and all symlink targets must retain the original payload.
    const actual = entries.get(entry[0]);
    assert.ok(actual, `AppImage payload missing ${entry[0]}`);
    if (entry[1] === "directory") assert.equal(actual[1], "directory");
    else assert.deepEqual(actual, entry, `AppImage payload changed ${entry[0]}`);
  }
}

async function readReceipt(file) {
  assert.equal(await realpath(file), resolve(file), "AppImage receipt cannot traverse links");
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const info = await handle.stat();
    assert.ok(info.isFile() && info.size > 0 && info.size <= 64 * 1024);
    return JSON.parse(await handle.readFile("utf8"));
  } finally {
    await handle.close();
  }
}

async function sandboxIdentity(file) {
  const info = await lstat(file);
  assert.ok(info.isFile() && !info.isSymbolicLink() && info.nlink === 1);
  assert.equal(await realpath(file), file);
  return {
    dev: info.dev,
    ino: info.ino,
    uid: info.uid,
    gid: info.gid,
    mode: info.mode & 0o7777,
    size: info.size,
    sha256: sha256(await readFile(file)),
  };
}

async function configureSandbox(file, root) {
  assert.ok(inside(root, file));
  // Every ancestor is canonical, owned and inaccessible to other writers.
  for (let path = dirname(file); ; path = dirname(path)) {
    const info = await lstat(path);
    assert.ok(info.isDirectory() && !info.isSymbolicLink() && info.uid === process.getuid());
    assert.equal(info.mode & 0o022, 0, "AppImage cache ancestor is writable by another user");
    assert.equal(await realpath(path), path);
    if (path === root) break;
    assert.ok(inside(root, path));
  }
  const before = await sandboxIdentity(file);
  assert.equal(before.uid, process.getuid(), "Extracted sandbox must initially belong to fixture");
  const env = minimalEnvironment(root, root);
  for (const [command, args] of [
    ["/usr/bin/chown", ["root:root", file]],
    ["/usr/bin/chmod", ["4755", file]],
  ]) {
    // No shell, PATH lookup, recursive operation or alternative target.
    execFileSync("/usr/bin/sudo", ["-n", command, ...args], {
      env,
      cwd: root,
      timeout: 5_000,
      stdio: "pipe",
    });
    const current = await sandboxIdentity(file);
    for (const key of ["dev", "ino", "size", "sha256"])
      assert.equal(current[key], before[key], "Owned sandbox file identity changed");
  }
  const after = await sandboxIdentity(file);
  assert.equal(after.uid, 0);
  assert.equal(after.gid, 0);
  assert.equal(after.mode, 0o4755);
  return { file, before, after };
}

export async function preparePackagedAppImageRuntime({
  receiptFile,
  sourceApp,
  fixtureRoot,
  evidence,
}) {
  assert.equal(process.platform, "linux", "Actual AppImage acceptance requires native Linux");
  assert.equal(process.arch, "x64");
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
    encoding: "utf8",
    timeout: 5_000,
  }).trim();
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: resolve(dirname(fileURLToPath(import.meta.url)), "../../.."),
      encoding: "utf8",
      timeout: 5_000,
    }).trim(),
    "",
    "AppImage runtime requires committed source",
  );
  const receipt = await readReceipt(receiptFile);
  assert.equal(receipt.status, "passed");
  assert.equal(receipt.kind, "appimage");
  assert.equal(receipt.platform, process.platform);
  assert.equal(receipt.arch, process.arch);
  assert.equal(receipt.sourceHead, sourceHead);
  assert.equal(receipt.sourceDirty, false);
  for (const key of ["publishing", "notarization", "developerIdentity"])
    assert.equal(receipt[key], false);
  assert.equal(receipt.productionHooksRetainedFromSource, true);
  assert.equal(receipt.sourceUnchanged, true);
  const source = await readPackagedUiBuildReceipt(receipt.sourceBuildReceipt, { sourceHead });
  assert.equal(
    sha256(await readFile(receipt.sourceBuildReceipt)),
    receipt.sourceBuildReceiptSha256,
  );
  assert.equal(source.appRoot, await realpath(sourceApp));
  assert.equal(receipt.sourceAppRoot, source.appRoot);
  for (const key of ["appAsarSha256", "managedNodeManifestSha256"])
    assert.equal(receipt[key], source[key], "Image and directory receipts disagree");
  const output = await realpath(receipt.output);
  const image = await realpath(receipt.appImage.path);
  assert.equal(image, resolve(receipt.appImage.path));
  assert.ok(inside(output, image));
  // The type-2 runtime's portable-home sidecars would override the owned HOME.
  for (const suffix of [".home", ".config"])
    await lstat(image + suffix).then(
      () => {
        throw Error("AppImage portable sidecar is forbidden");
      },
      (error) => {
        if (error.code !== "ENOENT") throw error;
      },
    );
  const imageBefore = await hashAppImage(image);
  assert.equal(imageBefore.sha256, receipt.appImage.sha256);
  assert.equal(imageBefore.size, receipt.appImage.size);
  const sourceBefore = await capturePackagedAppIntegrity(sourceApp);
  assert.equal(sourceBefore.asarSHA256, receipt.appAsarSha256);
  assert.equal(sourceBefore.managedNodeManifestSHA256, receipt.managedNodeManifestSha256);
  assert.equal(sourceBefore.appTreeSHA256, receipt.sourceAppTreeSha256);
  const sourceInventory = await inventoryAppTree(sourceApp);
  const root = join(fixtureRoot, "appimage-runtime");
  await mkdir(root, { mode: 0o700 });
  const temporary = join(root, "tmp");
  const extraction = join(root, "extract");
  await mkdir(temporary, { mode: 0o700 });
  await mkdir(extraction, { mode: 0o700 });
  const report = {
    status: "preparing",
    image,
    imageBefore,
    sourceHead,
    sourceBefore,
    failures: [],
  };
  const put = () =>
    writeFile(join(evidence, "appimage-runtime.json"), JSON.stringify(report, null, 2), {
      mode: 0o600,
    });
  let child, monitor, log, closeTimer;
  try {
    log = await open(join(evidence, "appimage-extraction.log"), "wx", 0o600);
    child = spawn(image, ["--appimage-extract"], {
      cwd: extraction,
      env: minimalEnvironment(fixtureRoot, temporary),
      stdio: ["ignore", log.fd, log.fd],
    });
    const completion = new Promise((done) => {
      child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (child.pid)
      monitor = watchElectronTestProcess(child, {
        timeoutMs: 120_000,
        reportFailure: (message) => report.failures.push(message),
      });
    const custody =
      monitor &&
      monitor.completed.then((settlement) => {
        report.extractionSettlement = settlement;
        assert.equal(settlement.status, "cleaned", "AppImage extraction exit is unproven");
        return new Promise((_, reject) => {
          closeTimer = setTimeout(
            () => reject(Error("AppImage extraction close did not settle after proven exit")),
            5_000,
          );
        });
      });
    report.extractionExit = await (custody ? Promise.race([completion, custody]) : completion);
    report.extractionSettlement = monitor && (await monitor.completed);
    assert.equal(report.extractionSettlement?.status, "cleaned");
    assert.deepEqual(report.extractionExit, { code: 0, signal: null });
    assert.deepEqual(report.failures, []);
    const extracted = join(extraction, "squashfs-root");
    assert.equal(await realpath(extracted), extracted);
    const extractedIntegrity = await capturePackagedAppIntegrity(extracted);
    assert.equal(extractedIntegrity.asarSHA256, receipt.appAsarSha256);
    assert.equal(extractedIntegrity.managedNodeManifestSHA256, receipt.managedNodeManifestSha256);
    assertAppImagePayload(sourceInventory, await inventoryAppTree(extracted));
    const appRoot = join(temporary, `appimage_extracted_${imageBefore.runtimeCacheMD5}`);
    await rename(extracted, appRoot);
    await chmod(appRoot, 0o700);
    report.sandbox = await configureSandbox(join(appRoot, "chrome-sandbox"), fixtureRoot);
    const layout = describePackagedAppLayout(appRoot);
    const executable = await realpath(layout.executable);
    assert.equal(executable, layout.executable);
    report.cacheBefore = await capturePackagedAppIntegrity(appRoot);
    await writeFile(
      join(evidence, "appimage-cache-inventory-before.json"),
      JSON.stringify(await inventoryAppTree(appRoot)),
      { mode: 0o600, flag: "wx" },
    );
    report.status = "prepared";
    await put();
    return {
      appRoot,
      launcherExecutable: image,
      environment: {
        APPIMAGE_EXTRACT_AND_RUN: "1",
        NO_CLEANUP: "1",
        TMPDIR: temporary,
        TEMP: temporary,
        TMP: temporary,
      },
      verifyPaused(rootIdentity, main) {
        const identity = assertAppImageMainIdentity(
          rootIdentity,
          main,
          snapshotElectronTestProcesses(),
          {
            executable,
            appImage: image,
            appDir: appRoot,
            home: join(fixtureRoot, "home"),
          },
        );
        report.pausedMain = identity;
        return identity;
      },
      async verifyUnchanged() {
        const failures = [];
        for (const verify of [
          async () => {
            report.imageAfter = await hashAppImage(image);
            assert.deepEqual(report.imageAfter, imageBefore, "Actual AppImage changed");
          },
          async () => {
            report.sourceAfter = await capturePackagedAppIntegrity(sourceApp);
            assert.equal(report.sourceAfter.appTreeSHA256, sourceBefore.appTreeSHA256);
          },
          async () => {
            report.cacheAfter = await capturePackagedAppIntegrity(appRoot);
            await writeFile(
              join(evidence, "appimage-cache-inventory-after.json"),
              JSON.stringify(await inventoryAppTree(appRoot)),
              { mode: 0o600, flag: "wx" },
            );
            assert.equal(report.cacheAfter.appTreeSHA256, report.cacheBefore.appTreeSHA256);
          },
          async () => {
            report.sandboxAfterRuntime = await sandboxIdentity(report.sandbox.file);
            assert.deepEqual(
              report.sandboxAfterRuntime,
              report.sandbox.after,
              "Owned sandbox changed during runtime",
            );
          },
        ]) {
          try {
            await verify();
          } catch (error) {
            failures.push(error);
          }
        }
        report.status = failures.length ? "failed" : "unchanged-after-runtime";
        report.failures.push(...failures.map((error) => error.message));
        await put();
        if (failures.length) throw new AggregateError(failures, "AppImage integrity checks failed");
        return report;
      },
    };
  } catch (error) {
    report.status = "failed";
    report.retainedRuntimeRoot = root;
    report.failures.push(error.message);
    if (monitor && child?.exitCode === null && child?.signalCode === null)
      report.extractionSettlement = await monitor.terminate();
    await put();
    throw error;
  } finally {
    clearTimeout(closeTimer);
    monitor?.();
    await log?.close();
    if (child?.pid && report.extractionSettlement?.status !== "cleaned") child.unref();
  }
}
