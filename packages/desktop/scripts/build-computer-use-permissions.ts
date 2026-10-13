import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rename, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

function execute(command: string, args: string[]): Promise<void> {
  return new Promise((done, reject) => {
    execFile(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 }, (error, _out, err) => {
      if (error) reject(new Error(`${command} failed: ${err || error.message}`, { cause: error }));
      else done();
    });
  });
}

/** Build both macOS architectures so either Electron target can ship the helper. */
export async function buildComputerUsePermissions(outputDirectory?: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const destination = outputDirectory ?? join(desktopRoot, "out", "native");
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(destination, ".permissions-build-"));
  try {
    const source = join(desktopRoot, "src/main/computer-use/native/permissions.swift");
    for (const [architecture, minimumVersion] of [
      ["arm64", "11.0"],
      ["x86_64", "10.15"],
    ]) {
      await execute("/usr/bin/xcrun", [
        "swiftc",
        "-O",
        "-parse-as-library",
        "-target",
        `${architecture}-apple-macosx${minimumVersion}`,
        source,
        "-o",
        join(temporary, architecture!),
      ]);
    }
    const universal = join(temporary, "codeshell-permissions");
    await execute("/usr/bin/lipo", [
      "-create",
      join(temporary, "arm64"),
      join(temporary, "x86_64"),
      "-output",
      universal,
    ]);
    await chmod(universal, 0o755);
    await rename(universal, join(destination, "codeshell-permissions"));
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildComputerUsePermissions();
