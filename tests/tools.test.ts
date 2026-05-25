import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readTool } from "../packages/core/src/tool-system/builtin/read.js";
import { writeTool } from "../packages/core/src/tool-system/builtin/write.js";
import { editTool } from "../packages/core/src/tool-system/builtin/edit.js";
import { globTool } from "../packages/core/src/tool-system/builtin/glob.js";
import { grepTool } from "../packages/core/src/tool-system/builtin/grep.js";
import { webFetchTool } from "../packages/core/src/tool-system/builtin/web-fetch.js";
import { askUserTool } from "../packages/core/src/tool-system/builtin/ask-user.js";
import type { ToolContext } from "../packages/core/src/tool-system/context.js";
import { enterPlanModeTool, exitPlanModeTool } from "../packages/core/src/tool-system/builtin/plan.js";
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Read tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "read-test-"));
    writeFileSync(join(tmpDir, "test.txt"), "line1\nline2\nline3\nline4\nline5\n");
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("reads a file with line numbers", async () => {
    const result = await readTool({ file_path: join(tmpDir, "test.txt") });
    expect(result).toContain("1\tline1");
    expect(result).toContain("5\tline5");
  });

  it("supports offset and limit", async () => {
    const result = await readTool({ file_path: join(tmpDir, "test.txt"), offset: 2, limit: 2 });
    expect(result).toContain("2\tline2");
    expect(result).toContain("3\tline3");
    expect(result).not.toContain("1\tline1");
  });

  it("errors on missing file", async () => {
    const result = await readTool({ file_path: join(tmpDir, "nope.txt") });
    expect(result).toContain("Error");
  });

  it("shows total line count for partial reads", async () => {
    const result = await readTool({ file_path: join(tmpDir, "test.txt"), offset: 1, limit: 2 });
    expect(result).toContain("6 lines total");
  });
});

describe("Write tool", () => {
  let tmpDir: string;

  beforeEach(() => { tmpDir = mkdtempSync(join(tmpdir(), "write-test-")); });
  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("creates a new file", async () => {
    const path = join(tmpDir, "new.txt");
    const result = await writeTool({ file_path: path, content: "hello" });
    expect(result).toContain("Successfully");
    expect(readFileSync(path, "utf-8")).toBe("hello");
  });

  it("creates parent directories", async () => {
    const path = join(tmpDir, "sub", "dir", "file.txt");
    await writeTool({ file_path: path, content: "nested" });
    expect(readFileSync(path, "utf-8")).toBe("nested");
  });
});

describe("Edit tool", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "edit-test-"));
    writeFileSync(join(tmpDir, "test.ts"), "const foo = 1;\nconst bar = 2;\n");
  });

  afterEach(() => rmSync(tmpDir, { recursive: true, force: true }));

  it("replaces unique string", async () => {
    const path = join(tmpDir, "test.ts");
    const result = await editTool({ file_path: path, old_string: "foo = 1", new_string: "foo = 42" });
    expect(result).toContain("Successfully");
    expect(readFileSync(path, "utf-8")).toContain("foo = 42");
  });

  it("errors on non-unique string without replace_all", async () => {
    writeFileSync(join(tmpDir, "dup.ts"), "x = 1;\nx = 1;\n");
    const result = await editTool({
      file_path: join(tmpDir, "dup.ts"),
      old_string: "x = 1",
      new_string: "x = 2",
    });
    expect(result).toContain("not unique");
  });

  it("replaces all with replace_all", async () => {
    writeFileSync(join(tmpDir, "dup.ts"), "x = 1;\nx = 1;\n");
    const result = await editTool({
      file_path: join(tmpDir, "dup.ts"),
      old_string: "x = 1",
      new_string: "x = 2",
      replace_all: true,
    });
    expect(result).toContain("2 replacement");
    expect(readFileSync(join(tmpDir, "dup.ts"), "utf-8")).toBe("x = 2;\nx = 2;\n");
  });
});

describe("Glob tool", () => {
  it("finds files matching pattern", async () => {
    const result = await globTool({ pattern: "packages/core/src/**/*.ts" });
    expect(result).toContain(".ts");
    expect(result).not.toContain("node_modules");
  });

  it("shows file sizes", async () => {
    const result = await globTool({ pattern: "packages/core/src/types.ts" });
    expect(result).toMatch(/\(\d+[BK]/);
  });

  it("returns message for no matches", async () => {
    const result = await globTool({ pattern: "**/*.nonexistent_extension_xyz" });
    expect(result).toContain("No files");
  });
});

describe("Grep tool", () => {
  it("finds files with matches (default mode)", async () => {
    const result = await grepTool({ pattern: "export class", path: "packages/core/src/" });
    expect(result).toContain(".ts");
  });

  it("shows content with output_mode content", async () => {
    const result = await grepTool({
      pattern: "ToolRegistry",
      path: "packages/core/src/tool-system/registry.ts",
      output_mode: "content",
    });
    expect(result).toContain("ToolRegistry");
  });

  it("returns no matches message", async () => {
    const result = await grepTool({ pattern: "zzz_never_exists_xyz", path: "packages/core/src/" });
    expect(result).toContain("No matches");
  });
});

describe("AskUserQuestion tool", () => {
  it("returns error in headless mode (no ctx)", async () => {
    const result = await askUserTool({ question: "test?" });
    expect(result).toContain("not available");
  });

  it("returns error when ctx has no askUser", async () => {
    const ctx = { askUser: undefined } as unknown as ToolContext;
    const result = await askUserTool({ question: "test?" }, ctx);
    expect(result).toContain("not available");
  });

  it("uses askUser from ctx", async () => {
    const ctx = { askUser: async (_q: string) => "user answer" } as unknown as ToolContext;
    const result = await askUserTool({ question: "test?" }, ctx);
    expect(result).toBe("user answer");
  });
});

describe("Plan mode tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plan-test-"));
  });
  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enters plan mode (ctx.engine.planMode=false → returns entered message)", async () => {
    const engine = { planMode: false, setPlanMode(v: boolean) { this.planMode = v; } };
    const ctx = { planMode: false, engine } as unknown as ToolContext;
    const enterResult = await enterPlanModeTool({}, ctx);
    expect(enterResult).toContain("Entered plan mode");
    expect(engine.planMode).toBe(true);
  });

  it("returns informative message when already in plan mode", async () => {
    const engine = { planMode: true, setPlanMode(v: boolean) { this.planMode = v; } };
    const ctx = { planMode: true, engine } as unknown as ToolContext;
    const result = await enterPlanModeTool({}, ctx);
    expect(result).toContain("Already in plan mode");
  });

  it("exits plan mode (ctx.engine.planMode=true → returns exited message)", async () => {
    const engine = { planMode: true, setPlanMode(v: boolean) { this.planMode = v; } };
    const ctx = { planMode: true, engine } as unknown as ToolContext;
    const exitResult = await exitPlanModeTool({}, ctx);
    expect(exitResult).toContain("Exited plan mode");
    expect(engine.planMode).toBe(false);
  });

  it("returns informative message when exiting without entering", async () => {
    const engine = { planMode: false, setPlanMode(v: boolean) { this.planMode = v; } };
    const ctx = { planMode: false, engine } as unknown as ToolContext;
    const result = await exitPlanModeTool({}, ctx);
    expect(result).toContain("Not currently in plan mode");
  });
});
