import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readBoundedJson, writeOwnerJsonAtomic } from "./bounded-json-store.js";

const roots: string[] = [];

afterEach(async () => {
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codeshell-pet-json-"));
  roots.push(root);
  return root;
}

describe("bounded Pet JSON state", () => {
  test("rejects linked files for reads and writes without touching the target", async () => {
    const root = await fixture();
    const parent = join(root, "state");
    const file = join(parent, "data.json");
    const outside = join(root, "outside.json");
    await mkdir(parent);
    await writeFile(outside, JSON.stringify({ keep: true }));
    await symlink(outside, file);

    await expect(readBoundedJson(file, 1024)).rejects.toThrow(/regular file/);
    await expect(writeOwnerJsonAtomic(file, { changed: true }, 1024)).rejects.toThrow(
      /regular file/,
    );
    expect(JSON.parse(await readFile(outside, "utf8"))).toEqual({ keep: true });
  });

  test("rejects linked parents and oversized reads", async () => {
    const root = await fixture();
    const outside = join(root, "outside");
    const linked = join(root, "linked");
    await mkdir(outside);
    await symlink(outside, linked);
    await expect(writeOwnerJsonAtomic(join(linked, "data.json"), {}, 1024)).rejects.toThrow(
      /real directory/,
    );

    const oversized = join(root, "oversized.json");
    await writeFile(oversized, "x".repeat(1_025));
    await expect(readBoundedJson(oversized, 1_024)).rejects.toThrow(/bounded/);
  });
});
