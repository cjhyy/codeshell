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
  const resources = join(app, "Contents/Resources");
  const driver = join(resources, "cua-driver/cua-driver");
  const permissions = join(resources, "computer-use/codeshell-permissions");
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

  for (const executable of [driver, permissions]) {
    const info = await lstat(executable);
    if (!info.isFile() || info.size === 0)
      throw new Error(`Packaged computer use executable is missing or empty: ${executable}`);
    await access(executable, constants.X_OK);
    const { stdout } = await run("/usr/bin/lipo", ["-archs", executable]);
    if (stdout.trim().split(/\s+/).sort().join(" ") !== "arm64 x86_64")
      throw new Error(`Packaged computer use executable is not universal: ${executable}`);
    await run("/usr/bin/codesign", ["--verify", "--strict", executable]);
  }
  const license = await readFile(join(resources, "cua-driver/LICENSE"));
  if (createHash("sha256").update(license).digest("hex") !== lock.licenseSha256)
    throw new Error("Packaged Cua driver license checksum mismatch");

  const driverVersion = (await run(driver, ["--version"])).stdout.trim();
  if (driverVersion !== `cua-driver ${lock.version}`)
    throw new Error(`Packaged Cua driver version mismatch: ${driverVersion}`);
  const permissionsVersion = (await run(permissions, ["--version"])).stdout.trim();
  if (permissionsVersion !== "codeshell-permissions 1")
    throw new Error(
      `Packaged computer use permissions helper version mismatch: ${permissionsVersion}`,
    );
  await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
  return {
    app,
    driverVersion: lock.version,
    permissionsVersion: 1,
    architectures: ["arm64", "x64"],
  };
}

if (import.meta.main) {
  const apps = process.argv.slice(2);
  if (!apps.length)
    throw new Error("Usage: bun scripts/verify-computer-use-package.ts <application.app> [...]");
  for (const app of apps) console.log(JSON.stringify(await verifyComputerUsePackage(app)));
}
