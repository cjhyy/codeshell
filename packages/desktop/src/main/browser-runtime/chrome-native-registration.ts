import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  CHROME_NATIVE_HOST_NAME,
  CODESHELL_CHROME_EXTENSION_ORIGIN,
} from "./chrome-native-protocol.js";

const execFileAsync = promisify(execFile);

export interface ChromeNativeRegistrationOptions {
  executablePath: string;
  appPath: string;
  resourcesPath: string;
  isPackaged: boolean;
  platform?: NodeJS.Platform;
  homeDir?: string;
}

export interface ChromeNativeRegistrationResult {
  installed: boolean;
  manifestPaths: string[];
  extensionPath: string;
  detail?: string;
}

/** Register the desktop executable as Chrome's native messaging host. */
export async function installChromeNativeMessagingHost(
  options: ChromeNativeRegistrationOptions,
): Promise<ChromeNativeRegistrationResult> {
  const platform = options.platform ?? process.platform;
  const homeDir = options.homeDir ?? os.homedir();
  const supportDir = path.join(homeDir, ".code-shell", "browser-runtime", "chrome-extension");
  await mkdir(supportDir, { recursive: true, mode: 0o700 });
  const executable = await nativeHostExecutable(options, supportDir, platform);
  const manifest = {
    name: CHROME_NATIVE_HOST_NAME,
    description: "CodeShell Browser Runtime bridge",
    path: executable,
    type: "stdio",
    allowed_origins: [CODESHELL_CHROME_EXTENSION_ORIGIN],
  };
  const manifestJson = `${JSON.stringify(manifest, null, 2)}\n`;
  const manifestPaths: string[] = [];

  if (platform === "darwin") {
    manifestPaths.push(
      path.join(
        homeDir,
        "Library",
        "Application Support",
        "Google",
        "Chrome",
        "NativeMessagingHosts",
        `${CHROME_NATIVE_HOST_NAME}.json`,
      ),
    );
  } else if (platform === "linux") {
    manifestPaths.push(
      path.join(
        homeDir,
        ".config",
        "google-chrome",
        "NativeMessagingHosts",
        `${CHROME_NATIVE_HOST_NAME}.json`,
      ),
      path.join(
        homeDir,
        ".config",
        "chromium",
        "NativeMessagingHosts",
        `${CHROME_NATIVE_HOST_NAME}.json`,
      ),
    );
  } else if (platform === "win32") {
    const manifestPath = path.join(supportDir, `${CHROME_NATIVE_HOST_NAME}.json`);
    await writeOwnerFile(manifestPath, manifestJson);
    await execFileAsync("reg.exe", [
      "ADD",
      `HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\${CHROME_NATIVE_HOST_NAME}`,
      "/ve",
      "/t",
      "REG_SZ",
      "/d",
      manifestPath,
      "/f",
    ]);
    manifestPaths.push(manifestPath);
  } else {
    return {
      installed: false,
      manifestPaths: [],
      extensionPath: chromeExtensionPath(options),
      detail: `Chrome Native Messaging is not supported on ${platform}`,
    };
  }

  if (platform !== "win32") {
    for (const manifestPath of manifestPaths) await writeOwnerFile(manifestPath, manifestJson);
  }
  return {
    installed: true,
    manifestPaths,
    extensionPath: chromeExtensionPath(options),
  };
}

export function chromeExtensionPath(options: ChromeNativeRegistrationOptions): string {
  return options.isPackaged
    ? path.join(options.resourcesPath, "packages", "desktop", "resources", "chrome-extension")
    : path.join(options.appPath, "resources", "chrome-extension");
}

async function nativeHostExecutable(
  options: ChromeNativeRegistrationOptions,
  supportDir: string,
  platform: NodeJS.Platform,
): Promise<string> {
  if (options.isPackaged) return path.resolve(options.executablePath);
  if (platform === "win32") {
    throw new Error("Chrome Native Messaging development registration on Windows requires a packaged app");
  }
  const wrapperPath = path.join(supportDir, "codeshell-chrome-native-host.sh");
  const script = [
    "#!/bin/sh",
    // `"$@"` stays double-quoted in the emitted shell script — that is what
    // preserves argv boundaries. The backslashes were only escaping for the
    // template literal, where they are unnecessary.
    `exec ${shellQuote(options.executablePath)} ${shellQuote(options.appPath)} --codeshell-native-messaging-host "$@"`,
    "",
  ].join("\n");
  await writeOwnerFile(wrapperPath, script);
  await chmod(wrapperPath, 0o700);
  return wrapperPath;
}

async function writeOwnerFile(filePath: string, content: string): Promise<void> {
  await mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await writeFile(filePath, content, { mode: 0o600 });
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}
