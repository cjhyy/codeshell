import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import type { ToolContext } from "../context.js";
import { readTool } from "./read.js";
import { writeTool } from "./write.js";
import { editTool } from "./edit.js";
import { notebookEditTool } from "./notebook-edit.js";

describe("file tools resolve relative paths against ctx.cwd", () => {
  let workspace: string;
  let processRoot: string;
  let previousCwd: string;
  let ctx: ToolContext;

  beforeEach(() => {
    previousCwd = process.cwd();
    workspace = mkdtempSync(join(tmpdir(), "cs-filetools-ws-"));
    processRoot = mkdtempSync(join(tmpdir(), "cs-filetools-proc-"));
    process.chdir(processRoot);
    ctx = { cwd: workspace } as unknown as ToolContext;
  });

  afterEach(() => {
    process.chdir(previousCwd);
    rmSync(workspace, { recursive: true, force: true });
    rmSync(processRoot, { recursive: true, force: true });
  });

  test("Read reads the ctx.cwd-relative file", async () => {
    writeFileSync(join(workspace, "same.txt"), "workspace");
    writeFileSync(join(processRoot, "same.txt"), "process");

    const out = await readTool({ file_path: "same.txt" }, ctx);

    expect(out).toContain("workspace");
    expect(out).not.toContain("process");
  });

  test("Write writes under ctx.cwd, not process.cwd", async () => {
    const out = await writeTool({ file_path: "new.txt", content: "created" }, ctx);

    expect(out).toContain(join(workspace, "new.txt"));
    expect(readFileSync(join(workspace, "new.txt"), "utf-8")).toBe("created");
    expect(existsSync(join(processRoot, "new.txt"))).toBe(false);
  });

  test("Edit edits the ctx.cwd-relative file", async () => {
    writeFileSync(join(workspace, "edit.txt"), "hello workspace");
    writeFileSync(join(processRoot, "edit.txt"), "hello process");

    await editTool({ file_path: "edit.txt", old_string: "workspace", new_string: "there" }, ctx);

    expect(readFileSync(join(workspace, "edit.txt"), "utf-8")).toBe("hello there");
    expect(readFileSync(join(processRoot, "edit.txt"), "utf-8")).toBe("hello process");
  });

  test("NotebookEdit writes under ctx.cwd", async () => {
    const out = await notebookEditTool(
      { file_path: "notes.ipynb", action: "insert", source: "print(1)" },
      ctx,
    );

    expect(out).toMatch(/Inserted/);
    expect(existsSync(join(workspace, "notes.ipynb"))).toBe(true);
    expect(existsSync(join(processRoot, "notes.ipynb"))).toBe(false);
  });
});
