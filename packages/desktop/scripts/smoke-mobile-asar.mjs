/* Mobile remote static delivery and auth boundary from a real ASAR layout.
 *
 *   node ../../scripts/run-isolated-node-smoke.mjs scripts/smoke-mobile-asar.mjs
 *     Fixture mode: packs a synthetic out/{main,mobile} tree with this
 *     package's asarUnpack patterns via @electron/asar. It proves the resolver,
 *     serving and auth logic against Electron's ASAR fs, but NOT that
 *     electron-builder produced the same layout or that the real mobile build
 *     is served.
 *
 *   ... scripts/smoke-mobile-asar.mjs --app <fresh electron-builder --dir app>
 *     Package mode: reads (never writes) a freshly built package, checks its
 *     archive header and unpacked layout, and serves its real mobile build.
 *
 * Both modes run the Electron half (smoke-mobile-asar-fixture.mjs) with this
 * checkout's Electron in Node mode, so no app entry, window, profile,
 * single-instance lock, updater or tunnel is involved, under an isolated HOME
 * and a loopback-only network guard. Production modules are bundled from the
 * source tree; the packaged main bundle itself is not executed. */
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";

const desktop = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const repo = resolve(desktop, "../..");
const serverSource = join(repo, "packages/server/src/mobile-remote");
const require = createRequire(join(desktop, "package.json"));
const builderRequire = createRequire(require.resolve("electron-builder"));
const libRequire = createRequire(builderRequire.resolve("app-builder-lib"));
const asar = libRequire("@electron/asar");
const esbuild = require("esbuild");
const electron = require("electron");
const manifest = JSON.parse(readFileSync(join(desktop, "package.json"), "utf8"));

const args = process.argv.slice(2);
assert.ok(
  args.length === 0 || (args.length === 2 && args[0] === "--app" && args[1]),
  "usage: smoke-mobile-asar.mjs [--app <freshly built package>]",
);
const appArgument = args[1];
const within = (parent, path) => {
  const part = relative(parent, path);
  return part === "" || (part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part));
};
const header = (archive) => (path) => asar.statFile(archive, path, false);

const INDEX = `<!doctype html><html><head><title>CodeShell Remote</title>
<script type="module" crossorigin src="/mobile/assets/index-SMOKE1.js"></script>
<link rel="stylesheet" crossorigin href="/mobile/assets/index-SMOKE1.css">
</head><body><div id="root"></div></body></html>`;

const temporary = mkdtempSync(join(tmpdir(), "codeshell-mobile-asar-"));
try {
  const config = { passcodeFile: join(temporary, "access", "access.json") };
  if (appArgument) {
    const appRoot = realpathSync(resolve(appArgument));
    // Only a fresh build output: never an installed or running application.
    for (const installed of ["/Applications", join(userInfo().homedir, "Applications")]) {
      assert.ok(!within(installed, appRoot), `refusing installed application: ${appRoot}`);
    }
    const { resources } = describePackagedAppLayout(appRoot);
    const archive = join(resources, "app.asar");
    assert.ok(lstatSync(archive).isFile(), "package must contain app.asar");
    const entry = header(archive);
    assert.ok(entry("out/main").files, "archive must contain the bundled main");
    const listed = asar
      .listPackage(archive)
      .map((path) => path.split(sep).join("/"))
      .filter((path) => path.startsWith("/out/mobile/"));
    const files = listed.filter((path) => entry(path.slice(1)).size !== undefined);
    assert.ok(files.includes("/out/mobile/index.html"), "archive lists the mobile index");
    for (const path of files) {
      assert.equal(entry(path.slice(1)).unpacked, true, `must be unpacked: ${path}`);
      assert.ok(lstatSync(join(`${archive}.unpacked`, path.slice(1))).isFile(), path);
    }
    Object.assign(config, {
      mode: "package",
      resources,
      expectedRoot: join(`${archive}.unpacked`, "out", "mobile"),
      packagedMobileFiles: files.length,
      symlinkProbe: false,
    });
  } else {
    const stage = join(temporary, "stage");
    mkdirSync(join(stage, "out/main"), { recursive: true });
    mkdirSync(join(stage, "out/mobile/assets"), { recursive: true });
    writeFileSync(join(stage, "out/main/index.mjs"), "export {};\n");
    writeFileSync(join(stage, "out/mobile/index.html"), INDEX);
    writeFileSync(
      join(stage, "out/mobile/assets/index-SMOKE1.js"),
      'document.getElementById("root").textContent = "asar smoke";\n',
    );
    writeFileSync(join(stage, "out/mobile/assets/index-SMOKE1.css"), "#root{color:#010203}\n");
    // The current packaging patterns and, for comparison, the 0.9.48 layout
    // that kept out/mobile inside the archive.
    const current = join(temporary, "current", "Contents", "Resources");
    const legacy = join(temporary, "legacy", "Contents", "Resources");
    mkdirSync(current, { recursive: true });
    mkdirSync(legacy, { recursive: true });
    await asar.createPackageWithOptions(stage, join(current, "app.asar"), {
      unpack: `${stage}/{${manifest.build.asarUnpack.join(",")}}`,
    });
    await asar.createPackageWithOptions(stage, join(legacy, "app.asar"), {});
    const archive = join(current, "app.asar");
    const unpacked = join(`${archive}.unpacked`, "out", "mobile");
    for (const path of ["index.html", "assets/index-SMOKE1.js", "assets/index-SMOKE1.css"]) {
      assert.equal(header(archive)(`out/mobile/${path}`).unpacked, true, path);
      assert.ok(existsSync(join(unpacked, path)), path);
    }
    assert.equal(header(archive)("out/main/index.mjs").unpacked, undefined);
    assert.equal(existsSync(join(`${archive}.unpacked`, "out", "main")), false);
    // Outside-root bytes linked from inside the (owned, temporary) served root.
    writeFileSync(join(temporary, "outside-secret.txt"), "private bytes");
    const symlinkProbe = process.platform !== "win32";
    if (symlinkProbe) {
      symlinkSync(join(temporary, "outside-secret.txt"), join(unpacked, "escape.txt"));
    }
    Object.assign(config, {
      mode: "fixture",
      resources: current,
      legacyResources: legacy,
      expectedRoot: unpacked,
      symlinkProbe,
    });
  }

  const bundle = join(temporary, "bundle");
  await esbuild.build({
    entryPoints: {
      "mobile-static": join(serverSource, "mobile-static.ts"),
      "remote-host-manager": join(serverSource, "remote-host-manager.ts"),
      "access-passcode": join(serverSource, "access-passcode.ts"),
      "mobile-static-root": join(desktop, "src/main/mobile-remote/mobile-static-root.ts"),
      "network-fixture": join(repo, "tests/helpers/network-fixture.ts"),
    },
    bundle: true,
    platform: "node",
    format: "esm",
    outdir: bundle,
    // ws loads these optional native accelerators lazily inside try/catch.
    external: ["bufferutil", "utf-8-validate"],
    // Bundled CommonJS (ws) requires Node builtins; ESM output needs a require.
    banner: {
      js: [
        'import { createRequire as __smokeCreateRequire } from "node:module";',
        "const require = __smokeCreateRequire(import.meta.url);",
      ].join("\n"),
    },
    logLevel: "silent",
  });
  writeFileSync(join(bundle, "package.json"), '{"type":"module"}');
  const result = spawnSync(
    electron,
    [join(desktop, "scripts/smoke-mobile-asar-fixture.mjs"), bundle, JSON.stringify(config)],
    {
      cwd: bundle,
      env: {
        ...createBunTestEnvironment(process.env, join(temporary, "electron-environment")),
        ELECTRON_RUN_AS_NODE: "1",
      },
      encoding: "utf8",
      timeout: 60_000,
    },
  );
  assert.equal(result.error, undefined, result.error?.message);
  assert.equal(result.status, 0, result.stderr + result.stdout);
  const summary = JSON.parse(result.stdout.trim().split("\n").at(-1));
  if (config.packagedMobileFiles) summary.packagedMobileFiles = config.packagedMobileFiles;
  console.log(JSON.stringify(summary));
} finally {
  rmSync(temporary, { recursive: true, force: true });
}
