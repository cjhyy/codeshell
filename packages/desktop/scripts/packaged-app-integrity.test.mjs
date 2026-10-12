import { test, expect } from "bun:test";
import { chmod, mkdir, mkdtemp, rm, symlink, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { inventoryAppTree, sha256 } from "./packaged-app-integrity.mjs";

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
