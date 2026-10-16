import { test, expect } from "bun:test";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  unlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  capturePackagedAppIntegrity,
  inventoryAppTree,
  sha256,
} from "./packaged-app-integrity.mjs";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";

async function packageFixture(platform, run) {
  const directory = await realpath(await mkdtemp(join(tmpdir(), "packaged-integrity-fixture-")));
  const root = join(directory, platform === "darwin" ? "code-shell.app" : `${platform}-unpacked`);
  const layout = describePackagedAppLayout(root, { platform });
  const manifestPath = join(layout.resources, "runtimes/node/manifest.json");
  const arch = platform === "darwin" ? process.arch : "x64";
  const manifest = {
    schemaVersion: 1,
    id: "node",
    version: "24.21.0",
    platform,
    arch,
    executable: platform === "win32" ? "bin/node.exe" : "bin/node",
    sha256: sha256("owned node bytes"),
  };
  for (const path of [layout.executable, layout.managedNode, join(layout.resources, "app.asar")])
    await mkdir(dirname(path), { recursive: true });
  // Independent of the path helper: mirror electron-builder's platform naming.
  const emittedExecutable =
    platform === "darwin"
      ? join(root, "Contents/MacOS/code-shell")
      : join(root, platform === "win32" ? "code-shell.exe" : "code-shell-desktop");
  await writeFile(emittedExecutable, "owned application bytes");
  await writeFile(layout.managedNode, "owned node bytes");
  await writeFile(join(layout.resources, "app.asar"), "owned ASAR bytes");
  await writeFile(manifestPath, JSON.stringify(manifest));
  try {
    await run({ directory, root, layout, manifest, manifestPath, platform, arch });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

test("full inventory detects equal-size rewrites, directory modes and framework alias changes", async () => {
  const root = await mkdtemp(join(tmpdir(), "packaged-app-integrity-"));
  try {
    await mkdir(join(root, "A"), { mode: 0o700 });
    await mkdir(join(root, "B"), { mode: 0o700 });
    await writeFile(join(root, "A/file"), "first", { mode: 0o600 });
    await symlink("A", join(root, "Current"));
    const digest = async () => sha256(JSON.stringify(await inventoryAppTree(root)));
    const before = await digest();
    expect(await digest()).toBe(before);
    await writeFile(join(root, "A/file"), "other");
    expect(await digest()).not.toBe(before);
    await writeFile(join(root, "A/file"), "first");
    expect(await digest()).toBe(before);
    await chmod(join(root, "B"), 0o755);
    expect(await digest()).not.toBe(before);
    await chmod(join(root, "B"), 0o700);
    await unlink(join(root, "Current"));
    await symlink("B", join(root, "Current"));
    expect(await digest()).not.toBe(before);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

for (const platform of ["linux", "win32"]) {
  test(`${platform} fixture captures complete payload hashes without claiming native signature`, () =>
    packageFixture(platform, async ({ root, layout, arch, manifestPath }) => {
      const capture = () => capturePackagedAppIntegrity(root, { platform, arch });
      const before = await capture();
      expect(before.platform).toBe(platform);
      expect(before.arch).toBe("x64");
      expect(before.layout).toEqual(layout);
      expect(before.codesignDeepStrict).toBeNull();
      expect(before.nativeSignature).toBe("not_verified");
      expect(before.asarSHA256).toBe(sha256("owned ASAR bytes"));
      expect(before.executableSHA256).toBe(sha256("owned application bytes"));
      expect(before.managedNode.sha256).toBe(sha256("owned node bytes"));
      expect(before.managedNodeManifestSHA256).toBe(sha256(await readFile(manifestPath)));
      expect(before.entries.file).toBe(4);
      await writeFile(join(layout.resources, "app.asar"), "other ASAR bytes");
      const after = await capture();
      expect(after.appTreeSHA256).not.toBe(before.appTreeSHA256);
      expect(after.asarSHA256).not.toBe(before.asarSHA256);
      expect(after.executableSHA256).toBe(before.executableSHA256);
    }));

  test(`${platform} fixture refuses a missing manifest, wrong target or changed Node bytes`, () =>
    packageFixture(platform, async ({ root, layout, arch, manifest, manifestPath }) => {
      const capture = () => capturePackagedAppIntegrity(root, { platform, arch });
      await unlink(manifestPath);
      await expect(capture()).rejects.toThrow("manifest.json");
      await writeFile(manifestPath, JSON.stringify({ ...manifest, platform: "darwin" }));
      await expect(capture()).rejects.toThrow("manifest target mismatch");
      await writeFile(manifestPath, JSON.stringify({ ...manifest, executable: "../../unowned" }));
      await expect(capture()).rejects.toThrow("manifest target mismatch");
      await writeFile(manifestPath, JSON.stringify(manifest));
      await writeFile(layout.managedNode, "changed Node bytes");
      await expect(capture()).rejects.toThrow("checksum mismatch");
    }));
}

test("macOS fixture cannot obtain a passing receipt without real deep strict codesign verification", () =>
  packageFixture("darwin", async ({ root, arch }) => {
    await expect(capturePackagedAppIntegrity(root, { platform: "darwin", arch })).rejects.toThrow();
    if (process.platform === "darwin")
      await expect(capturePackagedAppIntegrity(root)).rejects.toThrow();
  }));

test("unsupported architecture cannot be mislabeled as a supported native package", async () => {
  for (const platform of ["win32", "linux"])
    await expect(
      capturePackagedAppIntegrity("not-read", { platform, arch: "arm64" }),
    ).rejects.toThrow("Windows/Linux x64");
  const foreignMacArch = process.arch === "arm64" ? "x64" : "arm64";
  await expect(
    capturePackagedAppIntegrity("not-read", { platform: "darwin", arch: foreignMacArch }),
  ).rejects.toThrow("native macOS architecture");
});

test("a packaged payload symlink cannot move runtime custody outside the inventoried root", () =>
  packageFixture("linux", async ({ directory, root, layout, arch }) => {
    const outside = join(directory, "outside-node");
    await writeFile(outside, "owned node bytes");
    await unlink(layout.managedNode);
    await symlink(outside, layout.managedNode);
    await expect(capturePackagedAppIntegrity(root, { platform: "linux", arch })).rejects.toThrow(
      "escaped its root",
    );
  }));
