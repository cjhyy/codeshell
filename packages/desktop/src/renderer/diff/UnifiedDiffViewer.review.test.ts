import { describe, expect, test } from "bun:test";
import type { DiffFile } from "./parseUnifiedDiff";
import { reviewDiffFileKey } from "./UnifiedDiffViewer";

const file: DiffFile = {
  oldPath: "src/shared.ts",
  newPath: "src/shared.ts",
  status: "modified",
  hunks: [],
};

describe("Review diff repository identity", () => {
  test("does not key same-named relative files by path alone", () => {
    const left = reviewDiffFileKey({ rootId: "root-a", repoRoot: "/workspace/repo-a" }, file, 0);
    const right = reviewDiffFileKey({ rootId: "root-b", repoRoot: "/workspace/repo-b" }, file, 0);

    expect(left).not.toBe(right);
    expect(left).toContain("root-a");
    expect(left).toContain("/workspace/repo-a");
  });
});
