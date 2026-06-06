import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { globTool } from "./glob.js";
import type { ToolContext } from "../context.js";

let dir: string;
const ctx = (over: Partial<ToolContext> = {}): ToolContext =>
  ({ cwd: dir, ...over }) as unknown as ToolContext;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "glob-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("globTool", () => {
  it("requires a pattern", async () => {
    expect(await globTool({}, ctx())).toContain("pattern is required");
  });

  it("matches files by pattern and lists them with sizes", async () => {
    writeFileSync(join(dir, "a.ts"), "x");
    writeFileSync(join(dir, "b.ts"), "yy");
    writeFileSync(join(dir, "c.js"), "zzz");
    const out = await globTool({ pattern: "*.ts" }, ctx());
    expect(out).toContain("a.ts");
    expect(out).toContain("b.ts");
    expect(out).not.toContain("c.js");
    expect(out).toContain("2 files matched");
    expect(out).toMatch(/\(\d+B\)/);
  });

  it("returns a clear message when nothing matches", async () => {
    writeFileSync(join(dir, "a.ts"), "x");
    expect(await globTool({ pattern: "*.py" }, ctx())).toBe("No files matched the pattern.");
  });

  it("sorts by modification time, newest first", async () => {
    writeFileSync(join(dir, "old.ts"), "x");
    writeFileSync(join(dir, "new.ts"), "x");
    // Make old.ts older than new.ts.
    const past = Date.now() / 1000 - 10_000;
    utimesSync(join(dir, "old.ts"), past, past);
    const out = await globTool({ pattern: "*.ts" }, ctx());
    expect(out.indexOf("new.ts")).toBeLessThan(out.indexOf("old.ts"));
  });

  it("recurses with ** and resolves a relative path arg against cwd", async () => {
    mkdirSync(join(dir, "src", "deep"), { recursive: true });
    writeFileSync(join(dir, "src", "deep", "x.ts"), "x");
    const out = await globTool({ pattern: "**/*.ts", path: "src" }, ctx());
    expect(out).toContain("deep/x.ts");
  });

  it("ignores node_modules", async () => {
    mkdirSync(join(dir, "node_modules", "pkg"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "pkg", "index.ts"), "x");
    writeFileSync(join(dir, "real.ts"), "x");
    const out = await globTool({ pattern: "**/*.ts" }, ctx());
    expect(out).toContain("real.ts");
    expect(out).not.toContain("node_modules");
  });
});
