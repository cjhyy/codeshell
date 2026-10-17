/** Native Linux AppImage from an already verified, clean directory package.
 * Production payload/hooks were applied by that package build. This conversion
 * never replaces its ASAR, launches the app, signs, notarizes, or publishes. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { lstat, mkdir, open, readFile, readdir, realpath, rm, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { localPackageConfiguration } from "./smoke-local-package.mjs";
import { readPackagedUiBuildReceipt } from "./run-packaged-ui-acceptance.mjs";
import { capturePackagedAppIntegrity, inventoryAppTree } from "./packaged-app-integrity.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import { snapshotElectronTestProcesses } from "./electron-test-process-snapshot.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repository = resolve(desktop, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, child) => {
  const path = relative(parent, child);
  return path && path !== ".." && !path.startsWith(`..${sep}`) && !isAbsolute(path);
};

export function appImageBuildArguments(appRoot, platform = process.platform, arch = process.arch) {
  assert.equal(platform, "linux", "AppImage acceptance must run on native Linux");
  assert.equal(arch, "x64", "AppImage acceptance requires native Linux x64");
  assert.ok(isAbsolute(appRoot), "Verified prepackaged root must be absolute");
  return ["--linux", "AppImage", "--x64", "--prepackaged", appRoot, "--publish", "never"];
}

export function assertType2AppImageHeader(header) {
  assert.ok(
    Buffer.isBuffer(header) &&
      header.length >= 20 &&
      header.subarray(0, 4).equals(Buffer.from([0x7f, 0x45, 0x4c, 0x46])) &&
      header[4] === 2 &&
      header[5] === 1 &&
      header.subarray(8, 11).equals(Buffer.from([0x41, 0x49, 2])) &&
      header.readUInt16LE(18) === 62,
    "Expected the built Linux x64 type-2 AppImage runtime",
  );
}

export async function hashAppImage(file) {
  const info = await lstat(file);
  assert.ok(
    info.isFile() && !info.isSymbolicLink() && info.size > 20 && info.size <= 2 ** 31,
    "AppImage must be a bounded regular file",
  );
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const opened = await handle.stat();
    assert.ok(
      opened.dev === info.dev && opened.ino === info.ino && opened.size === info.size,
      "AppImage identity changed before hashing",
    );
    const header = Buffer.alloc(20);
    await handle.read(header, 0, header.length, 0);
    assertType2AppImageHeader(header);
    const digest = createHash("sha256");
    const runtimeCacheDigest = createHash("md5");
    for await (const bytes of handle.createReadStream({ start: 0, autoClose: false })) {
      digest.update(bytes);
      runtimeCacheDigest.update(bytes);
    }
    const after = await lstat(file);
    const final = await handle.stat();
    assert.ok(
      after.dev === info.dev &&
        after.ino === info.ino &&
        !after.isSymbolicLink() &&
        final.size === info.size &&
        final.mtimeMs === info.mtimeMs,
      "AppImage changed while hashing",
    );
    return {
      sha256: digest.digest("hex"),
      size: info.size,
      // Runtime cache naming only. SHA256 remains the artifact identity.
      runtimeCacheMD5: runtimeCacheDigest.digest("hex"),
    };
  } finally {
    await handle.close();
  }
}

async function main() {
  const [inputFlag, inputFile, outputFlag, destination, ...extra] = process.argv.slice(2);
  assert.ok(
    inputFlag === "--build-receipt" &&
      inputFile &&
      outputFlag === "--output" &&
      destination &&
      !extra.length,
    "usage: build-local-appimage.mjs --build-receipt <verified-dir-receipt> --output <new-owned-dir>",
  );
  appImageBuildArguments(resolve("unused"));
  const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
    cwd: repository,
    encoding: "utf8",
    timeout: 5000,
  }).trim();
  assert.equal(
    execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
      cwd: repository,
      encoding: "utf8",
      timeout: 5000,
    }).trim(),
    "",
    "AppImage conversion requires committed source",
  );
  const source = await readPackagedUiBuildReceipt(resolve(inputFile), { sourceHead });
  assert.equal(source.productionHooksRetained, true, "Source package requires production hooks");
  const before = await capturePackagedAppIntegrity(source.appRoot);
  assert.equal(before.asarSHA256, source.appAsarSha256);
  assert.equal(before.managedNodeManifestSHA256, source.managedNodeManifestSha256);
  const requested = resolve(destination);
  const output = join(await realpath(dirname(requested)), basename(requested));
  assert.ok(
    output !== source.appRoot &&
      !inside(source.appRoot, output) &&
      output !== repository &&
      !inside(repository, output),
    "AppImage output must be outside source package/checkout",
  );
  if (process.env.CODE_SHELL_TEST_HOME) {
    const outerHome = await realpath(process.env.HOME);
    assert.ok(
      output !== outerHome && !inside(outerHome, output),
      "AppImage output must survive outer isolated-HOME cleanup",
    );
  }
  await mkdir(output, { mode: 0o700 });
  const receipt = {
    status: "failed",
    kind: "appimage",
    platform: process.platform,
    arch: process.arch,
    sourceHead,
    output,
    sourceBuildReceipt: await realpath(inputFile),
    sourceBuildReceiptSha256: hash(await readFile(inputFile)),
    sourceAppRoot: source.appRoot,
    appAsarSha256: source.appAsarSha256,
    managedNodeManifestSha256: source.managedNodeManifestSha256,
    sourceDirty: false,
    publishing: false,
    notarization: false,
    developerIdentity: false,
    failures: [],
    started: new Date().toISOString(),
  };
  const privateRoot = join(output, "private-build");
  let child, stop, log, closeTimer;
  try {
    await writeFile(
      join(output, "source-inventory-before.json"),
      JSON.stringify(await inventoryAppTree(source.appRoot)),
      { flag: "wx", mode: 0o600 },
    );
    const own = snapshotElectronTestProcesses().find((row) => row.pid === process.pid);
    assert.equal(own?.ppid, process.ppid, "Process metadata must work before spawning builder");
    const require = createRequire(join(desktop, "package.json"));
    const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
    const electronDist = await realpath(
      join(dirname(require.resolve("electron/package.json")), "dist"),
    );
    const config = localPackageConfiguration(pkg.build, {
      output: join(output, "artifacts"),
      electronDist,
    });
    const configFile = join(output, "electron-builder.appimage.json");
    await writeFile(configFile, JSON.stringify(config, null, 2), { flag: "wx", mode: 0o600 });
    receipt.configSha256 = hash(await readFile(configFile));
    const env = {
      ...createBunTestEnvironment(process.env, privateRoot),
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      ELECTRON_BUILDER_CACHE: join(privateRoot, "electron-builder-cache"),
      CODESHELL_NODE_CACHE: join(privateRoot, "node-cache"),
    };
    log = await open(join(output, "build.log"), "wx", 0o600);
    const cli = join(dirname(require.resolve("electron-builder/package.json")), "cli.js");
    child = spawn(
      process.execPath,
      [
        cli,
        ...appImageBuildArguments(source.appRoot),
        "--projectDir",
        desktop,
        "--config",
        configFile,
      ],
      { cwd: privateRoot, env, stdio: ["ignore", log.fd, log.fd], windowsHide: true },
    );
    const completed = new Promise((done) => {
      child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (child.pid)
      stop = watchElectronTestProcess(child, {
        timeoutMs: 600_000,
        reportFailure: (message) => receipt.failures.push(message),
      });
    const custody =
      stop &&
      stop.completed.then((settlement) => {
        receipt.processSettlement = settlement;
        assert.equal(settlement.status, "cleaned", "Builder process settlement is unproven");
        return new Promise((_, reject) => {
          closeTimer = setTimeout(
            () => reject(Error("Builder close event did not settle after proven exit")),
            5_000,
          );
        });
      });
    receipt.result = await (custody ? Promise.race([completed, custody]) : completed);
    receipt.processSettlement = stop && (await stop.completed);
    assert.equal(receipt.processSettlement?.status, "cleaned");
    assert.equal(receipt.result.error, undefined);
    assert.equal(receipt.result.code, 0);
    assert.equal(receipt.result.signal, null);
    assert.deepEqual(receipt.failures, []);
    const artifacts = join(output, "artifacts");
    const images = (await readdir(artifacts)).filter((name) => name.endsWith(".AppImage"));
    assert.equal(images.length, 1, "Exactly one native AppImage is required");
    const image = await realpath(join(artifacts, images[0]));
    assert.ok(inside(artifacts, image), "AppImage escaped new output");
    receipt.appImage = { path: image, ...(await hashAppImage(image)) };
    receipt.productionHooksRetainedFromSource = true;
    receipt.status = "passed";
  } catch (error) {
    receipt.failures.push(error.message);
    process.exitCode = 1;
    if (stop && child?.exitCode === null && child?.signalCode === null)
      receipt.processSettlement = await stop.terminate();
  } finally {
    clearTimeout(closeTimer);
    for (const close of [() => stop?.(), () => log?.close()]) {
      try {
        await close();
      } catch (error) {
        receipt.status = "failed";
        receipt.failures.push(`Build observer close failed: ${error.message}`);
      }
    }
    if (!child?.pid || receipt.processSettlement?.status === "cleaned") {
      try {
        const after = await capturePackagedAppIntegrity(source.appRoot);
        await writeFile(
          join(output, "source-inventory-after.json"),
          JSON.stringify(await inventoryAppTree(source.appRoot)),
          { flag: "wx", mode: 0o600 },
        );
        assert.equal(
          after.appTreeSHA256,
          before.appTreeSHA256,
          "Prepackaged source changed during conversion",
        );
        receipt.sourceAppTreeSha256 = after.appTreeSHA256;
        receipt.sourceUnchanged = true;
      } catch (error) {
        receipt.status = "failed";
        receipt.failures.push(`Source after-inventory failed: ${error.message}`);
      }
    }
    if (child?.pid && receipt.processSettlement?.status !== "cleaned") {
      receipt.retainedPrivateBuildRoot = privateRoot;
      receipt.status = "failed";
      child.unref();
    } else
      await rm(privateRoot, { recursive: true, force: true }).catch((error) => {
        receipt.status = "failed";
        receipt.failures.push(error.message);
      });
    receipt.finished = new Date().toISOString();
    if (receipt.status !== "passed") process.exitCode = 1;
    await writeFile(
      join(output, "appimage-build-receipt.json"),
      JSON.stringify(receipt, null, 2) + "\n",
      { flag: "wx", mode: 0o600 },
    );
    console.log(JSON.stringify(receipt));
  }
}
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
