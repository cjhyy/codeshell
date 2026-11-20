import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { symlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const require = createRequire(import.meta.url);
const desktop = fileURLToPath(new URL("../", import.meta.url));
const root = process.env.CODE_SHELL_TEST_HOME;
assert(
  root && root === process.env.CODE_SHELL_HOME,
  "Use run-isolated-node-smoke.mjs",
);

// Load the production Desktop Web wiring into a minimal Electron main process.
// The bundle and its external workspace dependencies live outside the packaged out/.
const service = join(root, "desktop-web-service.mjs");
await symlink(join(desktop, "node_modules"), join(root, "node_modules"), "dir");
await build({
  entryPoints: [join(desktop, "src/main/desktop-web-service.ts")],
  absWorkingDir: desktop,
  bundle: true,
  platform: "node",
  format: "esm",
  packages: "external",
  tsconfigRaw: {},
  outfile: service,
});
const main = fileURLToPath(
  new URL("./__fixtures__/electron-runtime-main.mjs", import.meta.url),
);
const child = spawnSync(
  require("electron"),
  ["--user-data-dir=" + join(root, "profile"), main, service],
  { stdio: "inherit", timeout: 90_000, killSignal: "SIGKILL" },
);
if (child.error) throw child.error;
assert.equal(
  child.status,
  0,
  `Electron runtime smoke failed (${child.signal || child.status})`,
);
