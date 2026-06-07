import { describe, expect, test } from "bun:test";
import { diffLines, renderDiffPreview } from "./simple-diff.js";

describe("diffLines", () => {
  test("identical → all context lines", () => {
    const out = diffLines("a\nb", "a\nb");
    expect(out.every((l) => l.marker === " ")).toBe(true);
    expect(out.map((l) => l.text)).toEqual(["a", "b"]);
  });

  test("a changed middle line shows -old +new with context", () => {
    const out = diffLines("a\nb\nc", "a\nB\nc");
    expect(out).toEqual([
      { marker: " ", text: "a" },
      { marker: "-", text: "b" },
      { marker: "+", text: "B" },
      { marker: " ", text: "c" },
    ]);
  });

  test("pure addition", () => {
    const out = diffLines("a", "a\nb");
    expect(out).toEqual([
      { marker: " ", text: "a" },
      { marker: "+", text: "b" },
    ]);
  });

  test("pure deletion", () => {
    const out = diffLines("a\nb", "a");
    expect(out).toEqual([
      { marker: " ", text: "a" },
      { marker: "-", text: "b" },
    ]);
  });
});

describe("renderDiffPreview", () => {
  test("identical → empty string", () => {
    expect(renderDiffPreview("x\ny", "x\ny")).toBe("");
  });

  test("shows the change with +/- markers", () => {
    const out = renderDiffPreview("a\nb\nc", "a\nB\nc");
    expect(out).toContain("-b");
    expect(out).toContain("+B");
    expect(out).toContain(" a");
  });

  test("elides far-away context with a gap marker", () => {
    const from = Array.from({ length: 30 }, (_, i) => `line${i}`).join("\n");
    const to = from.replace("line15", "CHANGED");
    const out = renderDiffPreview(from, to, 2);
    expect(out).toContain("⋯");
    expect(out).toContain("-line15");
    expect(out).toContain("+CHANGED");
    // Far-away lines are elided, not printed.
    expect(out).not.toContain("line0");
  });
});
