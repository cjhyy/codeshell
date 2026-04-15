import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { readTool } from "../src/tool-system/builtin/read.js";
import { writeTool } from "../src/tool-system/builtin/write.js";
import { editTool } from "../src/tool-system/builtin/edit.js";
import { globTool } from "../src/tool-system/builtin/glob.js";
import { grepTool } from "../src/tool-system/builtin/grep.js";
import { webFetchTool } from "../src/tool-system/builtin/web-fetch.js";
import { askUserTool, setAskUserFn } from "../src/tool-system/builtin/ask-user.js";
import { enterPlanModeTool, exitPlanModeTool, resetPlanMode } from "../src/tool-system/builtin/plan.js";
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
    const result = await globTool({ pattern: "src/**/*.ts" });
    expect(result).toContain(".ts");
    expect(result).not.toContain("node_modules");
  });

  it("shows file sizes", async () => {
    const result = await globTool({ pattern: "src/types.ts" });
    expect(result).toMatch(/\(\d+[BK]/);
  });

  it("returns message for no matches", async () => {
    const result = await globTool({ pattern: "**/*.nonexistent_extension_xyz" });
    expect(result).toContain("No files");
  });
});

describe("Grep tool", () => {
  it("finds files with matches (default mode)", async () => {
    const result = await grepTool({ pattern: "export class", path: "src/" });
    expect(result).toContain(".ts");
  });

  it("shows content with output_mode content", async () => {
    const result = await grepTool({
      pattern: "ToolRegistry",
      path: "src/tool-system/registry.ts",
      output_mode: "content",
    });
    expect(result).toContain("ToolRegistry");
  });

  it("returns no matches message", async () => {
    const result = await grepTool({ pattern: "zzz_never_exists_xyz", path: "src/" });
    expect(result).toContain("No matches");
  });
});

describe("AskUserQuestion tool", () => {
  afterEach(() => setAskUserFn(undefined));

  it("returns error in headless mode", async () => {
    setAskUserFn(undefined);
    const result = await askUserTool({ question: "test?" });
    expect(result).toContain("not available");
  });

  it("uses injected function", async () => {
    setAskUserFn(async (q) => "user answer");
    const result = await askUserTool({ question: "test?" });
    expect(result).toBe("user answer");
  });
});

describe("Plan mode tools", () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "plan-test-"));
    resetPlanMode();
  });
  afterEach(() => {
    resetPlanMode();
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("enters and exits plan mode", async () => {
    const planFile = join(tmpDir, "plan.md");
    const enterResult = await enterPlanModeTool({ plan_file: planFile });
    expect(enterResult).toContain("Entered plan mode");

    writeFileSync(planFile, "# My Plan\n\n1. Do thing\n2. Do other thing\n");

    const exitResult = await exitPlanModeTool({});
    expect(exitResult).toContain("Exited plan mode");
    expect(exitResult).toContain("My Plan");
  });

  it("warns on empty plan exit", async () => {
    const planFile = join(tmpDir, "plan.md");
    await enterPlanModeTool({ plan_file: planFile });
    const result = await exitPlanModeTool({});
    expect(result).toContain("empty");
  });
});
