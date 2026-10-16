/* Local native directory package for UI acceptance. No install, build, or publishing. */
import assert from "node:assert/strict";
import { execFileSync, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import {
  closeSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { watchElectronTestProcess } from "./electron-test-watchdog.mjs";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repoRoot = resolve(desktopRoot, "../..");
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
const inside = (parent, path) => {
  const part = relative(parent, path);
  return part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part);
};

/** Keep the production resource/signing hooks even though no release identity is used. */
export function localPackageConfiguration(build, { output, electronDist }) {
  assert.equal(build.afterPack, "scripts/after-pack-adhoc-sign.cjs");
  assert.equal(build.afterSign, "scripts/after-sign-managed-node.cjs");
  assert.equal(build.mac.sign, "scripts/sign-managed-node-mac.cjs");
  return {
    ...build,
    // electron-builder resolves hook strings against cwd, independently of projectDir.
    afterPack: resolve(desktopRoot, build.afterPack),
    afterSign: resolve(desktopRoot, build.afterSign),
    publish: null,
    forceCodeSigning: false,
    // install already rebuilds node-pty against the locked Electron ABI on this OS.
    npmRebuild: false,
    nodeGypRebuild: false,
    electronDist,
    directories: { ...build.directories, output },
    mac: {
      ...build.mac,
      sign: resolve(desktopRoot, build.mac.sign),
      identity: null,
      notarize: false,
    },
  };
}

export function nativePackageArguments(platform = process.platform, arch = process.arch) {
  const target = { darwin: "--mac", win32: "--win", linux: "--linux" }[platform];
  assert.ok(target && ["arm64", "x64"].includes(arch), "Unsupported native package platform/arch");
  return ["--dir", target, `--${arch}`, "--publish", "never"];
}

export function nativeAppRoot(
  output,
  productName,
  platform = process.platform,
  arch = process.arch,
) {
  nativePackageArguments(platform, arch);
  assert.ok(productName && !/[\\/\0]/.test(productName), "Invalid product filename");
  const suffix = arch === "arm64" ? "-arm64" : "";
  if (platform === "darwin") return join(output, `mac${suffix}`, `${productName}.app`);
  return join(output, `${platform === "win32" ? "win" : "linux"}${suffix}-unpacked`);
}

async function main() {
  const [flag, destination, ...extra] = process.argv.slice(2);
  assert.ok(
    flag === "--output" && destination && !extra.length,
    "usage: node smoke-local-package.mjs --output <new-owned-directory>",
  );
  nativePackageArguments();
  const requested = resolve(destination);
  const parent = realpathSync(dirname(requested));
  const output = join(parent, basename(requested));
  assert.ok(
    !inside(desktopRoot, output) && output !== desktopRoot,
    "Output must be outside Desktop",
  );
  mkdirSync(output, { mode: 0o700 }); // Exclusive: never reuse or clean an existing output.
  assert.ok(lstatSync(output).isDirectory() && !lstatSync(output).isSymbolicLink());

  const started = new Date().toISOString();
  const receipt = {
    status: "failed",
    started,
    platform: process.platform,
    arch: process.arch,
    node: process.version,
    sourceHead: null,
    output,
    appRoot: null,
    publishing: false,
    notarization: false,
    developerIdentity: false,
    productionHooksRetained: false,
    failures: [],
  };
  const privateRoot = join(output, "private-build");
  let stop;
  let child;
  let logDescriptor;
  try {
    receipt.sourceHead = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoRoot,
      encoding: "utf8",
      timeout: 5_000,
    }).trim();
    receipt.sourceDirty = Boolean(
      execFileSync("git", ["status", "--porcelain", "--untracked-files=no"], {
        cwd: repoRoot,
        encoding: "utf8",
        timeout: 5_000,
      }).trim(),
    );
    receipt.sourceBoundary =
      "Packaging checkout HEAD; caller builds dependencies and Desktop before predist and packaging";
    const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
    const require = createRequire(join(desktopRoot, "package.json"));
    // Do not ask electron-builder to download a second Electron or reuse operator caches.
    const electronDist = realpathSync(
      join(dirname(require.resolve("electron/package.json")), "dist"),
    );
    const packageOutput = join(output, "app");
    const config = localPackageConfiguration(pkg.build, { output: packageOutput, electronDist });
    receipt.productionHooksRetained = true;
    receipt.productionHooks = [config.afterPack, config.afterSign, config.mac.sign].map((file) => ({
      path: relative(desktopRoot, file),
      sha256: hash(readFileSync(file)),
    }));
    const configFile = join(output, "electron-builder.local.json");
    writeFileSync(configFile, JSON.stringify(config, null, 2) + "\n", { flag: "wx", mode: 0o600 });
    receipt.configSha256 = hash(readFileSync(configFile));
    receipt.productVersion = pkg.version;
    receipt.nativeRebuild = "workspace postinstall; electron-builder rebuild disabled";
    receipt.macSigning =
      process.platform === "darwin" ? "production ad-hoc hooks" : "not applicable";
    const environment = {
      ...createBunTestEnvironment(process.env, privateRoot),
      CSC_IDENTITY_AUTO_DISCOVERY: "false",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      ELECTRON_BUILDER_CACHE: join(privateRoot, "electron-builder-cache"),
      CODESHELL_NODE_CACHE: join(privateRoot, "node-cache"),
      SWIFT_MODULECACHE_PATH: join(privateRoot, "swift-module-cache"),
      CLANG_MODULE_CACHE_PATH: join(privateRoot, "clang-module-cache"),
    };
    const cli = join(dirname(require.resolve("electron-builder/package.json")), "cli.js");
    const args = [
      cli,
      ...nativePackageArguments(),
      "--projectDir",
      desktopRoot,
      "--config",
      configFile,
    ];
    logDescriptor = openSync(join(output, "build.log"), "wx", 0o600);
    console.log(`Packaging native ${process.platform}/${process.arch}; evidence: ${output}`);
    child = spawn(process.execPath, args, {
      // The CLI automatically loads cwd/electron-builder.env. A fresh owned
      // cwd prevents local dotenv credentials from bypassing the env allowlist.
      cwd: privateRoot,
      env: environment,
      stdio: ["ignore", logDescriptor, logDescriptor],
      windowsHide: true,
    });
    // Install listeners before the process identity query, including the spawn-error path.
    const completion = new Promise((done) => {
      child.once("error", (error) => done({ code: null, signal: null, error: error.message }));
      child.once("close", (code, signal) => done({ code, signal }));
    });
    if (child.pid)
      stop = watchElectronTestProcess(child, {
        timeoutMs: 600_000,
        reportFailure: (message) => receipt.failures.push(message),
      });
    receipt.result = await completion;
    if (stop) {
      assert.ok(stop.completed, "The three-platform process watchdog settlement API is required");
      receipt.processSettlement = await stop.completed;
      assert.equal(receipt.processSettlement.status, "cleaned", "Package processes must exit");
    }
    assert.equal(receipt.result.error, undefined, receipt.result.error);
    assert.equal(receipt.result.signal, null, "Local package process must exit normally");
    assert.equal(receipt.result.code, 0, "Local package process must succeed");
    assert.deepEqual(receipt.failures, [], "Process lifetime verification must succeed");
    const appRoot = realpathSync(nativeAppRoot(packageOutput, pkg.build.productName));
    assert.ok(inside(packageOutput, appRoot), "Native app must be inside the new owned output");
    const resources = join(
      appRoot,
      ...(process.platform === "darwin" ? ["Contents", "Resources"] : ["resources"]),
    );
    const asar = join(resources, "app.asar");
    assert.ok(lstatSync(asar).isFile(), "Package must contain its actual application archive");
    receipt.appRoot = appRoot;
    receipt.appAsarSha256 = hash(readFileSync(asar));
    receipt.managedNodeManifestSha256 = hash(
      readFileSync(join(resources, "runtimes", "node", "manifest.json")),
    );
    receipt.status = "passed";
  } catch (error) {
    receipt.failures.push(error.message);
    process.exitCode = 1;
  } finally {
    try {
      stop?.();
      if (logDescriptor !== undefined) closeSync(logDescriptor);
    } catch (error) {
      receipt.status = "failed";
      receipt.failures.push(`Build observer cleanup failed: ${error.message}`);
      process.exitCode = 1;
    }
    const retainPrivateRoot =
      child?.pid && (!stop || receipt.processSettlement?.status !== "cleaned");
    // Output/app and bounded evidence remain; private HOME/download caches do not.
    if (retainPrivateRoot) {
      receipt.status = "failed";
      receipt.retainedPrivateBuildRoot = privateRoot;
      receipt.failures.push("Process exit is unproven; private HOME retained for owned cleanup");
      child?.unref();
      process.exitCode = 1;
    } else {
      try {
        rmSync(privateRoot, { recursive: true, force: true });
      } catch (error) {
        receipt.status = "failed";
        receipt.failures.push(`Private build cleanup failed: ${error.message}`);
        process.exitCode = 1;
      }
    }
    receipt.finished = new Date().toISOString();
    writeFileSync(join(output, "build-receipt.json"), JSON.stringify(receipt, null, 2) + "\n", {
      flag: "wx",
      mode: 0o600,
    });
    console.log(JSON.stringify(receipt));
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
