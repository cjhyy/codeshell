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
  const sourceSandbox = source.find((entry) => entry[0] === "chrome-sandbox");
  const changes = [];
  for (const entry of [...source, ...extracted]) {
    if (!["file", "directory"].includes(entry[1])) continue;
    const mode = entry[2];
    assert.ok(Number.isSafeInteger(mode) && mode >= 0 && mode <= 0o7777);
    assert.equal(mode & 0o3022, 0, `Unapproved writable/SGID/sticky payload mode: ${entry[0]}`);
    assert.ok(
      !(mode & 0o4000) ||
        (entry[0] === "chrome-sandbox" &&
          entry[1] === "file" &&
          mode === 0o4755 &&
          sourceSandbox?.[2] === 0o4755),
      `Unapproved setuid payload mode: ${entry[0]}`,
    );
  }
  for (const entry of source) {
    const actual = entries.get(entry[0]);
    assert.ok(actual, `AppImage payload missing ${entry[0]}`);
    assert.equal(actual[1], entry[1], `AppImage payload type changed ${entry[0]}`);
    if (entry[1] === "link") {
      assert.deepEqual(actual, entry, `AppImage symlink changed ${entry[0]}`);
      continue;
    }
    if (entry[1] === "file") {
      assert.deepEqual(
        actual.slice(3),
        entry.slice(3),
        `AppImage payload bytes changed ${entry[0]}`,
      );
    }
    if (actual[2] === entry[2]) continue;
    // app-builder/pkg/fs/{copier,file}.go describes this copy normalization.
    // With installed app-builder-bin 5.0.0-alpha.10, CI observed only the
    // public LICENSE 0600->0644 difference; do not generalize file changes.
    // The copier normalizes directories to 0755. Its copied
    // files gain read bits and lose SUID/SGID. Keep only the observed public
    // managed-Node LICENSE conversion plus stripping the approved sandbox's
    // SUID; other file-mode changes still require a separately reviewed case.
    const directory = entry[1] === "directory" && entry[2] === 0o700 && actual[2] === 0o755;
    // The shipped appimage-12.0.1 runtime-x64 mkdir_p calls mkdir(..., 0700).
    // CI confirmed all 73 source 0755 directories extract as 0700. This exact
    // owner-only conversion cannot grant execute/write or privilege bits.
    const privateDirectory = entry[1] === "directory" && entry[2] === 0o755 && actual[2] === 0o700;
    const license =
      entry[0] === "resources/runtimes/node/LICENSE" &&
      entry[1] === "file" &&
      entry[2] === 0o600 &&
      actual[2] === 0o644;
    const sandbox =
      entry[0] === "chrome-sandbox" &&
      entry[1] === "file" &&
      entry[2] === 0o4755 &&
      actual[2] === 0o755;
    if (!(directory || privateDirectory || license || sandbox)) {
      const failure = {
        path: entry[0],
        type: entry[1],
        sourceMode: entry[2],
        extractedMode: actual[2],
        sourceModeOctal: `0${entry[2].toString(8)}`,
        extractedModeOctal: `0${actual[2].toString(8)}`,
      };
      const error = new assert.AssertionError({
        message: `AppImage payload mode changed ${entry[0]}: source ${failure.sourceModeOctal}, extracted ${failure.extractedModeOctal}`,
        expected: entry[2],
        actual: actual[2],
        operator: "reviewed payload mode normalization",
      });
      error.appImagePayloadModeFailure = failure;
      throw error;
    }
    changes.push({
      path: entry[0],
      type: entry[1],
      sourceMode: entry[2],
      extractedMode: actual[2],
      rule: privateDirectory
        ? "AppImage runtime creates private directories 0755 to 0700"
        : directory
          ? "builder directory 0700 to 0755"
          : license
            ? "public managed Node LICENSE 0600 to 0644"
            : "builder removes sandbox setuid; owned sandbox configured separately",
    });
  }
  return changes;
}

/** The generic app inventory intentionally stores ordinary 0777 modes.
 * Payload validation also needs SUID/SGID/sticky bits, before any sudo step.
 * Supplying previously byte-verified records rereads only current metadata. */
export async function inventoryAppImagePayload(root, records) {
  records ??= await inventoryAppTree(root);
  return Promise.all(
    records.map(async (entry) => {
      if (!["file", "directory"].includes(entry[1])) return [...entry];
      const info = await lstat(join(root, entry[0]));
      assert.ok(
        !info.isSymbolicLink() && (entry[1] === "file" ? info.isFile() : info.isDirectory()),
        `Payload type changed while reading permissions: ${entry[0]}`,
      );
      const record = [...entry];
      record[2] = info.mode & 0o7777;
      return record;
    }),
  );
}
const payloadPermissions = (records) => records.map((record) => record.slice(0, 3));

/** Preserve complete, bounded full-mode evidence before validation can fail.
 * These are fixture-relative names and metadata only, never file contents.
 * Oversized inventories fail closed instead of writing truncated evidence. */
export async function assertAppImagePayloadWithEvidence(source, extracted, { evidence, report }) {
  const inventories = [
    ["source", source],
    ["extracted", extracted],
  ].map(([kind, records]) => {
    assert.ok(records.length <= 20_000, `${kind} payload permission inventory exceeds row limit`);
    const json = JSON.stringify(payloadPermissions(records));
    const bytes = Buffer.byteLength(json);
    assert.ok(bytes <= 4 * 1024 * 1024, `${kind} payload permission inventory exceeds byte limit`);
    return {
      kind,
      file: `appimage-${kind}-payload-permissions-before.json`,
      entries: records.length,
      bytes,
      sha256: sha256(json),
      json,
    };
  });
  report.payloadPermissionEvidence = inventories.map(({ json: _json, ...metadata }) => metadata);
  for (const inventory of inventories)
    await writeFile(join(evidence, inventory.file), inventory.json, { mode: 0o600, flag: "wx" });
  try {
    return assertAppImagePayload(source, extracted);
  } catch (error) {
    if (error.appImagePayloadModeFailure)
      report.payloadModeFailure = error.appImagePayloadModeFailure;
    throw error;
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
  const sourceInventory = await inventoryAppImagePayload(sourceApp);
  const sourcePermissions = payloadPermissions(sourceInventory);
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
    payloadPermissionsVersion: 1,
    sourcePayloadPermissionsSHA256: sha256(JSON.stringify(sourcePermissions)),
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
    const extractedInventory = await inventoryAppImagePayload(extracted);
    report.payloadModeNormalizations = await assertAppImagePayloadWithEvidence(
      sourceInventory,
      extractedInventory,
      { evidence, report },
    );
    const appRoot = join(temporary, `appimage_extracted_${imageBefore.runtimeCacheMD5}`);
    await rename(extracted, appRoot);
    await chmod(appRoot, 0o700);
    report.sandbox = await configureSandbox(join(appRoot, "chrome-sandbox"), fixtureRoot);
    const layout = describePackagedAppLayout(appRoot);
    const executable = await realpath(layout.executable);
    assert.equal(executable, layout.executable);
    report.cacheBefore = await capturePackagedAppIntegrity(appRoot);
    const cacheInventory = await inventoryAppImagePayload(appRoot, extractedInventory);
    const cachePermissions = payloadPermissions(cacheInventory);
    report.cachePayloadPermissionsSHA256 = sha256(JSON.stringify(cachePermissions));
    await writeFile(
      join(evidence, "appimage-cache-payload-permissions-before.json"),
      JSON.stringify(cachePermissions),
      { mode: 0o600, flag: "wx" },
    );
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
            const permissions = payloadPermissions(
              await inventoryAppImagePayload(sourceApp, sourceInventory),
            );
            report.sourcePayloadPermissionsAfterSHA256 = sha256(JSON.stringify(permissions));
            await writeFile(
              join(evidence, "appimage-source-payload-permissions-after.json"),
              JSON.stringify(permissions),
              { mode: 0o600, flag: "wx" },
            );
            assert.equal(
              report.sourcePayloadPermissionsAfterSHA256,
              report.sourcePayloadPermissionsSHA256,
              "Source package full permissions changed",
            );
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
            const permissions = payloadPermissions(
              await inventoryAppImagePayload(appRoot, cacheInventory),
            );
            report.cachePayloadPermissionsAfterSHA256 = sha256(JSON.stringify(permissions));
            await writeFile(
              join(evidence, "appimage-cache-payload-permissions-after.json"),
              JSON.stringify(permissions),
              { mode: 0o600, flag: "wx" },
            );
            assert.equal(
              report.cachePayloadPermissionsAfterSHA256,
              report.cachePayloadPermissionsSHA256,
              "Runtime cache full permissions changed",
            );
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
