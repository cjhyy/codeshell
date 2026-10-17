import { describe, expect, test } from "bun:test";
import React from "react";
import {
  DiffLine,
  classifyDiffLine,
} from "../../../../packages/tui/src/ui/components/DiffLine.js";
import { stringWidth } from "../../../../packages/tui/src/render/stringWidth.js";

function textChildren(node: React.ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(textChildren).join("");
  if (React.isValidElement<{ children?: React.ReactNode }>(node)) {
    return textChildren(node.props.children);
  }
  return "";
}

describe("round7 TUI diff presentation data", () => {
  test("ordinary unified hunk lines beginning with non-space source are classified as context", () => {
    const hunk = [
      "@@ -1,2 +1,2 @@",
      "-const value = 1;",
      "+const value = 2;",
      " keep();",
    ];
    const actual = hunk.map(classifyDiffLine);
    expect(actual.map((line) => line.kind)).toEqual([
      "hunk", "context", "context", "context",
    ]);
    expect(actual[1]?.text).toBe("-const value = 1;");
    expect(actual[2]?.text).toBe("+const value = 2;");
    // The same unified syntax is recognised when the source itself is indented.
    expect(classifyDiffLine("-  const value = 1;")).toEqual({
      kind: "remove", text: " const value = 1;",
    });
    expect(classifyDiffLine("+  const value = 2;")).toEqual({
      kind: "add", text: " const value = 2;",
    });
    expect(classifyDiffLine("+++ b/file.ts").kind).toBe("context");
    expect(classifyDiffLine("--- a/file.ts").kind).toBe("context");
  });

  test("empty unified insertions and removals also miss the diff classification", () => {
    expect(classifyDiffLine("+")).toEqual({ kind: "context", text: "+" });
    expect(classifyDiffLine("-")).toEqual({ kind: "context", text: "-" });
    // Compact Edit-tool format deliberately includes an extra separator space.
    expect(classifyDiffLine("  + new")).toEqual({ kind: "add", text: "new" });
    expect(classifyDiffLine("  - old")).toEqual({ kind: "remove", text: "old" });
  });

  test("CJK diff padding exceeds the requested column width while ASCII matches it", () => {
    const descriptor = Object.getOwnPropertyDescriptor(process.stdout, "columns");
    Object.defineProperty(process.stdout, "columns", {
      configurable: true, value: 80,
    });
    try {
      const ascii = textChildren(DiffLine({ kind: "add", text: "x".repeat(20) }));
      const cjk = textChildren(DiffLine({ kind: "add", text: "中".repeat(20) }));
      const cjkWithGutter = textChildren(DiffLine({
        kind: "remove", text: "中".repeat(20), gutter: "  ⎿  ",
      }));
      expect(stringWidth(ascii)).toBe(80);
      expect(stringWidth(cjk)).toBe(100);
      expect(stringWidth(cjkWithGutter)).toBe(100);
      expect(cjk.length).toBe(80);
      expect(cjk.startsWith("+ " + "中".repeat(20))).toBe(true);
      expect(cjkWithGutter.startsWith("  ⎿  - " + "中".repeat(20))).toBe(true);
    } finally {
      if (descriptor) Object.defineProperty(process.stdout, "columns", descriptor);
      else delete (process.stdout as { columns?: number }).columns;
    }
  });
});
