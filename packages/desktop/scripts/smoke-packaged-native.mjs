import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createBunTestEnvironment } from "../../../scripts/bun-test-completion.mjs";
import runtime from "./managed-node-runtime.cjs";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";

const [app, arch, ...extra] = process.argv.slice(2);
assert.ok(
  app && ["x64", "arm64"].includes(arch) && !extra.length,
  "Usage: node smoke-packaged-native.mjs <unpacked-app-directory> <x64|arm64>",
);
const layout = describePackagedAppLayout(realpathSync(resolve(app)));
const require = createRequire(import.meta.url);
const electronVersion = require("electron/package.json").version;
const target = { arch, platform: process.platform };
const manifest = await runtime.verifyRuntime(dirname(dirname(layout.managedNode)), target);
const probe = fileURLToPath(new URL("./__fixtures__/packaged-native-probe.mjs", import.meta.url));

function macVersion(version) {
  const [major, minor = 0, patch = 0] = version.split(".").map(Number);
  return major * 65536 + minor * 256 + patch;
}

const scratch = realpathSync(mkdtempSync(join(tmpdir(), "codeshell-packaged-native-")));
try {
  const environment = {
    ...createBunTestEnvironment(process.env, scratch),
    TMP: scratch,
    TEMP: scratch,
    TMPDIR: scratch,
    DISABLE_SYSTEM_FONTS_LOAD: "1",
  };
  const options = {
    cwd: environment.HOME,
    env: environment,
    timeout: 45_000,
    killSignal: "SIGKILL",
    windowsHide: true,
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  };
  function runProbe(role, executable, env) {
    const receipt = join(scratch, role + ".json");
    try {
      execFileSync(executable, [probe, role, layout.resources, arch, receipt], { ...options, env });
    } catch (cause) {
      const progress = existsSync(receipt + ".phase")
        ? readFileSync(receipt + ".phase", "utf8")
        : "before probe entry";
      throw new Error(`Packaged ${role} failed at ${progress}`, { cause });
    }
    return JSON.parse(readFileSync(receipt, "utf8"));
  }

  const canvas = runProbe("canvas", layout.managedNode, environment);
  assert.equal(canvas.node, manifest.version);
  const pty = runProbe("pty", layout.executable, { ...environment, ELECTRON_RUN_AS_NODE: "1" });
  assert.equal(pty.electron, electronVersion, "Packaged Electron version differs from the lock");
  assert.equal(pty.pdfNode, manifest.version);
  const evidence = { ...target, pty, canvas };

  if (process.platform === "darwin") {
    const minimum = require("../package.json").build.mac.minimumSystemVersion;
    assert.equal(
      execFileSync(
        "/usr/bin/plutil",
        ["-extract", "LSMinimumSystemVersion", "raw", join(layout.root, "Contents/Info.plist")],
        options,
      ).trim(),
      minimum,
    );
    const helper = join(layout.root, "Contents/Library/CodeShell Computer Use.app/Contents");
    const binaries = [
      layout.executable,
      join(layout.root, "Contents/Frameworks/Electron Framework.framework/Electron Framework"),
      layout.managedNode,
      pty.binary,
      join(dirname(pty.binary), "spawn-helper"),
      canvas.binary,
      join(helper, "MacOS/codeshell-computer-use"),
      join(helper, "Resources/cua-driver"),
    ];
    evidence.minimumSystemVersions = {};
    for (const binary of binaries) {
      const slice = arch === "x64" ? "x86_64" : "arm64";
      const loads = execFileSync("/usr/bin/otool", ["-arch", slice, "-l", binary], options);
      const version =
        loads.match(
          /cmd LC_BUILD_VERSION\s+cmdsize \d+\s+platform (?:1|MACOS)\s+minos ([\d.]+)/i,
        )?.[1] ?? loads.match(/cmd LC_VERSION_MIN_MACOSX\s+cmdsize \d+\s+version ([\d.]+)/)?.[1];
      assert.ok(version, `Missing macOS deployment target for ${slice}: ${binary}`);
      assert.ok(
        macVersion(version) <= macVersion(minimum),
        `${binary} requires macOS ${version} (expected <= ${minimum})`,
      );
      evidence.minimumSystemVersions[binary] = version;
    }
    evidence.execution = "Apple Silicon";
    if (arch === "x64") {
      // sysctl reports translation for the calling process, so run its Intel slice.
      const translated = execFileSync(
        "/usr/bin/arch",
        ["-x86_64", "/usr/sbin/sysctl", "-in", "sysctl.proc_translated"],
        options,
      ).trim();
      assert.ok(["", "0", "1"].includes(translated));
      evidence.execution = translated === "1" ? "Rosetta" : "Intel";
    }
  } else {
    for (const binary of [pty.binary, canvas.binary]) {
      assert.deepEqual(await runtime.executableArchitecture(binary), target);
    }
  }
  console.log(JSON.stringify(evidence, null, 2));
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
