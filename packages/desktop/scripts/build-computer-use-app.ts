import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { buildComputerUseDriver } from "./build-computer-use-driver.js";

const desktopRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const execute = promisify(execFile);
export const COMPUTER_USE_APP_NAME = "CodeShell Computer Use.app";
export const COMPUTER_USE_BUNDLE_ID = "com.cjhyy.codeshell.computer-use";

/** Build a LaunchServices application that owns its own macOS privacy grants. */
export async function buildComputerUseApp(outputDirectory?: string): Promise<void> {
  if (process.platform !== "darwin") return;
  const destination = outputDirectory ?? join(desktopRoot, "out/native");
  await mkdir(destination, { recursive: true });
  const temporary = await mkdtemp(join(destination, ".computer-use-build-"));
  const run = (command: string, args: string[]) =>
    execute(command, args, { timeout: 120_000, maxBuffer: 1024 * 1024 });
  try {
    const app = join(temporary, COMPUTER_USE_APP_NAME);
    const contents = join(app, "Contents");
    const macos = join(contents, "MacOS");
    const resources = join(contents, "Resources");
    await mkdir(macos, { recursive: true });
    await mkdir(resources, { recursive: true });
    // The driver is verified before it enters the helper bundle. Reuse the
    // locked archive cache for dev and production, never a global installation.
    await buildComputerUseDriver({ outputDirectory: resources });
    const source = join(desktopRoot, "src/main/computer-use/native/computer-use.swift");
    for (const [architecture, minimumVersion] of [
      ["arm64", "11.0"],
      ["x86_64", "10.15"],
    ]) {
      await run("/usr/bin/xcrun", [
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
    const executable = join(macos, "codeshell-computer-use");
    await run("/usr/bin/lipo", [
      "-create",
      join(temporary, "arm64"),
      join(temporary, "x86_64"),
      "-output",
      executable,
    ]);
    await chmod(executable, 0o755);
    const { version } = JSON.parse(await readFile(join(desktopRoot, "package.json"), "utf8"));
    if (typeof version !== "string" || !/^\d+\.\d+\.\d+(?:-[a-zA-Z0-9.-]+)?$/.test(version))
      throw new Error("Computer Use app requires a valid desktop version");
    await writeFile(
      join(contents, "Info.plist"),
      `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${COMPUTER_USE_BUNDLE_ID}</string>
<key>CFBundleName</key><string>CodeShell Computer Use</string>
<key>CFBundleDisplayName</key><string>CodeShell Computer Use</string>
<key>CFBundleExecutable</key><string>codeshell-computer-use</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>${version.split("-")[0]}</string>
<key>CFBundleShortVersionString</key><string>${version}</string>
<key>CFBundleIconFile</key><string>AppIcon</string>
<key>LSUIElement</key><true/>
<key>LSMinimumSystemVersion</key><string>10.15</string>
<key>NSHighResolutionCapable</key><true/>
</dict></plist>
`,
    );
    await copyFile(join(desktopRoot, "build/icon.icns"), join(resources, "AppIcon.icns"));
    await run("/usr/bin/plutil", ["-lint", join(contents, "Info.plist")]);
    // Dev launches need a sealed bundle too. Packaging replaces these ad-hoc
    // signatures with the release identity before sealing the containing app.
    await run("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      join(resources, "cua-driver"),
    ]);
    await run("/usr/bin/codesign", [
      "--force",
      "--sign",
      "-",
      "--options",
      "runtime",
      `-r=designated => identifier "${COMPUTER_USE_BUNDLE_ID}"`,
      app,
    ]);
    await run("/usr/bin/codesign", ["--verify", "--deep", "--strict", app]);
    const target = join(destination, COMPUTER_USE_APP_NAME);
    await rm(target, { recursive: true, force: true });
    await rename(app, target);
  } finally {
    await rm(temporary, { recursive: true, force: true });
  }
}

if (import.meta.main) await buildComputerUseApp();
