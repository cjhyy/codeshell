import { describe, expect, test } from "bun:test";
import { toolFileBlocks } from "./toolFileBlocks.js";

describe("toolFileBlocks", () => {
  test("Edit shows - old / + new and keeps the rest as raw arguments", () => {
    const { blocks, rest } = toolFileBlocks("Edit", {
      file_path: "/a.ts",
      old_string: "let x = 1;",
      new_string: "const x = 1;",
    });
    expect(blocks).toEqual([
      { label: "- old", text: "let x = 1;", tone: "removed" },
      { label: "+ new", text: "const x = 1;", tone: "added" },
    ]);
    expect(rest).toEqual({ file_path: "/a.ts" });
  });

  test("Write shows its content as a block", () => {
    const { blocks, rest } = toolFileBlocks("Write", { file_path: "/b.md", content: "# hi\n" });
    expect(blocks).toEqual([{ label: "content", text: "# hi\n" }]);
    expect(rest).toEqual({ file_path: "/b.md" });
  });

  test("MultiEdit numbers each pair", () => {
    const { blocks, rest } = toolFileBlocks("MultiEdit", {
      file_path: "/c.ts",
      edits: [
        { old_string: "a", new_string: "b" },
        { old_string: "c", new_string: "d" },
      ],
    });
    expect(blocks.map((block) => block.label)).toEqual([
      "- old #1",
      "+ new #1",
      "- old #2",
      "+ new #2",
    ]);
    expect(rest).toEqual({ file_path: "/c.ts" });
  });

  test("other tools and malformed arguments keep the raw JSON view", () => {
    expect(toolFileBlocks("Bash", { command: "ls" })).toEqual({
      blocks: [],
      rest: { command: "ls" },
    });
    expect(toolFileBlocks("Edit", { file_path: "/a", old_string: 3 })).toEqual({
      blocks: [],
      rest: { file_path: "/a", old_string: 3 },
    });
    expect(toolFileBlocks("MultiEdit", { edits: [null] })).toEqual({
      blocks: [],
      rest: { edits: [null] },
    });
    expect(toolFileBlocks("Write", undefined)).toEqual({ blocks: [], rest: {} });
  });
});
