import { describe, expect, test } from "bun:test";
import type { DiffFile } from "./parseUnifiedDiff";
import { capFiles, reviewDiffFileKey } from "./UnifiedDiffViewer";

const file: DiffFile = {
  oldPath: "src/shared.ts",
  newPath: "src/shared.ts",
  status: "modified",
  hunks: [],
};

describe("Review diff repository identity", () => {
  test("a file with many merged hunks cannot bypass the rendered-line budget", () => {
    const lines = ["one", "two", "three"].map((text, index) => ({
      kind: "add" as const,
      text,
      oldLine: null,
      newLine: index + 1,
    }));
    const largeFile = {
      ...file,
      hunks: [
        { header: "@@ -0,0 +1,3 @@", oldStart: 0, oldCount: 0, newStart: 1, newCount: 3, lines },
        { header: "@@ -0,0 +4,3 @@", oldStart: 0, oldCount: 0, newStart: 4, newCount: 3, lines },
      ],
    };
    const loaded = { file: largeFile, key: "a", rootId: "root-a", repoRoot: "/repo" };
    const limited = capFiles([loaded], 4);
    expect(limited).toHaveLength(1);
    expect(limited[0]?.file.hunks.map((hunk) => hunk.lines.length)).toEqual([3, 1]);
    expect(largeFile.hunks.map((hunk) => hunk.lines.length)).toEqual([3, 3]);
  });
  test("does not key same-named relative files by path alone", () => {
    const left = reviewDiffFileKey({ rootId: "root-a", repoRoot: "/workspace/repo-a" }, file, 0);
    const right = reviewDiffFileKey({ rootId: "root-b", repoRoot: "/workspace/repo-b" }, file, 0);

    expect(left).not.toBe(right);
    expect(left).toContain("root-a");
    expect(left).toContain("/workspace/repo-a");
  });
});
