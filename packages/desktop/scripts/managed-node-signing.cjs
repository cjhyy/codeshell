// electron-builder's afterPack precedes automatic signing. The custom mac.sign
// hook seals Node first, records its final bytes, then signs the surrounding app.
/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder resolves these build hooks as CommonJS. */
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const { promisify } = require("node:util");
const { join } = require("node:path");
const runtime = require("./managed-node-runtime.cjs");

const exec = promisify(execFile);
const APP_ID = "com.cjhyy.codeshell";
const ENTITLEMENTS = join(__dirname, "managed-node-entitlements.plist");
const NODE_SIGN_IGNORE = /\/Contents\/Resources\/runtimes\/node\/bin\/node$/;

function builderSign(options) {
  // Resolve transitive dependencies through electron-builder, including Bun's
  // isolated dependency layout; they are not public Desktop dependencies.
  const builderRequire = createRequire(require.resolve("electron-builder"));
  const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
  return libRequire("@electron/osx-sign").signAsync(options);
}

function createSigningHooks(overrides = {}) {
  const supply = overrides.supply ?? runtime;
  const run =
    overrides.run ??
    ((command, args) =>
      exec(command, args, {
        timeout: 120_000,
        maxBuffer: 4 * 1024 * 1024,
        windowsHide: true,
      }));
  const signAsync = overrides.signAsync ?? builderSign;
  async function signNode(runtimeDir, identity, keychain) {
    const args = [
      "--force",
      "--sign",
      identity,
      "--options",
      "runtime",
      "--entitlements",
      ENTITLEMENTS,
    ];
    if (identity !== "-") args.push("--timestamp");
    if (keychain) args.push("--keychain", keychain);
    args.push(join(runtimeDir, "bin/node"));
    await run("codesign", args);
    await supply.refreshManifest(runtimeDir);
  }
  async function verifySignedApp(app, runtimeDir) {
    await run("codesign", ["--verify", "--strict", join(runtimeDir, "bin/node")]);
    await run("codesign", ["--verify", "--deep", "--strict", app]);
    await supply.verifyRuntime(runtimeDir);
  }
  async function afterPack(context) {
    const target = supply.packagingTarget(context);
    const runtimeDir = supply.packagedRuntimeDirectory(context);
    await supply.stageRuntime({
      ...target,
      runtimeDir,
      cacheDir: process.env.CODESHELL_NODE_CACHE,
      offline: process.env.CODESHELL_NODE_OFFLINE === "1",
    });
    if (target.platform !== "darwin") {
      await supply.verifyRuntime(runtimeDir, target);
      return;
    }
    const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
    // Preserve the existing unsigned-build fallback and stable Squirrel update
    // requirement. Node's entitlements and digest must follow the deep pass.
    await run("codesign", ["--deep", "--force", "-s", "-", app]);
    await signNode(runtimeDir, "-");
    await run("codesign", ["--force", "-s", "-", `-r=designated => identifier "${APP_ID}"`, app]);
    await verifySignedApp(app, runtimeDir);
    await run("codesign", ["--verify", `-R=identifier "${APP_ID}"`, app]);
  }
  async function macSign(options, packager) {
    const runtimeDir = join(options.app, "Contents/Resources/runtimes/node");
    if (!options.identity) {
      if (packager.forceCodeSigning)
        throw new Error("Managed Node signing requires a macOS signing identity");
      await verifySignedApp(options.app, runtimeDir);
      return;
    }
    // Refuse a misconfigured hook: osx-sign must not re-sign Node after the
    // manifest hash is recorded. Keep the builder's ignore function unchanged.
    const executable = join(runtimeDir, "bin/node");
    if (typeof options.ignore !== "function" || !options.ignore(executable))
      throw new Error("mac.signIgnore must exclude the already signed managed Node executable");
    await signNode(runtimeDir, options.identity, options.keychain);
    await signAsync(options);
    await verifySignedApp(options.app, runtimeDir);
  }
  async function afterSign(context) {
    const runtimeDir = supply.packagedRuntimeDirectory(context);
    await supply.verifyRuntime(runtimeDir, supply.packagingTarget(context));
    if (context.electronPlatformName === "darwin") {
      const app = join(context.appOutDir, `${context.packager.appInfo.productFilename}.app`);
      await verifySignedApp(app, runtimeDir);
    }
    // Read-only: electron-builder may already have notarized the app here.
  }
  return { afterPack, macSign, afterSign };
}

module.exports = { createSigningHooks, NODE_SIGN_IGNORE };
