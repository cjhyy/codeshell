import assert from "node:assert/strict";
import { createRequire } from "node:module";
import { join, resolve, sep } from "node:path";
import { pathToFileURL } from "node:url";

const require = createRequire(import.meta.url);
const pkg = require("../package.json");
const builderRequire = createRequire(require.resolve("electron-builder/package.json"));
const appBuilderRequire = createRequire(builderRequire.resolve("app-builder-lib/package.json"));
const { sanitizeFileName } = appBuilderRequire("./out/util/filename.js");
const configuredLinuxName = pkg.build.linux.executableName ?? pkg.build.executableName;
// LinuxPackager removes the slash from a scoped name, retaining its scope and @.
const linuxExecutable =
  configuredLinuxName == null
    ? sanitizeFileName(pkg.name).toLowerCase()
    : sanitizeFileName(configuredLinuxName);

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
      : join(root, platform === "win32" ? "code-shell.exe" : linuxExecutable);
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
