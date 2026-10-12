import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { lstat, readFile, readdir, readlink, realpath } from "node:fs/promises";
import { join } from "node:path";

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

export async function capturePackagedAppIntegrity(officialApp) {
  officialApp = await realpath(officialApp);
  execFileSync("/usr/bin/codesign", ["--verify", "--deep", "--strict", officialApp], {
    env: { PATH: "/usr/bin:/bin" },
    timeout: 30_000,
    stdio: "pipe",
  });
  const resources = join(officialApp, "Contents/Resources");
  const executable = await realpath(join(officialApp, "Contents/MacOS/code-shell"));
  const managedNode = await realpath(join(resources, "runtimes/node/bin/node"));
  const nodeManifest = JSON.parse(
    await readFile(join(resources, "runtimes/node/manifest.json"), "utf8"),
  );
  assert.equal(sha256(await readFile(managedNode)), nodeManifest.sha256);
  const records = await inventoryAppTree(officialApp);
  return {
    inventoryVersion: 1,
    appTreeSHA256: sha256(JSON.stringify(records)),
    entries: Object.fromEntries(
      ["directory", "file", "link"].map((type) => [
        type,
        records.filter((record) => record[1] === type).length,
      ]),
    ),
    codesignDeepStrict: true,
    asarSHA256: sha256(await readFile(join(resources, "app.asar"))),
    executableSHA256: sha256(await readFile(executable)),
    managedNode: { ...nodeManifest, executable: managedNode },
  };
}
