import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync, rmSync, symlinkSync } from "node:fs";
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

  it("rejects an absolute pattern instead of returning files outside the workspace", async () => {
    const out = await globTool({ pattern: "/etc/hosts" }, ctx());
    expect(out).toContain("Error");
    expect(out).not.toContain("/etc/hosts  (");
  });

  it("rejects a pattern that escapes above the workspace", async () => {
    const workspace = join(dir, "nested", "workspace");
    mkdirSync(workspace, { recursive: true });
    writeFileSync(join(dir, "outside-workspace.ts"), "secret");

    const out = await globTool({ pattern: "../../**" }, ctx({ cwd: workspace }));
    expect(out).toContain("Error");
    expect(out).not.toContain("outside-workspace.ts");
  });

  it("does not return files reached through a symlink outside the search root", async () => {
    const outside = mkdtempSync(join(tmpdir(), "glob-outside-"));
    try {
      writeFileSync(join(outside, "outside-workspace.ts"), "secret");
      symlinkSync(outside, join(dir, "linked"), "dir");

      const out = await globTool({ pattern: "linked/**" }, ctx());
      expect(out).not.toContain("outside-workspace.ts");
    } finally {
      rmSync(outside, { recursive: true, force: true });
    }
  });

  it("keeps workspace-relative recursive patterns working", async () => {
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(dir, "src", "root.ts"), "x");
    writeFileSync(join(dir, "packages", "core", "src", "index.ts"), "x");

    const recursive = await globTool({ pattern: "**/*.ts" }, ctx());
    expect(recursive).toContain("src/root.ts");
    expect(recursive).toContain("packages/core/src/index.ts");

    const packageSources = await globTool({ pattern: "packages/*/src/**" }, ctx());
    expect(packageSources).toContain("packages/core/src/index.ts");
    expect(packageSources).not.toContain("src/root.ts");
  });

  it("keeps a workspace subdirectory path working with a relative pattern", async () => {
    mkdirSync(join(dir, "packages", "core", "src"), { recursive: true });
    writeFileSync(join(dir, "packages", "core", "src", "index.ts"), "x");

    const out = await globTool({ path: join(dir, "packages", "core"), pattern: "**/*.ts" }, ctx());
    expect(out).toContain("src/index.ts");
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
