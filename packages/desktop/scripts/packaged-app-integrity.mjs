import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { isAbsolute, join, relative, sep } from "node:path";
import { describePackagedAppLayout } from "./packaged-app-layout.mjs";

export const sha256 = (value) => createHash("sha256").update(value).digest("hex");

/** No symlink traversal: include every directory mode, file byte/mode/size and
 * symlink target, including framework aliases, in a deterministic inventory. */
export async function inventoryAppTree(root, prefix = "") {
  const records = [];
  for (const name of (await readdir(join(root, prefix))).sort()) {
    const path = join(prefix, name);
    const info = await lstat(join(root, path));
    if (info.isSymbolicLink()) records.push([path, "link", await readlink(join(root, path))]);
    else if (info.isDirectory()) {
      records.push([path, "directory", info.mode & 0o777]);
      records.push(...(await inventoryAppTree(root, path)));
    } else if (info.isFile())
      records.push([
        path,
        "file",
        info.mode & 0o777,
        info.size,
        sha256(await readFile(join(root, path))),
      ]);
    else throw Error(`unsupported official app entry: ${path}`);
  }
  return records;
}

export async function capturePackagedAppIntegrity(
  appRoot,
  { platform = process.platform, arch = process.arch } = {},
) {
  assert.ok(["darwin", "win32", "linux"].includes(platform), "Unsupported packaged platform");
  assert.ok(
    platform === "darwin"
      ? ["arm64", "x64"].includes(arch) && arch === process.arch
      : arch === "x64",
    "Packaged integrity requires native macOS architecture, or Windows/Linux x64",
  );
  const root = await realpath(appRoot);
  const layout = describePackagedAppLayout(root, { platform });
  if (platform === "darwin")
    execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", root], {
      env: { PATH: "/usr/bin:/bin" },
      timeout: 30_000,
      stdio: "pipe",
    });
  const contained = async (path) => {
    const canonical = await realpath(path);
    const part = relative(root, canonical);
    assert.ok(
      part && part !== ".." && !part.startsWith(`..${sep}`) && !isAbsolute(part),
      "Packaged payload escaped its root",
    );
    return canonical;
  };
  const executable = await contained(layout.executable);
  const managedNode = await contained(layout.managedNode);
  const asar = await contained(join(layout.resources, "app.asar"));
  const manifestPath = await contained(join(layout.resources, "runtimes/node/manifest.json"));
  const manifestBytes = await readFile(manifestPath);
  const nodeManifest = JSON.parse(manifestBytes);
  assert.ok(
    nodeManifest.schemaVersion === 1 &&
      nodeManifest.id === "node" &&
      nodeManifest.platform === platform &&
      nodeManifest.arch === arch &&
      nodeManifest.executable === (platform === "win32" ? "bin/node.exe" : "bin/node"),
    "Packaged managed Node manifest target mismatch",
  );
  assert.equal(
    sha256(await readFile(managedNode)),
    nodeManifest.sha256,
    "Packaged managed Node checksum mismatch",
  );
  const records = await inventoryAppTree(root);
  return {
    inventoryVersion: 1,
    platform,
    arch,
    layout,
    appTreeSHA256: sha256(JSON.stringify(records)),
    entries: Object.fromEntries(
      ["directory", "file", "link"].map((type) => [
        type,
        records.filter((record) => record[1] === type).length,
      ]),
    ),
    codesignDeepStrict: platform === "darwin" ? true : null,
    nativeSignature: platform === "darwin" ? "codesign_deep_strict_verified" : "not_verified",
    asarSHA256: sha256(await readFile(asar)),
    executableSHA256: sha256(await readFile(executable)),
    managedNodeManifestSHA256: sha256(manifestBytes),
    managedNode: { ...nodeManifest, executable: managedNode },
  };
}
