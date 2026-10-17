import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  planServiceWorkerBrowserExecutable,
  resolveServiceWorkerBrowserExecutable,
} from "./service-worker-browser-executable.mjs";

const desktopRequire = createRequire(new URL("../../desktop/package.json", import.meta.url));
const require = createRequire(desktopRequire.resolve("playwright/package.json"));
const packagePath = require.resolve("playwright-core/package.json");
const packageRoot = path.dirname(packagePath);
const packageMetadata = JSON.parse(await readFile(packagePath, "utf8"));
const browsersMetadata = JSON.parse(
  await readFile(path.join(packageRoot, "browsers.json"), "utf8"),
);
const expected = () => ({
  packageMetadata: globalThis.structuredClone(packageMetadata),
  browsersMetadata: globalThis.structuredClone(browsersMetadata),
  registrySourceSHA256: "2325ca4c1c83070e89dc49fb82525508f0a68e0cf12e2a624277968da216b7e0",
  metadataSHA256: "2cfd419f71ac6475d81e1301fa86c34cf2a2a6bae2a0da4b5a2b18310216b6bf",
  environment: { PLAYWRIGHT_BROWSERS_PATH: "/owned-cache" },
  platform: "linux",
  arch: "x64",
});

test("locked registry plans preserve headless-shell instead of regular Chromium", () => {
  for (const [platform, arch, cacheRoot, executablePath] of [
    [
      "linux",
      "x64",
      "/owned-cache",
      "/owned-cache/chromium_headless_shell-1248/chrome-headless-shell-linux64/chrome-headless-shell",
    ],
    [
      "linux",
      "arm64",
      "/owned-cache",
      "/owned-cache/chromium_headless_shell-1248/chrome-headless-shell-linux-arm64/chrome-headless-shell",
    ],
    [
      "win32",
      "x64",
      "D:\\owned-cache",
      "D:\\owned-cache\\chromium_headless_shell-1248\\chrome-headless-shell-win64\\chrome-headless-shell.exe",
    ],
  ]) {
    assert.deepEqual(
      planServiceWorkerBrowserExecutable({
        ...expected(),
        platform,
        arch,
        environment: { PLAYWRIGHT_BROWSERS_PATH: cacheRoot },
      }),
      { executablePath, selection: "locked-headless-shell", cacheRoot },
    );
  }
});

test("legacy darwin Chrome and explicit override selection remain distinct", () => {
  const options = { ...expected(), platform: "darwin", arch: "arm64", environment: {} };
  assert.deepEqual(planServiceWorkerBrowserExecutable(options), {
    executablePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    selection: "legacy-darwin-chrome",
    cacheRoot: null,
  });
  assert.deepEqual(
    planServiceWorkerBrowserExecutable({
      ...options,
      environment: { CODESHELL_TEST_CHROMIUM: "/owned 中文 browser/Chrome" },
    }),
    {
      executablePath: "/owned 中文 browser/Chrome",
      selection: "explicit-override",
      cacheRoot: null,
    },
  );
});

test("unknown metadata, revisions, overrides, source and platform fail closed", () => {
  for (const change of [
    (value) => (value.packageMetadata.version = "1.65.0"),
    (value) => (value.registrySourceSHA256 = "0".repeat(64)),
    (value) => (value.metadataSHA256 = "0".repeat(64)),
    (value) => (value.browsersMetadata.browsers = []),
    (value) => value.browsersMetadata.browsers.push(value.browsersMetadata.browsers[1]),
    (value) => (value.browsersMetadata.browsers[1].revision = "../foreign"),
    (value) =>
      (value.browsersMetadata.browsers[1].revisionOverrides = { "ubuntu24.04-x64": "1248" }),
    (value) => (value.browsersMetadata.browsers[1].installByDefault = false),
    (value) => (value.platform = "freebsd"),
    (value) => ((value.platform = "win32"), (value.arch = "arm64")),
  ]) {
    const value = expected();
    change(value);
    assert.throws(() => planServiceWorkerBrowserExecutable(value));
  }
});

test("default cache and explicit browser paths cannot introduce relative or traversal aliases", () => {
  for (const environment of [
    {},
    { PLAYWRIGHT_BROWSERS_PATH: "0" },
    { PLAYWRIGHT_BROWSERS_PATH: "relative-cache" },
    { PLAYWRIGHT_BROWSERS_PATH: "/owned/../foreign" },
    { CODESHELL_TEST_CHROMIUM: "relative-browser" },
    { CODESHELL_TEST_CHROMIUM: "/owned/../foreign/browser" },
  ])
    assert.throws(() => planServiceWorkerBrowserExecutable({ ...expected(), environment }));
});

async function ownedFiles(run) {
  const root = await realpath(await mkdtemp(path.join(tmpdir(), "codeshell-sw-executable-unit-")));
  try {
    await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("resolver pins owned regular file bytes without executing a browser", async () => {
  await ownedFiles(async (root) => {
    const executablePath = path.join(root, "owned-browser-bytes");
    const bytes = Buffer.from("Owned inert fixture; never a browser executable. 中文\n");
    await writeFile(executablePath, bytes, { mode: 0o600 });
    const result = await resolveServiceWorkerBrowserExecutable({
      playwrightCorePackagePath: packagePath,
      environment: { CODESHELL_TEST_CHROMIUM: executablePath },
    });
    assert.equal(result.executablePath, executablePath);
    assert.equal(result.receipt.selection, "explicit-override");
    assert.equal(result.receipt.executableSHA256, createHash("sha256").update(bytes).digest("hex"));
    assert.equal(result.receipt.executableBytes, bytes.length);
    assert.equal(result.receipt.playwrightVersion, "1.64.0");
    assert.equal(result.receipt.registrySourceSHA256, expected().registrySourceSHA256);
    assert.equal(result.receipt.metadataSHA256, expected().metadataSHA256);
  });
});

test("resolver refuses foreign parent aliases and non-regular browser files", async () => {
  await ownedFiles(async (root) => {
    const actual = path.join(root, "actual");
    const alias = path.join(root, "alias");
    await mkdir(actual);
    await writeFile(path.join(actual, "browser"), "owned inert bytes");
    await symlink(actual, alias, process.platform === "win32" ? "junction" : "dir");
    await assert.rejects(
      resolveServiceWorkerBrowserExecutable({
        playwrightCorePackagePath: packagePath,
        environment: { CODESHELL_TEST_CHROMIUM: path.join(alias, "browser") },
      }),
      /path has an alias/,
    );
    await assert.rejects(
      resolveServiceWorkerBrowserExecutable({
        playwrightCorePackagePath: packagePath,
        environment: { CODESHELL_TEST_CHROMIUM: actual },
      }),
      /regular browser file/,
    );
  });
});

test("resolver refuses changed installed metadata before resolving any binary", async () => {
  await ownedFiles(async (root) => {
    const installed = path.join(root, "playwright-core");
    await mkdir(path.join(installed, "lib"), { recursive: true });
    await copyFile(packagePath, path.join(installed, "package.json"));
    await copyFile(
      path.join(packageRoot, "lib/coreBundle.js"),
      path.join(installed, "lib/coreBundle.js"),
    );
    const modified = globalThis.structuredClone(browsersMetadata);
    modified.browsers[1].revision = "9999";
    await writeFile(path.join(installed, "browsers.json"), JSON.stringify(modified));
    await assert.rejects(
      resolveServiceWorkerBrowserExecutable({
        playwrightCorePackagePath: path.join(installed, "package.json"),
        environment: { CODESHELL_TEST_CHROMIUM: path.join(root, "must-not-be-read") },
      }),
      /Unsupported installed browser metadata/,
    );
  });
});

test("foreign platform planning cannot be mistaken for actual filesystem/native validation", async () => {
  await assert.rejects(
    resolveServiceWorkerBrowserExecutable({
      playwrightCorePackagePath: "/must-not-be-read/package.json",
      platform: process.platform === "win32" ? "linux" : "win32",
    }),
    /actual filesystem platform/,
  );
});
