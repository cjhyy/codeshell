import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, readFileSync, existsSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { notebookEditTool } from "./notebook-edit.js";
import type { ToolContext } from "@cjhyy/code-shell-core";

let dir: string;
const ctx = () => ({ cwd: dir }) as unknown as ToolContext;
const nbPath = () => join(dir, "nb.ipynb");
const cells = () =>
  JSON.parse(readFileSync(nbPath(), "utf-8")).cells as Array<{
    cell_type: string;
    source: string[];
  }>;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "nbedit-"));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("coding notebookEditTool", () => {
  it("validates file_path and .ipynb extension", async () => {
    expect(await notebookEditTool({ action: "read" }, ctx())).toContain("file_path is required");
    expect(
      await notebookEditTool({ file_path: join(dir, "x.txt"), action: "read" }, ctx()),
    ).toContain("must be a .ipynb file");
  });

  it("insert creates the notebook when missing and adds a cell", async () => {
    const out = await notebookEditTool(
      { file_path: nbPath(), action: "insert", source: "print(1)", cell_type: "code" },
      ctx(),
    );
    expect(out).toContain("Inserted code cell");
    expect(existsSync(nbPath())).toBe(true);
    expect(cells()).toHaveLength(1);
    expect(cells()[0].source.join("")).toBe("print(1)");
  });

  it("replace swaps a cell's content", async () => {
    await notebookEditTool({ file_path: nbPath(), action: "insert", source: "a" }, ctx());
    const out = await notebookEditTool(
      { file_path: nbPath(), action: "replace", cell_index: 0, source: "b", cell_type: "markdown" },
      ctx(),
    );
    expect(out).toContain("Replaced cell 0");
    expect(cells()[0].cell_type).toBe("markdown");
    expect(cells()[0].source.join("")).toBe("b");
  });

  it("delete removes a cell and reports the new count", async () => {
    await notebookEditTool({ file_path: nbPath(), action: "insert", source: "a" }, ctx());
    await notebookEditTool({ file_path: nbPath(), action: "insert", source: "b" }, ctx());
    const out = await notebookEditTool(
      { file_path: nbPath(), action: "delete", cell_index: 0 },
      ctx(),
    );
    expect(out).toContain("now has 1 cells");
    expect(cells()).toHaveLength(1);
    expect(cells()[0].source.join("")).toBe("b");
  });

  it("rejects an out-of-range cell_index", async () => {
    await notebookEditTool({ file_path: nbPath(), action: "insert", source: "a" }, ctx());
    expect(
      await notebookEditTool({ file_path: nbPath(), action: "delete", cell_index: 9 }, ctx()),
    ).toContain("Invalid cell_index");
  });

  it("read lists cells", async () => {
    await notebookEditTool({ file_path: nbPath(), action: "insert", source: "print(1)" }, ctx());
    const out = await notebookEditTool({ file_path: nbPath(), action: "read" }, ctx());
    expect(out).toContain("1 cells");
    expect(out).toContain("[0] code: print(1)");
  });

  it("reports an unknown action", async () => {
    await notebookEditTool({ file_path: nbPath(), action: "insert", source: "a" }, ctx());
    expect(await notebookEditTool({ file_path: nbPath(), action: "frobnicate" }, ctx())).toContain(
      "Unknown action",
    );
  });
});
