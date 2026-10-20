import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import {
  localPackageConfiguration,
  nativeAppRoot,
  nativePackageArguments,
} from "./smoke-local-package.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const original = JSON.parse(readFileSync(join(here, "../package.json"), "utf8")).build;

test("local acceptance neutralizes release authority while retaining production payload hooks", () => {
  const source = JSON.parse(JSON.stringify(original));
  source.forceCodeSigning = true;
  source.mac.identity = "release identity must not be inherited";
  source.mac.notarize = true;
  const config = localPackageConfiguration(source, {
    output: "/owned/app",
    electronDist: "/locked/electron",
  });
  assert.equal(config.publish, null);
  assert.equal(config.forceCodeSigning, false);
  assert.equal(config.mac.identity, null);
  assert.equal(config.mac.notarize, false);
  for (const key of ["extraResources", "asarUnpack", "files"])
    assert.deepEqual(config[key], original[key]);
  for (const [actual, source] of [
    [config.afterPack, original.afterPack],
    [config.afterSign, original.afterSign],
    [config.mac.sign, original.mac.sign],
  ]) {
    assert.ok(isAbsolute(actual), "Private cwd must not change production hook resolution");
    assert.equal(actual, resolve(here, "..", source));
  }
  assert.ok(source.publish.length && source.forceCodeSigning && source.mac.notarize);
  assert.throws(() => localPackageConfiguration({ ...source, afterPack: null }, {}));
});

test("native package requests cannot cross compile or publish and reject unsupported targets", () => {
  for (const platform of ["darwin", "linux", "win32"])
    for (const arch of ["x64", "arm64"]) {
      const args = nativePackageArguments(platform, arch);
      assert.equal(args.filter((arg) => /^--(?:mac|linux|win)$/.test(arg)).length, 1);
      assert.deepEqual(args.slice(-2), ["--publish", "never"]);
      assert.ok(args.includes(`--${arch}`) && args.includes("--dir"));
      const app = nativeAppRoot("/owned", "code-shell", platform, arch);
      assert.ok(app.startsWith(join("/owned", "")));
      assert.equal(app.endsWith(".app"), platform === "darwin");
    }
  assert.throws(() => nativePackageArguments("freebsd", "x64"));
  assert.throws(() => nativePackageArguments("linux", "ia32"));
  assert.throws(() => nativeAppRoot("/owned", "../escape"));
});

test("actual runner refuses an existing output without altering caller data", () => {
  const directory = mkdtempSync(join(tmpdir(), "codeshell-package-output-test-"));
  try {
    const marker = join(directory, "caller-owned.txt");
    writeFileSync(marker, "must remain intact\n");
    const result = spawnSync(
      process.execPath,
      [join(here, "smoke-local-package.mjs"), "--output", directory],
      {
        env: process.env,
        encoding: "utf8",
        timeout: 5_000,
      },
    );
    assert.equal(result.error, undefined);
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /EEXIST/);
    assert.equal(readFileSync(marker, "utf8"), "must remain intact\n");
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
});
