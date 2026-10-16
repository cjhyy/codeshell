/** Local production DMG + owned copy/reinstall; never /Applications or release updating. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { closeSync, lstatSync, openSync, realpathSync, statfsSync } from "node:fs";
import { lstat, mkdir, readFile, readdir, realpath, rename, writeFile } from "node:fs/promises";
import { createRequire } from "node:module";
import { userInfo } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { localPackageConfiguration } from "./smoke-local-package.mjs";
import { readPackagedUiBuildReceipt } from "./run-packaged-ui-acceptance.mjs";
import { capturePackagedAppIntegrity } from "./packaged-app-integrity.mjs";
import { captureMacosAppMetadata } from "./macos-app-metadata.mjs";
import { readDefaultKeychain } from "./macos-keychain-context.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";
import {
  assertInstalledUiReceipt,
  assertOwnedReadonlyVolume,
  isInside,
  queryOwnedDmgImage,
  readOwnedDmgState,
  runGuardedHdiutil,
} from "./macos-dmg-custody.mjs";

assert.equal(process.platform, "darwin", "DMG acceptance requires actual macOS");
assert.equal(process.env.NODE_ENV, "test", "Run through run-isolated-node-smoke.mjs");
assert.equal(process.env.CODE_SHELL_TEST_HOME, join(process.env.HOME, ".code-shell"));
assert.equal(process.env.CODE_SHELL_HOME, process.env.CODE_SHELL_TEST_HOME);
const options = new Map();
for (let index = 2; index < process.argv.length; index += 2) {
  const [flag, value] = process.argv.slice(index, index + 2);
  assert.ok(["--build-receipt", "--output"].includes(flag) && value && !options.has(flag));
  options.set(flag, resolve(value));
}
assert.equal(
  options.size,
  2,
  "Expected --build-receipt <fresh-receipt> --output <new-owned-directory>",
);
const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
  cwd: repo,
  encoding: "utf8",
}).trim();
assert.equal(
  execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
    cwd: repo,
    encoding: "utf8",
  }).trim(),
  "",
  "Committed clean source is required",
);
const requested = options.get("--output");
const root = join(await realpath(dirname(requested)), basename(requested));
assert.ok(
  root !== repo && !isInside(repo, root),
  "Evidence/installation must remain outside the checkout",
);
await mkdir(root, { mode: 0o700 });
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const put = (file, value) =>
  writeFile(file, typeof value === "string" ? value : JSON.stringify(value, null, 2), {
    mode: 0o600,
    flag: "wx",
  });
const report = {
  fixture: "owned-macos-production-dmg-install",
  status: "failed",
  sourceHead,
  platform: process.platform,
  arch: process.arch,
  root,
  operations: [],
  failures: [],
  boundary:
    "Production dmg-builder target with only a unique intermediate volume title; local ad-hoc app. Readonly DMG copy + same-build owned reinstall, not Developer ID, notarization, Gatekeeper, quarantine, /Applications installation, version migration or release Updater acceptance.",
};
const stateFile = join(root, "mount-custody.json");
let original, guardState;

function freeSpace(required) {
  const info = statfsSync(root);
  const available = info.bavail * info.bsize;
  assert.ok(available >= required, `Insufficient owned build space (${available} < ${required})`);
  return { available, required };
}
async function ownedProcess(label, args, environment, timeoutMs) {
  const stdout = openSync(join(root, `${label}.stdout.log`), "wx", 0o600);
  const stderr = openSync(join(root, `${label}.stderr.log`), "wx", 0o600);
  let monitor, child;
  const errors = [];
  try {
    child = spawn(process.execPath, args, {
      cwd: root,
      env: environment,
      stdio: ["ignore", stdout, stderr],
    });
    const completion = new Promise((done) => {
      child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (child.pid)
      monitor = watchElectronTestProcess(child, {
        timeoutMs,
        reportFailure: (message) => errors.push(message),
      });
    const result = await completion;
    const settlement = await monitor?.completed;
    if (settlement?.status !== "cleaned") report.unprovenProcess = true;
    report.operations.push({ operation: label, result, settlement, errors });
    assert.equal(result.error, undefined);
    assert.equal(result.code, 0, `${label} failed; owned logs retained`);
    assert.equal(result.signal, null);
    assert.equal(settlement?.status, "cleaned");
    assert.deepEqual(errors, []);
  } catch (error) {
    if (!monitor && child) {
      report.unprovenProcess = true;
      child.unref();
    }
    throw error;
  } finally {
    monitor?.();
    closeSync(stdout);
    closeSync(stderr);
  }
}
const metadata = (app) => captureMacosAppMetadata(app, root);
async function copyAndVerify(source, destination, expected) {
  assert.ok(isInside(root, destination));
  await lstat(destination).then(
    () => {
      throw new Error("Preexisting installation destination");
    },
    (error) => {
      if (error.code !== "ENOENT") throw error;
    },
  );
  execFileSync("/usr/bin/ditto", ["--rsrc", "--extattr", "--acl", source, destination], {
    timeout: 120_000,
    stdio: "pipe",
  });
  const actual = await capturePackagedAppIntegrity(destination);
  const attrs = await metadata(destination);
  assert.equal(
    actual.appTreeSHA256,
    expected.integrity.appTreeSHA256,
    "Copied full app inventory differs",
  );
  assert.equal(attrs.sha256, expected.metadata.sha256, "Copied modes, symlinks or xattrs differ");
  return { integrity: actual, metadata: attrs };
}
async function launchInstalled(app, label, keychainReference) {
  const scratch = join(root, `${label}-private`);
  const environment = createBunTestEnvironment(process.env, scratch);
  await ownedProcess(
    label,
    [
      join(repo, "scripts/run-isolated-node-smoke.mjs"),
      join(desktop, "scripts/e2e-ui-packaged.mjs"),
      "--packaged-app",
      app,
      "--default-keychain-reference",
      keychainReference,
      "--evidence-dir",
      join(root, label),
    ],
    environment,
    300_000,
  );
  const receipt = JSON.parse(await readFile(join(root, label, "receipt.json"), "utf8"));
  assertInstalledUiReceipt(receipt, app);
  return receipt;
}

try {
  report.space = freeSpace(10 * 1024 ** 3);
  original = await readPackagedUiBuildReceipt(options.get("--build-receipt"), { sourceHead });
  report.buildReceiptSHA256 = hash(await readFile(options.get("--build-receipt")));
  report.originalBuild = original;
  const integrity = await capturePackagedAppIntegrity(original.appRoot);
  assert.equal(integrity.asarSHA256, original.appAsarSha256);
  assert.equal(integrity.managedNodeManifestSHA256, original.managedNodeManifestSha256);
  const originalMetadata = await metadata(original.appRoot);
  await put(join(root, "original-app.json"), { integrity, metadata: originalMetadata });
  const allocated =
    Number(
      execFileSync("/usr/bin/du", ["-sk", original.appRoot], { encoding: "utf8" }).split(/\s/)[0],
    ) * 1024;
  report.copySpace = freeSpace(Math.max(6 * 1024 ** 3, allocated * 3 + 2 * 1024 ** 3));
  const paths = {
    temporary: join(root, "tmp"),
    artifacts: join(root, "artifacts"),
    readonlyMount: join(root, "readonly-mount"),
    bin: join(root, "bin"),
    installation: join(root, "installation"),
  };
  for (const path of Object.values(paths)) await mkdir(path, { mode: 0o700 });
  const volumeName = `CodeShell-Owned-${randomUUID()}`;
  const stageMount = `/Volumes/${volumeName}`;
  assert.equal(lstatSync(root).uid, process.getuid());
  try {
    lstatSync(stageMount);
    throw Error("Preexisting random build mountpoint");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  guardState = {
    root,
    sourceApp: original.appRoot,
    arch: process.arch,
    volumeName,
    stageMount,
    temporary: paths.temporary,
    artifacts: paths.artifacts,
    readonlyMount: paths.readonlyMount,
    attachments: [],
    commands: [],
  };
  await put(stateFile, guardState);
  const guardScript = fileURLToPath(new URL("./macos-dmg-custody.mjs", import.meta.url));
  await writeFile(
    join(paths.bin, "hdiutil"),
    `#!/bin/sh\nexec '${process.execPath.replace(/'/g, "'\\''")}' '${guardScript.replace(/'/g, "'\\''")}' "$@"\n`,
    { flag: "wx", mode: 0o700 },
  );
  const require = createRequire(join(desktop, "package.json"));
  const builderPackage = require.resolve("electron-builder/package.json");
  const builderRequire = createRequire(builderPackage);
  const appBuilderPackage = builderRequire.resolve("app-builder-lib/package.json");
  const dmgBuilderPackage = createRequire(appBuilderPackage).resolve("dmg-builder/package.json");
  const dmgBuilderRoot = dirname(dmgBuilderPackage);
  const dmgPackage = JSON.parse(await readFile(dmgBuilderPackage, "utf8"));
  assert.equal(dmgPackage.version, "25.1.8", "DMG command guard requires the audited toolchain");
  report.dmgToolchain = {
    version: dmgPackage.version,
    sourceSha256: Object.fromEntries(
      await Promise.all(
        ["dmg.js", "dmgUtil.js", "hdiuil.js"].map(async (file) => [
          file,
          hash(await readFile(join(dmgBuilderRoot, "out", file))),
        ]),
      ),
    ),
  };
  const pkg = JSON.parse(await readFile(join(desktop, "package.json"), "utf8"));
  const electronDist = realpathSync(
    join(dirname(require.resolve("electron/package.json")), "dist"),
  );
  const config = localPackageConfiguration(pkg.build, { output: paths.artifacts, electronDist });
  config.dmg = { ...pkg.build.dmg, title: volumeName };
  const configFile = join(root, "electron-builder.dmg-local.json");
  await put(configFile, config);
  report.configuration = {
    sha256: hash(await readFile(configFile)),
    volumeName,
    onlyDmgMetadataOverride: "title",
    nativeArchOnly: true,
    productionDmgBuilderUnmodified: true,
  };
  const environment = {
    ...createBunTestEnvironment(process.env, join(root, "build-private")),
    PATH: `${paths.bin}:${process.env.PATH}`,
    TMPDIR: paths.temporary,
    TMP: paths.temporary,
    TEMP: paths.temporary,
    CSC_IDENTITY_AUTO_DISCOVERY: "false",
    ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
    ELECTRON_BUILDER_CACHE: join(root, "builder-cache"),
    CODESHELL_NODE_CACHE: join(root, "node-cache"),
    CODESHELL_DMG_GUARD_REFERENCE: stateFile,
  };
  await ownedProcess(
    "production-dmg-build",
    [
      join(dirname(require.resolve("electron-builder/package.json")), "cli.js"),
      "--mac",
      "dmg",
      `--${process.arch}`,
      "--prepackaged",
      original.appRoot,
      "--publish",
      "never",
      "--projectDir",
      desktop,
      "--config",
      configFile,
    ],
    environment,
    600_000,
  );
  const state = readOwnedDmgState(stateFile);
  assert.ok(state.artifact && isInside(paths.artifacts, state.artifact));
  assert.ok(
    state.attachments.length === 1 && state.attachments.every((entry) => entry.detached),
    "Builder mount must detach normally",
  );
  assert.equal(queryOwnedDmgImage(state.stageImage), null);
  runGuardedHdiutil(stateFile, ["verify", state.artifact]);
  report.dmg = {
    path: state.artifact,
    sha256: hash(await readFile(state.artifact)),
    format: "UDZO",
    stageFilesystem: process.arch === "arm64" ? "APFS" : "HFS+",
  };
  runGuardedHdiutil(stateFile, [
    "attach",
    "-readonly",
    "-nobrowse",
    "-noautoopen",
    "-mountpoint",
    paths.readonlyMount,
    "-plist",
    state.artifact,
  ]);
  const volumeXml = execFileSync("/usr/sbin/diskutil", ["info", "-plist", paths.readonlyMount], {
    timeout: 15_000,
    maxBuffer: 2 * 1024 * 1024,
  });
  const volume = JSON.parse(
    execFileSync("/usr/bin/plutil", ["-convert", "json", "-o", "-", "-"], {
      input: volumeXml,
      encoding: "utf8",
      timeout: 5_000,
      maxBuffer: 2 * 1024 * 1024,
    }),
  );
  await put(join(root, "diskutil-readonly-volume.json"), volume);
  const readonlyAttachment = readOwnedDmgState(stateFile).attachments.find(
    (entry) => entry.image === state.artifact && !entry.detached,
  );
  assert.ok(readonlyAttachment, "Readonly attachment custody must be recorded");
  report.readonlyVolume = assertOwnedReadonlyVolume(volume, readonlyAttachment);
  const mounted = join(paths.readonlyMount, `${pkg.build.productName}.app`);
  assert.ok(lstatSync(mounted).isDirectory() && !lstatSync(mounted).isSymbolicLink());
  const mountedSnapshot = {
    integrity: await capturePackagedAppIntegrity(mounted),
    metadata: await metadata(mounted),
  };
  assert.equal(
    mountedSnapshot.integrity.appTreeSHA256,
    integrity.appTreeSHA256,
    "DMG changed application bytes or tree",
  );
  assert.equal(
    mountedSnapshot.metadata.sha256,
    originalMetadata.sha256,
    "DMG changed application metadata",
  );
  await put(join(root, "mounted-app.json"), mountedSnapshot);
  report.dmgEntries = await readdir(paths.readonlyMount);
  // Copy only the actual bundle. The production /Applications link is never followed.
  const installed = join(paths.installation, `${pkg.build.productName}.app`);
  const installedSnapshot = await copyAndVerify(mounted, installed, mountedSnapshot);
  await put(join(root, "installed-app.json"), installedSnapshot);
  const keychainHome = await realpath(userInfo().homedir);
  const reference = { version: 1, home: keychainHome, ...readDefaultKeychain(keychainHome) };
  const keychainFile = join(root, "default-keychain-reference.private.json");
  await put(keychainFile, reference);
  report.installedUi = await launchInstalled(installed, "installed-ui", keychainFile);
  assert.equal(
    (await capturePackagedAppIntegrity(installed)).appTreeSHA256,
    integrity.appTreeSHA256,
  );
  assert.equal((await metadata(installed)).sha256, originalMetadata.sha256);
  // Same-build manual replacement only, after the UI child and observed descendants exited.
  const marker = join(root, "owned-user-data-marker.txt");
  await put(marker, "Owned data outside app survives same-build replacement 中文\n");
  const markerSHA256 = hash(await readFile(marker));
  const staging = join(paths.installation, "replacement.app");
  await copyAndVerify(mounted, staging, mountedSnapshot);
  const backup = join(paths.installation, "previous.app");
  await rename(installed, backup);
  await rename(staging, installed);
  assert.equal(hash(await readFile(marker)), markerSHA256);
  report.reinstall = {
    sameBuild: true,
    manualOwnedReplacement: true,
    markerSHA256,
    markerBoundary: "Synthetic owned file outside app only; no real user-data migration proof",
    updaterAcceptance: false,
  };
  report.reinstalledUi = await launchInstalled(installed, "reinstalled-ui", keychainFile);
  const after = await capturePackagedAppIntegrity(installed);
  assert.equal(after.appTreeSHA256, integrity.appTreeSHA256);
  assert.equal((await metadata(installed)).sha256, originalMetadata.sha256);
  assert.equal(
    (await capturePackagedAppIntegrity(original.appRoot)).appTreeSHA256,
    integrity.appTreeSHA256,
  );
  assert.equal((await metadata(original.appRoot)).sha256, originalMetadata.sha256);
  assert.equal(hash(await readFile(state.artifact)), report.dmg.sha256, "Readonly DMG changed");
  await put(join(root, "after-app.json"), after);
  report.status = "passed";
} catch (error) {
  report.failures.push({ message: error.message, stack: error.stack });
} finally {
  if (guardState && !report.unprovenProcess) {
    try {
      const state = readOwnedDmgState(stateFile);
      for (const attachment of state.attachments.filter((entry) => !entry.detached).reverse()) {
        const current = queryOwnedDmgImage(attachment.image);
        assert.ok(
          current && current.mountpoint === attachment.mountpoint,
          "Cleanup image/mount identity changed",
        );
        runGuardedHdiutil(stateFile, ["detach", "-quiet", attachment.devices[0]]);
      }
      report.mountCustody = readOwnedDmgState(stateFile);
      for (const image of [state.stageImage, state.artifact].filter(Boolean))
        assert.equal(queryOwnedDmgImage(image), null, "Owned image still mounted");
      report.imagesDetached = true;
    } catch (error) {
      report.unprovenMount = true;
      report.failures.push({ cleanup: true, message: error.message });
    }
  }
  if (report.failures.length || !report.imagesDetached) report.status = "failed";
  await put(join(root, "receipt.json"), report);
  console.log(
    JSON.stringify({
      status: report.status,
      root,
      imagesDetached: report.imagesDetached,
      failures: report.failures,
    }),
  );
}
assert.equal(report.status, "passed", "Owned DMG acceptance failed; files/evidence retained");
