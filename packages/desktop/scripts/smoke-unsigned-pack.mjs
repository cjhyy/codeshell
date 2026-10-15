import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { fileURLToPath, pathToFileURL } from "node:url";

// Validation only: normal release packaging retains its own hooks and signing.
// Resolve from this checked-out script, never from the caller's implicit cwd.
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const phase = process.argv[2];
const desktopRoot = join(repoRoot, "packages/desktop");
const { createBunTestEnvironment } = await import(
  pathToFileURL(join(repoRoot, "scripts/bun-test-completion.mjs"))
);
const scratch = mkdtempSync(join(tmpdir(), "codeshell-review-pack-"));
const env = {
  ...createBunTestEnvironment(process.env, scratch),
  CSC_IDENTITY_AUTO_DISCOVERY: "false",
  ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
  ELECTRON_BUILDER_CACHE: join(scratch, "electron-builder-cache"),
  SWIFT_MODULECACHE_PATH: join(scratch, "swift-module-cache"),
  CLANG_MODULE_CACHE_PATH: join(scratch, "clang-module-cache"),
};
function run(command, args, cwd = repoRoot) {
  console.log(JSON.stringify({ command, args, cwd, isolatedHome: env.HOME }));
  const result = spawnSync(command, args, { cwd, env, stdio: "inherit", timeout: 600_000 });
  if (result.error) throw result.error;
  if (result.status !== 0 || result.signal) {
    throw new Error(`Command failed: ${result.signal ?? result.status}`);
  }
}
if (phase === "predist") {
  run("bun", ["run", "packages/desktop/scripts/predist.ts"]);
} else if (phase === "bundle") {
  const metadataPath = join(scratch, "desktop-main-metafile.json");
  run("bun", ["run", "build:main", `--metafile=${metadataPath}`], desktopRoot);
  const metadata = JSON.parse(readFileSync(metadataPath, "utf8"));
  const hostInputs = Object.keys(metadata.inputs).filter((name) =>
    /(?:^|\/)host\/dist\//.test(name),
  );
  if (!hostInputs.length) throw new Error("Production build:main did not bundle any Host module");
  for (const output of Object.values(metadata.outputs)) {
    if (
      output.imports.some(
        ({ path, external }) => external && path.startsWith("@cjhyy/code-shell-host"),
      )
    ) {
      throw new Error("Production build:main left a Host runtime package import");
    }
  }
  console.log(JSON.stringify({ hostInputs, metadataPath, hostIsBundled: true }));
} else if (phase === "pack") {
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const config = {
    ...pkg.build,
    afterPack: null,
    afterSign: null,
    publish: null,
    forceCodeSigning: false,
    npmRebuild: false,
    nodeGypRebuild: false,
    electronDist: join(desktopRoot, "node_modules/electron/dist"),
    directories: { ...pkg.build.directories, output: "dist/cc-review-unsigned" },
    mac: { ...pkg.build.mac, identity: null, sign: null, notarize: false },
  };
  const configPath = join(scratch, "unsigned-electron-builder.json");
  writeFileSync(configPath, JSON.stringify(config, null, 2));
  const localRequire = createRequire(join(desktopRoot, "package.json"));
  const cli = join(localRequire.resolve("electron-builder/package.json"), "..", "cli.js");
  console.log(
    JSON.stringify({ configPath, signing: false, notarization: false, publishing: false }),
  );
  run(
    process.execPath,
    [cli, "--dir", "--mac", `--${process.arch}`, "--publish", "never", "--config", configPath],
    desktopRoot,
  );
} else {
  throw new Error("phase must be predist, bundle, or pack");
}
