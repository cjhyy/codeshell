import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, sep } from "node:path";
import { canonicalKey, canonicalPath } from "./canonical-key.js";

const fixtures: string[] = [];

afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "codeshell-canonical-key-"));
  fixtures.push(root);
  return root;
}

describe("canonicalKey", () => {
  test("realpaths aliases and removes trailing separators", async () => {
    const root = await fixture();
    const target = join(root, "target");
    await mkdir(target);
    const alias = join(root, "alias");
    if (process.platform !== "win32") await symlink(target, alias, "dir");

    const spelling = process.platform === "win32" ? target : alias;
    expect(canonicalKey(`${spelling}${sep}`)).toBe(canonicalKey(target));
    expect(canonicalPath(spelling)).toBe(canonicalPath(target));
  });

  test("realpaths the nearest existing ancestor for missing paths", async () => {
    const root = await fixture();
    const target = join(root, "target");
    await mkdir(target);
    const alias = join(root, "alias");
    if (process.platform !== "win32") await symlink(target, alias, "dir");

    const spelling = process.platform === "win32" ? target : alias;
    expect(canonicalKey(join(spelling, "missing", "file.ts"))).toBe(
      canonicalKey(join(target, "missing", "file.ts")),
    );
  });

  test("folds case only on case-insensitive supported platforms", async () => {
    const root = await fixture();
    const upper = root.toUpperCase();
    if (process.platform === "darwin" || process.platform === "win32") {
      expect(canonicalKey(upper)).toBe(canonicalKey(root));
    } else {
      expect(canonicalKey(upper)).not.toBe(canonicalKey(root));
    }
  });

  test("normalizes macOS /var and /private/var aliases", () => {
    if (process.platform !== "darwin") return;
    expect(canonicalKey("/var")).toBe(canonicalKey("/private/var"));
  });
});
