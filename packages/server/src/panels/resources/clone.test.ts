import { afterEach, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { stageResourceClone } from "./clone.js";

const cleanup: string[] = [];
afterEach(async () => {
  for (const path of cleanup.splice(0)) await rm(path, { recursive: true, force: true });
});

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "resource-clone-"));
  cleanup.push(root);
  const sourcePath = join(root, "source");
  const stagingDirectory = join(root, "staging");
  await mkdir(stagingDirectory, { mode: 0o700 });
  await writeFile(sourcePath, Buffer.alloc(1024 * 1024, 31));
  return {
    sourcePath,
    stagingDirectory,
    targetDevice: (await stat(sourcePath)).dev,
    verify: async () => {},
  };
}

test("cross-volume materialization falls back without creating a clone", async () => {
  const f = await fixture();
  expect(await stageResourceClone({ ...f, targetDevice: -1 })).toBeUndefined();
  expect(await readdir(f.stagingDirectory)).toEqual([]);
});

test.skipIf(process.platform !== "darwin")(
  "native macOS clone creates an independent private inode and cleans its lease",
  async () => {
    const f = await fixture();
    const clone = await stageResourceClone(f);
    expect(clone).toBeDefined();
    try {
      const copied = await clone!.handle.stat();
      expect(copied.ino).not.toBe((await stat(f.sourcePath)).ino);
      expect(copied.mode & 0o777).toBe(0o600);
      await clone!.handle.write(Buffer.from("changed"), 0, 7, 0);
      expect((await readFile(f.sourcePath)).subarray(0, 7)).toEqual(Buffer.alloc(7, 31));
    } finally {
      await clone!.close();
    }
    expect(await readdir(f.stagingDirectory)).toEqual([]);
  },
);

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "revocation during native staging fails closed and cleans private files",
  async () => {
    const f = await fixture();
    await expect(
      stageResourceClone({
        ...f,
        verify: async () => {
          if ((await readdir(f.stagingDirectory)).length) throw new Error("revoked");
        },
      }),
    ).rejects.toThrow("revoked");
    expect(await readdir(f.stagingDirectory)).toEqual([]);
  },
);

test("cancelled clone staging never creates a file", async () => {
  const f = await fixture();
  const signal = AbortSignal.abort();
  await expect(stageResourceClone({ ...f, signal })).rejects.toThrow();
  expect(await readdir(f.stagingDirectory)).toEqual([]);
});

test.skipIf(!["darwin", "linux"].includes(process.platform))(
  "clone staging rejects a symlink without creating files in its target",
  async () => {
    const f = await fixture();
    const alias = `${f.stagingDirectory}-alias`;
    await symlink(f.stagingDirectory, alias);
    await expect(stageResourceClone({ ...f, stagingDirectory: alias })).rejects.toThrow("staging");
    expect(await readdir(f.stagingDirectory)).toEqual([]);
  },
);
