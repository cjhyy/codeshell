// This file is both a local CLI and electron-builder's per-architecture beforeBuild hook.
/* global require, module, exports */
/* eslint-disable @typescript-eslint/no-require-imports -- Node CLI and CommonJS builder hook. */
const { execFileSync } = require("node:child_process");
const { existsSync, readFileSync } = require("node:fs");
const { createRequire } = require("node:module");
const { dirname, join, resolve } = require("node:path");

const desktop = resolve(__dirname, "..");

function rebuild(arch, force) {
  const electronVersion = require("electron/package.json").version;
  const rebuildRequire = createRequire(require.resolve("@electron/rebuild"));
  const cli = rebuildRequire.resolve("./cli.js");
  const abi = rebuildRequire("node-abi").getAbi(electronVersion, "electron");
  const build = join(dirname(require.resolve("node-pty/package.json")), "build", "Release");
  const marker = join(build, ".forge-meta");
  const expected = [process.platform, arch, abi].join("--");
  const addon = join(build, process.platform === "win32" ? "conpty.node" : "pty.node");
  const ready = () =>
    existsSync(addon) && existsSync(marker) && readFileSync(marker, "utf8") === expected;
  if (!force && ready()) return;
  execFileSync(
    process.execPath,
    [
      cli,
      "--module-dir",
      desktop,
      "--version",
      electronVersion,
      "--arch",
      arch,
      "--only",
      "node-pty",
      "--force",
      "--build-from-source",
    ],
    { cwd: desktop, stdio: "inherit" },
  );
  if (!ready()) throw new Error("node-pty was not rebuilt for " + expected);
}

exports.beforeBuild = ({ arch }) => {
  rebuild(arch, true);
  // The production dependency closures are already materialized by predist.
  return false;
};

if (require.main === module) {
  const force = process.env.FORCE_REBUILD_NATIVE === "1";
  try {
    rebuild(process.arch, force);
  } catch (error) {
    if (force || !process.argv.includes("--optional")) throw error;
    console.warn(
      "[rebuild-native] Terminal unavailable until rebuild:native succeeds:",
      error.message,
    );
  }
}
