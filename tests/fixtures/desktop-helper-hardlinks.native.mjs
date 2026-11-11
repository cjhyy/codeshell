// Host diagnostic with /bin/echo Mach-O stand-ins, not real release artifacts.
// Does not build or install CodeShell. Run with:
// node scripts/run-isolated-node-smoke.mjs tests/fixtures/desktop-helper-hardlinks.native.mjs
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import {
  copyFile,
  link,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";

const require = createRequire(import.meta.url);
const { createSigningHooks } = require("../../packages/desktop/scripts/managed-node-signing.cjs");
const exec = promisify(execFile);
const helperRelative = "Contents/Library/CodeShell Computer Use.app";
const mainRelative = "Contents/MacOS/codeshell-computer-use";
const resourceRelative = "Contents/Resources/fixture.txt";
const digest = async (path) =>
  createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
const run = async (command, args) => {
  console.log(JSON.stringify({ command, args }));
  return exec(command, args, { timeout: 30_000 });
};

async function bundle(path, identifier, executable) {
  await mkdir(join(path, "Contents/MacOS"), { recursive: true });
  await mkdir(join(path, "Contents/Resources"), { recursive: true });
  await copyFile("/bin/echo", join(path, "Contents/MacOS", executable));
  await writeFile(
    join(path, "Contents/Info.plist"),
    `<?xml version="1.0"?>
<plist version="1.0"><dict>
<key>CFBundleIdentifier</key><string>${identifier}</string>
<key>CFBundleExecutable</key><string>${executable}</string>
<key>CFBundlePackageType</key><string>APPL</string>
<key>CFBundleVersion</key><string>1</string>
</dict></plist>`,
  );
}

async function hardlinkTree(source, destination) {
  await mkdir(destination, { recursive: true });
  for (const entry of await readdir(source, { withFileTypes: true })) {
    const from = join(source, entry.name);
    const to = join(destination, entry.name);
    if (entry.isDirectory()) await hardlinkTree(from, to);
    else await link(from, to);
  }
}

async function scenario(root, isolate, differentResources) {
  const source = join(root, "source.app");
  await bundle(source, "com.cjhyy.codeshell.computer-use", "codeshell-computer-use");
  await copyFile("/bin/echo", join(source, "Contents/Resources/cua-driver"));
  await writeFile(join(source, resourceRelative), "sealed shared resource\n");
  await run("codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    join(source, "Contents/Resources/cua-driver"),
  ]);
  await run("codesign", [
    "--force",
    "--sign",
    "-",
    "--options",
    "runtime",
    '-r=designated => identifier "com.cjhyy.codeshell.computer-use"',
    source,
  ]);
  await run("codesign", ["--verify", "--deep", "--strict", source]);

  const targets = [];
  for (const arch of ["arm64", "x64"]) {
    const appOutDir = join(root, arch);
    const app = join(appOutDir, "code-shell.app");
    await bundle(app, "com.cjhyy.codeshell", "code-shell");
    const helper = join(app, helperRelative);
    await hardlinkTree(source, helper);
    // A controlled per-target difference makes the two otherwise valid resource
    // seals differ. This proves the shared-inode mechanism, not runner provenance.
    if (differentResources)
      await writeFile(join(helper, "Contents/Resources/target.txt"), `${arch}\n`);
    const runtimeDir = join(app, "Contents/Resources/runtimes/node");
    const node = join(runtimeDir, "bin/node");
    let nodeDigest;
    const hooks = createSigningHooks({
      env: {},
      run,
      ...(isolate ? {} : { isolateHelperBundle: async () => {} }),
      supply: {
        packagingTarget: () => ({ platform: "darwin", arch }),
        packagedRuntimeDirectory: () => runtimeDir,
        stageRuntime: async () => {
          await mkdir(dirname(node), { recursive: true });
          await copyFile("/bin/echo", node);
          nodeDigest = await digest(node);
        },
        refreshManifest: async () => {
          nodeDigest = await digest(node);
        },
        verifyRuntime: async () => {
          assert.equal(await digest(node), nodeDigest);
        },
      },
    });
    targets.push({
      app,
      helper,
      hooks,
      context: {
        appOutDir,
        electronPlatformName: "darwin",
        arch,
        packager: { appInfo: { productFilename: "code-shell" } },
      },
    });
  }
  const inodes = async () =>
    Promise.all(
      [source, ...targets.map(({ helper }) => helper)].map(async (helper) => ({
        helper,
        main: (await stat(join(helper, mainRelative))).ino,
        resource: (await stat(join(helper, resourceRelative))).ino,
        seal: (await stat(join(helper, "Contents/_CodeSignature/CodeResources"))).ino,
      })),
    );
  const before = await inodes();
  assert.equal(before[0].main, before[1].main);
  assert.equal(before[1].main, before[2].main);
  assert.equal(before[0].resource, before[2].resource);
  console.log(JSON.stringify({ isolate, differentResources, before }));
  await targets[0].hooks.afterPack(targets[0].context);
  const signedFirst = await digest(join(targets[0].helper, mainRelative));
  const signedFirstSeal = await digest(
    join(targets[0].helper, "Contents/_CodeSignature/CodeResources"),
  );
  await targets[1].hooks.afterPack(targets[1].context);
  const after = await inodes();
  let firstError;
  try {
    await run("codesign", ["--verify", "--strict", join(targets[0].helper, mainRelative)]);
    await run("codesign", ["--verify", "--deep", "--strict", targets[0].app]);
  } catch (error) {
    firstError = error;
  }
  const firstSealChanged =
    signedFirstSeal !==
    (await digest(join(targets[0].helper, "Contents/_CodeSignature/CodeResources")));
  console.log(
    JSON.stringify({
      isolate,
      differentResources,
      after,
      firstMainChanged: signedFirst !== (await digest(join(targets[0].helper, mainRelative))),
      firstSealChanged,
      firstVerification: firstError?.message ?? "passed",
    }),
  );
  if (isolate) {
    assert.ifError(firstError);
    assert.equal(signedFirst, await digest(join(targets[0].helper, mainRelative)));
    assert.equal(new Set(after.map(({ main }) => main)).size, 3);
    assert.equal(new Set(after.map(({ resource }) => resource)).size, 3);
    assert.equal(new Set(after.map(({ seal }) => seal)).size, 3);
    assert.equal(firstSealChanged, false);
    await run("codesign", ["--verify", "--deep", "--strict", source]);
  } else if (differentResources) {
    assert.ok(
      firstError,
      "Native hardlink signature corruption was not reproduced; hypothesis remains unconfirmed",
    );
    assert.match(firstError.stderr, /invalid resource directory/);
    assert.equal(firstSealChanged, true);
  } else assert.ifError(firstError);
}

assert.equal(process.platform, "darwin", "Run this native diagnostic on macOS");
const directory = await mkdtemp(join(tmpdir(), "codeshell-helper-codesign-"));
try {
  await scenario(join(directory, "identical-control"), false, false);
  await scenario(join(directory, "legacy"), false, true);
  await scenario(join(directory, "isolated"), true, true);
  console.log(
    "PASS: native shared-inode failure reproduced and isolated signing preserved both targets",
  );
} finally {
  await rm(directory, { recursive: true, force: true });
}
