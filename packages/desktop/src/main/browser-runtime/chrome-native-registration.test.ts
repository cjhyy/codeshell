import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { installChromeNativeMessagingHost } from "./chrome-native-registration.js";
import {
  CHROME_NATIVE_HOST_NAME,
  CODESHELL_CHROME_EXTENSION_ORIGIN,
} from "./chrome-native-protocol.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe("Chrome native host registration", () => {
  test("writes owner-scoped Linux manifests with an exact extension origin", async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "codeshell-native-registration-"));
    temporaryDirectories.push(homeDir);
    const result = await installChromeNativeMessagingHost({
      executablePath: "/opt/codeshell/code-shell",
      appPath: "/opt/codeshell/resources/app.asar",
      resourcesPath: "/opt/codeshell/resources",
      isPackaged: true,
      platform: "linux",
      homeDir,
    });

    expect(result.installed).toBe(true);
    expect(result.manifestPaths).toHaveLength(2);
    for (const manifestPath of result.manifestPaths) {
      expect(existsSync(manifestPath)).toBe(true);
      expect(JSON.parse(readFileSync(manifestPath, "utf8"))).toEqual({
        name: CHROME_NATIVE_HOST_NAME,
        description: "CodeShell Browser Runtime bridge",
        path: "/opt/codeshell/code-shell",
        type: "stdio",
        allowed_origins: [CODESHELL_CHROME_EXTENSION_ORIGIN],
      });
    }
    expect(result.extensionPath).toBe(
      "/opt/codeshell/resources/packages/desktop/resources/chrome-extension",
    );
  });

  test("creates a development wrapper that preserves Chrome's origin argument", async () => {
    const homeDir = mkdtempSync(path.join(os.tmpdir(), "codeshell-native-wrapper-"));
    temporaryDirectories.push(homeDir);
    const result = await installChromeNativeMessagingHost({
      executablePath: "/Applications/Electron.app/Contents/MacOS/Electron",
      appPath: "/repo/packages/desktop",
      resourcesPath: "/repo/packages/desktop",
      isPackaged: false,
      platform: "darwin",
      homeDir,
    });
    const manifest = JSON.parse(readFileSync(result.manifestPaths[0], "utf8")) as {
      path: string;
    };
    const wrapper = readFileSync(manifest.path, "utf8");
    expect(wrapper).toContain("--codeshell-native-messaging-host \"$@\"");
    expect(wrapper).toContain("'/repo/packages/desktop'");
  });
});
