import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";

const exec = promisify(execFile);
const lockPath = new URL("../resources/cua-driver.lock.json", import.meta.url);

type CommandRunner = (command: string, args: string[]) => Promise<{ stdout: string }>;

const execute: CommandRunner = (command, args) =>
  exec(command, args, {
    // --version must stay independent of local configuration or permission grants.
    env: { PATH: "", CUA_DRIVER_EMBEDDED: "1" },
    timeout: 15_000,
    maxBuffer: 64 * 1024,
  });

/** Inspect a finished macOS bundle without requesting permissions or capturing the screen. */
export async function verifyComputerUsePackage(
  appPath: string,
  options: { run?: CommandRunner } = {},
) {
  if (!options.run && process.platform !== "darwin")
    throw new Error("Computer use package acceptance requires macOS");
  const run = options.run ?? execute;
  const app = resolve(appPath);
  const helper = join(app, "Contents/Library/CodeShell Computer Use.app");
  const resources = join(helper, "Contents/Resources");
  const driver = join(resources, "cua-driver");
  const executable = join(helper, "Contents/MacOS/codeshell-computer-use");
  const helperBundleId = "com.cjhyy.codeshell.computer-use";
  const lock = JSON.parse(await readFile(lockPath, "utf8")) as {
    version?: unknown;
    licenseSha256?: unknown;
  };
  if (
    typeof lock.version !== "string" ||
    !/^\d+\.\d+\.\d+$/.test(lock.version) ||
    typeof lock.licenseSha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(lock.licenseSha256)
  )
    throw new Error("Cua driver lock has no valid pinned version or license digest");

  for (const binary of [driver, executable]) {
    const info = await lstat(binary);
    if (!info.isFile() || info.size === 0)
      throw new Error(`Packaged computer use executable is missing or empty: ${binary}`);
    await access(binary, constants.X_OK);
    const { stdout } = await run("/usr/bin/lipo", ["-archs", binary]);
    if (stdout.trim().split(/\s+/).sort().join(" ") !== "arm64 x86_64")
      throw new Error(`Packaged computer use executable is not universal: ${binary}`);
    await run("/usr/bin/codesign", ["--verify", "--strict", binary]);
  }
  const metadata = JSON.parse(
    (
      await run("/usr/bin/plutil", [
        "-convert",
        "json",
        "-o",
        "-",
        join(helper, "Contents/Info.plist"),
      ])
    ).stdout,
  );
  if (
    metadata.CFBundleIdentifier !== helperBundleId ||
    metadata.CFBundleExecutable !== "codeshell-computer-use" ||
    metadata.CFBundleDisplayName !== "CodeShell Computer Use" ||
    metadata.CFBundlePackageType !== "APPL" ||
    metadata.LSUIElement !== true
  )
    throw new Error("Packaged Computer Use helper has an invalid application identity");
  const license = await readFile(join(resources, "LICENSE"));
  if (createHash("sha256").update(license).digest("hex") !== lock.licenseSha256)
    throw new Error("Packaged Cua driver license checksum mismatch");

  const driverVersion = (await run(driver, ["--version"])).stdout.trim();
  if (driverVersion !== `cua-driver ${lock.version}`)
    throw new Error(`Packaged Cua driver version mismatch: ${driverVersion}`);
  const helperVersion = (await run(executable, ["--version"])).stdout.trim();
  if (helperVersion !== "codeshell-computer-use 1")
    throw new Error(`Packaged computer use helper version mismatch: ${helperVersion}`);
  await run("/usr/bin/codesign", [
    "--verify",
    "--deep",
    "--strict",
    `-R=identifier "${helperBundleId}"`,
    helper,
  ]);
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  return {
    app,
    driverVersion: lock.version,
    helperVersion: 1,
    helperBundleId,
    architectures: ["arm64", "x64"],
  };
}

if (import.meta.main) {
  const apps = process.argv.slice(2);
  if (!apps.length)
    throw new Error("Usage: bun scripts/verify-computer-use-package.ts <application.app> [...]");
  for (const app of apps) console.log(JSON.stringify(await verifyComputerUsePackage(app)));
}
