// electron-builder's afterPack precedes automatic signing. The custom mac.sign
// hook signs the native helpers, records Node's final bytes, then seals the app.
/* global require, module */
/* eslint-disable @typescript-eslint/no-require-imports -- electron-builder resolves these build hooks as CommonJS. */
const { execFile } = require("node:child_process");
const { createRequire } = require("node:module");
const { promisify } = require("node:util");
const { join } = require("node:path");
const runtime = require("./managed-node-runtime.cjs");

const exec = promisify(execFile);
const APP_ID = "com.cjhyy.codeshell";
const COMPUTER_USE_ID = "com.cjhyy.codeshell.computer-use";
const ENTITLEMENTS = join(__dirname, "managed-node-entitlements.plist");
const NODE_SIGN_IGNORE = /\/Contents\/Resources\/runtimes\/node\/bin\/node$/;

/**
 * A fixed, self-signed certificate for the outer app (no Developer ID): its
 * designated requirement then names the certificate, so the login keychain and
 * privacy grants keep trusting every release signed with it. Unset, the app
 * stays ad-hoc exactly as before.
 */
function localSigningIdentity(env) {
  const identity = env.CODESHELL_MAC_SIGNING_IDENTITY;
  if (!identity) return undefined;
  if (!/^[0-9A-F]{40}$/i.test(identity))
    throw new Error("CODESHELL_MAC_SIGNING_IDENTITY must be a certificate SHA-1");
  const keychain = env.CODESHELL_MAC_SIGNING_KEYCHAIN || undefined;
  return { identity, keychain };
}

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
  const env = overrides.env ?? process.env;
  function computerUseCode(app) {
    const helper = join(app, "Contents/Library/CodeShell Computer Use.app");
    // Seal nested native code before the helper, then seal the containing app.
    return [join(helper, "Contents/Resources/cua-driver"), helper];
  }
  async function signComputerUse(app, identity, keychain) {
    // The driver is outside the standard nested-code directories, so sign it
    // explicitly before sealing the independent helper application.
    for (const executable of computerUseCode(app)) {
      const args = ["--force", "--sign", identity, "--options", "runtime"];
      if (identity !== "-") args.push("--timestamp");
      else if (executable.endsWith(".app"))
        args.push(`-r=designated => identifier "${COMPUTER_USE_ID}"`);
      if (keychain) args.push("--keychain", keychain);
      args.push(executable);
      await run("codesign", args);
    }
  }
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
    for (const executable of computerUseCode(app))
      await run("codesign", ["--verify", "--strict", executable]);
    await run("codesign", ["--verify", "--strict", join(runtimeDir, "bin/node")]);
    await run("codesign", ["--verify", "--deep", "--strict", app]);
    await supply.verifyRuntime(runtimeDir);
  }
  async function afterPack(context) {
    // Reject a bad identity before any bytes change.
    const local = localSigningIdentity(env);
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
    await signComputerUse(app, "-");
    await signNode(runtimeDir, "-");
    if (local) {
      // Only the outer seal: the Computer Use helper keeps its own ad-hoc
      // requirement, so its Accessibility grant is not reset.
      const args = ["--force", "--sign", local.identity];
      if (local.keychain) args.push("--keychain", local.keychain);
      await run("codesign", [...args, app]);
    } else {
      await run("codesign", ["--force", "-s", "-", `-r=designated => identifier "${APP_ID}"`, app]);
    }
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
    await signComputerUse(options.app, options.identity, options.keychain);
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
