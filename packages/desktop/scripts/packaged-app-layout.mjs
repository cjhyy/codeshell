import assert from "node:assert/strict";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

/** Select a package format without executing or inspecting its binaries. The
 * platform override supports fixture trees on the current filesystem; native
 * Windows path-to-URL conversion is provided by Node's pathToFileURL. */
export function describePackagedAppLayout(appRoot, { platform = process.platform } = {}) {
  assert.ok(["darwin", "win32", "linux"].includes(platform), "Unsupported packaged platform");
  const root = resolve(appRoot);
  const resources =
    platform === "darwin" ? join(root, "Contents", "Resources") : join(root, "resources");
  const executable =
    platform === "darwin"
      ? join(root, "Contents", "MacOS", "code-shell")
      : // LinuxPackager defaults to the sanitized package name, whereas Windows
        // and macOS use productName. Keep the existing release binary contract.
        join(root, platform === "win32" ? "code-shell.exe" : "code-shell-desktop");
  return {
    root,
    resources,
    executable,
    managedNode: join(
      resources,
      "runtimes",
      "node",
      "bin",
      platform === "win32" ? "node.exe" : "node",
    ),
    mainURLPrefix: pathToFileURL(join(resources, "app.asar", "out", "main") + sep).href,
  };
}
