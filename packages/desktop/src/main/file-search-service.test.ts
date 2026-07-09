import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { searchFiles } from "./file-search-service.js";

describe("searchFiles", () => {
  let cwd: string;

  beforeEach(() => {
    cwd = mkdtempSync(join(tmpdir(), "file-search-"));
    mkdirSync(join(cwd, "src", "components"), { recursive: true });
    mkdirSync(join(cwd, "docs"), { recursive: true });
    mkdirSync(join(cwd, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(cwd, "src", "components", "Button.tsx"), "export {}\n");
    writeFileSync(join(cwd, "docs", "guide.md"), "# guide\n");
    writeFileSync(join(cwd, "node_modules", "pkg", "index.js"), "module.exports = {}\n");
  });

  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  test("returns file and directory hits with kind", async () => {
    const hits = await searchFiles(cwd, "src");
    expect(hits.some((hit) => hit.path === "src" && hit.kind === "dir")).toBe(true);
    expect(hits.some((hit) => hit.path === "src/components" && hit.kind === "dir")).toBe(true);
    expect(
      hits.some((hit) => hit.path === "src/components/Button.tsx" && hit.kind === "file"),
    ).toBe(true);
  });

  test("ignored directories do not appear", async () => {
    const hits = await searchFiles(cwd, "node");
    expect(hits.some((hit) => hit.path.startsWith("node_modules"))).toBe(false);
  });
});
