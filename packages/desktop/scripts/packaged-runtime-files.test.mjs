import assert from "node:assert/strict";
import {
  mkdtempSync,
  mkdirSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
  readFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const require = createRequire(import.meta.url);
const config = require("../package.json").build;
const builder = createRequire(require.resolve("electron-builder/package.json"));
const lib = createRequire(builder.resolve("app-builder-lib/package.json"));
const { PlatformPackager, CancellationToken } = builder("app-builder-lib");
const { AsyncTaskManager } = lib("builder-util");
const asar = lib("@electron/asar");

test("builder packages the materialized modules and Bun links with external dependency handling", async (t) => {
  const root = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-builder-asar-")));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const desktop = join(root, "packages/desktop");
  const out = join(root, "dist");
  const resources = join(out, "resources");
  const core = "node_modules/@cjhyy/code-shell-core";
  const packed = [
    "out/main/index.mjs",
    "node_modules/@cjhyy/code-shell-link/dist/index.js",
    "node_modules/@cjhyy/code-shell-pet/dist/index.js",
    "node_modules/@cjhyy/code-shell-capability-coding/dist/index.js",
    "node_modules/@cjhyy/code-shell-capability-optimization-lab/node_modules/sample/index.js",
    core + "/dist/sources/documents/worker.js",
    core + "/node_modules/@scope/sdk/node_modules/sample/index.js",
    "node_modules/playwright-core/lib/index.js",
  ];
  const unpacked = [
    "out/mobile/index.html",
    core + "/package.json",
    core + "/dist/sources/documents/parser-entry.js",
    core + "/node_modules/pdfjs-dist/legacy/build/pdf.mjs",
    core +
      "/node_modules/@napi-rs/canvas/node_modules/@napi-rs/canvas-darwin-arm64/skia.darwin-arm64.node",
    "node_modules/node-pty/lib/index.js",
    "node_modules/node-pty/lib/worker/conoutSocketWorker.js",
    "node_modules/node-pty/build/Release/pty.node",
  ];
  const excluded = ["node_modules/dev-only/index.js", core + "/node_modules/.bin/example"];
  for (const path of [...packed, ...unpacked, ...excluded, "package.json"]) {
    const isLinked = /^node_modules\/(?:node-pty|playwright-core)\//.test(path);
    const file = join(isLinked ? root : desktop, path);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, path.endsWith("package.json") ? "{}" : path);
  }
  for (const name of ["node-pty", "playwright-core"]) {
    symlinkSync(
      join(root, "node_modules", name),
      join(desktop, "node_modules", name),
      process.platform === "win32" ? "junction" : "dir",
    );
  }
  mkdirSync(resources, { recursive: true });

  // Run builder's ASAR stage directly. beforeBuild returns false in release
  // packages, disabling builder's automatic collection of production modules.
  const info = {
    projectDir: desktop,
    appDir: desktop,
    config,
    metadata: {},
    framework: {},
    buildResourcesDir: "build",
    areNodeModulesHandledExternally: true,
    getWorkspaceRoot: async () => root,
    debugLogger: { isEnabled: false },
  };
  const tasks = new AsyncTaskManager(new CancellationToken());
  PlatformPackager.prototype.copyAppFiles.call(
    { config, info },
    tasks,
    {},
    resources,
    join(resources, "app"),
    { outDir: out },
    {},
    [],
    (value) => value,
  );
  await tasks.awaitTasks();

  const archive = join(resources, "app.asar");
  for (const path of packed) assert.ok(!asar.statFile(archive, path).unpacked, path);
  for (const path of unpacked) {
    assert.equal(asar.statFile(archive, path).unpacked, true, path);
    assert.equal(
      readFileSync(join(archive + ".unpacked", path), "utf8"),
      path.endsWith("package.json") ? "{}" : path,
    );
  }
  for (const path of excluded) assert.throws(() => asar.statFile(archive, path), /not found/);
});
