import { describe, expect, test } from "bun:test";
import type { DiffFile } from "./parseUnifiedDiff";
import { reviewDiffFileKey } from "./UnifiedDiffViewer";
import { diffFileStats, diffLineText, splitDiffSections } from "./diffSections";
import { fileURLToPath } from "node:url";
import { withHeaderOnlyGitPatch } from "./headerOnlyGit.fixture";

const file: DiffFile = {
  oldPath: "src/shared.ts",
  newPath: "src/shared.ts",
  status: "modified",
  hunks: [],
};

export const SPACED_NAME_PATCH = [
  'diff --git "a/ padded name.ts " "b/ padded name.ts "',
  "index 1111111..2222222 100644",
  '--- "a/ padded name.ts "',
  '+++ "b/ padded name.ts "',
  "@@ -1,3 +1,3 @@",
  " keep",
  "-old line",
  "+new line",
  " tail",
  "",
].join("\n");

describe("Review diff repository identity", () => {
  test("each Git section keeps its own header, including header-only files", async () => {
    await withHeaderOnlyGitPatch(({ raw, expected }) => {
      const sections = splitDiffSections(raw);
      expect(sections.map((section) => section.file)).toEqual(expected);
      // Header-only changes have no body to render.
      expect(sections.every((section) => section.file.hunks.length === 0)).toBe(true);
    });
  });

  test("our parser reads the section Pierre renders", () => {
    const [section] = splitDiffSections(SPACED_NAME_PATCH);
    expect(section?.file.newPath).toBe(" padded name.ts ");
    expect(diffFileStats(section!.file)).toEqual({ added: 1, removed: 1 });
    expect(diffLineText(section!.file, "additions", 2)).toBe("new line");
    expect(diffLineText(section!.file, "deletions", 2)).toBe("old line");
    expect(diffLineText(section!.file, "additions", 99)).toBe("");
  });

  test("Pierre renders the hunks while display names stay ours", () => {
    // Pierre's root entry registers custom elements on import, so it runs in
    // its own process rather than beside suites that install a mini DOM.
    const result = Bun.spawnSync({
      cmd: [
        process.execPath,
        fileURLToPath(new URL("./pierreDiffModel.fixture.ts", import.meta.url)),
      ],
      stdout: "pipe",
      stderr: "pipe",
    });
    expect({ exitCode: result.exitCode, stderr: result.stderr.toString() }).toEqual({
      exitCode: 0,
      stderr: "",
    });
  });

  test("does not key same-named relative files by path alone", () => {
    const left = reviewDiffFileKey({ rootId: "root-a", repoRoot: "/workspace/repo-a" }, file, 0);
    const right = reviewDiffFileKey({ rootId: "root-b", repoRoot: "/workspace/repo-b" }, file, 0);

    expect(left).not.toBe(right);
    expect(left).toContain("root-a");
    expect(left).toContain("/workspace/repo-a");
  });
});
