import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { editTool } from "./edit.js";
import { writeTool } from "./write.js";
import type { ToolContext } from "../context.js";

let dir: string;
let n = 0;
const ctx = () => ({ cwd: dir }) as unknown as ToolContext;
const fresh = (content: string): string => {
  const p = join(dir, `f${n++}.txt`);
  writeFileSync(p, content);
  return p;
};

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "editwrite-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("writeTool", () => {
  it("requires file_path and content", async () => {
    expect(await writeTool({ content: "x" }, ctx())).toContain("file_path is required");
    expect(await writeTool({ file_path: join(dir, "a.txt") }, ctx())).toContain(
      "content is required",
    );
  });

  it("writes content and creates parent dirs", async () => {
    const p = join(dir, "nested", "deep", "a.txt");
    const out = await writeTool({ file_path: p, content: "hello" }, ctx());
    expect(out).toContain("Successfully wrote");
    expect(existsSync(p)).toBe(true);
    expect(readFileSync(p, "utf-8")).toBe("hello");
  });

  it("overwrites an existing file", async () => {
    const p = fresh("old");
    await writeTool({ file_path: p, content: "new" }, ctx());
    expect(readFileSync(p, "utf-8")).toBe("new");
  });
});

describe("editTool", () => {
  it("validates required args + difference", async () => {
    const p = fresh("abc");
    expect(await editTool({ old_string: "a", new_string: "b" }, ctx())).toContain(
      "file_path is required",
    );
    expect(await editTool({ file_path: p, new_string: "b" }, ctx())).toContain(
      "old_string is required",
    );
    expect(await editTool({ file_path: p, old_string: "a" }, ctx())).toContain(
      "new_string is required",
    );
    expect(
      await editTool({ file_path: p, old_string: "a", new_string: "a" }, ctx()),
    ).toContain("must be different");
  });

  it("errors when the file is missing", async () => {
    const out = await editTool(
      { file_path: join(dir, "nope.txt"), old_string: "a", new_string: "b" },
      ctx(),
    );
    expect(out).toContain("File not found");
  });

  it("errors when old_string is absent in the file", async () => {
    const p = fresh("hello world");
    const out = await editTool({ file_path: p, old_string: "xyz", new_string: "q" }, ctx());
    expect(out).toContain("old_string not found");
  });

  it("does a single unique replacement", async () => {
    const p = fresh("foo bar baz");
    const out = await editTool({ file_path: p, old_string: "bar", new_string: "QUX" }, ctx());
    expect(out).toContain("1 replacement");
    expect(readFileSync(p, "utf-8")).toBe("foo QUX baz");
  });

  it("refuses an ambiguous (non-unique) old_string without replace_all", async () => {
    const p = fresh("x x x");
    const out = await editTool({ file_path: p, old_string: "x", new_string: "y" }, ctx());
    expect(out).toContain("not unique");
    // file unchanged
    expect(readFileSync(p, "utf-8")).toBe("x x x");
  });

  it("replaces all occurrences with replace_all", async () => {
    const p = fresh("x x x");
    const out = await editTool(
      { file_path: p, old_string: "x", new_string: "y", replace_all: true },
      ctx(),
    );
    expect(out).toContain("3 replacements");
    expect(readFileSync(p, "utf-8")).toBe("y y y");
  });
});
