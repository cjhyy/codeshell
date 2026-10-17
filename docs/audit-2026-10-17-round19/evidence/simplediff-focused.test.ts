import { describe, expect, test } from "bun:test";
import { diffLines, renderDiffPreview } from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/core/src/session/simple-diff.ts";

describe("round19 simple diff ordinary owned text", () => {
  test("source and target text projections survive small normal edits", () => {
    const pairs = [
      ["", ""], ["", "x"], ["x", ""], ["a\nb", "a\nB"],
      ["a\nb", "b\na"], ["x\nx\ny", "x\ny\nx"], ["a\n\nb", "a\nb"],
      ["a\nb", "a\n\nb"], ["a", "a\n"], ["a\n", "a"],
      ["🙂\ncafé", "🙂\n你好"], ["a\r\nb\r\n", "a\nB\n"],
    ];
    for (const [from, to] of pairs) {
      const rows = diffLines(from!, to!);
      expect(rows.filter((row) => row.marker !== "+").map((row) => row.text).join("\n")).toBe(from!.replace(/\r\n/g, "\n"));
      expect(rows.filter((row) => row.marker !== "-").map((row) => row.text).join("\n")).toBe(to!.replace(/\r\n/g, "\n"));
    }
  });
  test("CRLF-only differences intentionally collapse to identical previews", () => {
    expect(renderDiffPreview("a\r\nb\r\n", "a\nb\n")).toBe("");
    expect(renderDiffPreview("a\nb\n", "a\r\nb\r\n")).toBe("");
    expect(diffLines("a\r\n\r\nb", "a\n\nb")).toEqual([
      { marker: " ", text: "a" }, { marker: " ", text: "" }, { marker: " ", text: "b" },
    ]);
  });
  test("ordinary changed CRLF text has normalized context and markers", () => {
    const rows = diffLines("a\r\nb\r\nc", "a\nB\nc");
    expect(rows).toEqual([
      { marker: " ", text: "a" }, { marker: "-", text: "b" },
      { marker: "+", text: "B" }, { marker: " ", text: "c" },
    ]);
    expect(renderDiffPreview("a\r\nb\r\nc", "a\nB\nc")).toBe(" a\n-b\n+B\n c");
  });
  test("empty contents remain an empty preview with one split token", () => {
    expect(diffLines("", "")).toEqual([{ marker: " ", text: "" }]);
    expect(renderDiffPreview("", "")).toBe("");
  });
  test("empty to nonempty text and reverse expose split-token markers", () => {
    expect(renderDiffPreview("", "x")).toBe("-\n+x");
    expect(renderDiffPreview("x", "")).toBe("-x\n+");
  });
  test("trailing newline changes remain visible through blank split tokens", () => {
    expect(renderDiffPreview("a", "a\n")).toBe(" a\n+");
    expect(renderDiffPreview("a\n", "a")).toBe(" a\n-");
  });
  test("interior blank lines retain an explicit addition or removal", () => {
    expect(renderDiffPreview("a\nb", "a\n\nb")).toBe(" a\n+\n b");
    expect(renderDiffPreview("a\n\nb", "a\nb")).toBe(" a\n-\n b");
  });
  test("zero and one context preserve every change and compact only unchanged rows", () => {
    const from = "a\nb\nc\nd\ne";
    const to = "a\nb\nC\nd\ne";
    expect(renderDiffPreview(from, to, 0)).toBe("⋯\n-c\n+C\n⋯");
    expect(renderDiffPreview(from, to, 1)).toBe("⋯\n b\n-c\n+C\n d\n⋯");
    expect(renderDiffPreview(from, to)).toBe(" a\n b\n-c\n+C\n d\n e");
  });
  test("two changes have separate or merged context without duplicate rows", () => {
    const from = "0\n1\n2\n3\n4\n5\n6\n7\n8";
    const to = "0\n1\nX\n3\n4\n5\nY\n7\n8";
    expect(renderDiffPreview(from, to, 1)).toBe("⋯\n 1\n-2\n+X\n 3\n⋯\n 5\n-6\n+Y\n 7\n⋯");
    expect(renderDiffPreview(from, to, 2)).toBe(" 0\n 1\n-2\n+X\n 3\n 4\n 5\n-6\n+Y\n 7\n 8");
  });
  test("a literal gap character stays distinguishable through its line marker", () => {
    expect(renderDiffPreview("a\n⋯\nx", "a\n⋯\ny")).toBe(" a\n ⋯\n-x\n+y");
    expect(renderDiffPreview("a\n⋯\nx", "a\nthree dots\nx")).toBe(" a\n-⋯\n+three dots\n x");
  });
});
