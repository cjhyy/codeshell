import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const scriptPath = join(process.cwd(), "scripts", "copy-assets.mjs");

function withTempDir<T>(fn: (dir: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), "codeshell-copy-assets-"));
  try {
    return fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("copy-assets.mjs", () => {
  test("fails when a glob source matches zero files", () => {
    withTempDir((dir) => {
      const src = join(dir, "src");
      const dest = join(dir, "dist");
      mkdirSync(src);

      const result = spawnSync("node", [scriptPath, dest, join(src, "*.md")], {
        encoding: "utf-8",
      });

      expect(result.status).toBe(1);
      expect(result.stderr).toContain("matched no files");
    });
  });

  test("copies files matched by a glob source", () => {
    withTempDir((dir) => {
      const src = join(dir, "src");
      const dest = join(dir, "dist");
      mkdirSync(src);
      writeFileSync(join(src, "a.md"), "A");
      writeFileSync(join(src, "b.txt"), "B");

      const result = spawnSync("node", [scriptPath, dest, join(src, "*.md")], {
        encoding: "utf-8",
      });

      expect(result.status).toBe(0);
      expect(readFileSync(join(dest, "a.md"), "utf-8")).toBe("A");
    });
  });
});
