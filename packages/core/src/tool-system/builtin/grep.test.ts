import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { grepTool, _setGrepExecFileForTest } from "./grep.js";
import type { ToolContext } from "../context.js";

let dir: string;
const ctx = () => ({ cwd: dir }) as unknown as ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "grep-"));
  writeFileSync(join(dir, "a.ts"), "const needle = 1;\nother line\n");
  writeFileSync(join(dir, "b.ts"), "no match here\n");
  writeFileSync(join(dir, "c.md"), "needle in markdown\n");
});
afterEach(() => {
  _setGrepExecFileForTest();
  rmSync(dir, { recursive: true, force: true });
});

describe("grepTool", () => {
  it("requires a pattern", async () => {
    expect(await grepTool({}, ctx())).toContain("pattern is required");
  });

  it("finds files containing the pattern (files_with_matches default)", async () => {
    const out = await grepTool({ pattern: "needle" }, ctx());
    // Whichever backend (rg/grep) ran, both matching files should appear.
    expect(out).toContain("a.ts");
    expect(out).toContain("c.md");
    expect(out).not.toContain("b.ts");
  });

  it("reports no matches clearly", async () => {
    const out = await grepTool({ pattern: "zzz-not-present-xyz" }, ctx());
    expect(out).toBe("No matches found.");
  });

  it("content mode shows the matching line", async () => {
    const out = await grepTool({ pattern: "needle", output_mode: "content" }, ctx());
    expect(out).toContain("const needle = 1;");
  });

  it("respects a file glob filter", async () => {
    const out = await grepTool({ pattern: "needle", glob: "*.md" }, ctx());
    expect(out).toContain("c.md");
    expect(out).not.toContain("a.ts");
  });

  it("ignores node_modules", async () => {
    mkdirSync(join(dir, "node_modules"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "x.ts"), "needle here\n");
    const out = await grepTool({ pattern: "needle" }, ctx());
    expect(out).not.toContain("node_modules");
  });

  it("falls back to a built-in recursive search when rg and grep are unavailable", async () => {
    _setGrepExecFileForTest(async () => {
      const err = new Error("spawn ENOENT") as NodeJS.ErrnoException;
      err.code = "ENOENT";
      throw err;
    });

    const out = await grepTool({ pattern: "needle", glob: "*.ts", output_mode: "content" }, ctx());
    expect(out).toContain("a.ts:1:const needle = 1;");
    expect(out).not.toContain("c.md");
  });
});
