import { describe, expect, test } from "bun:test";
import { parseUnifiedDiff } from "../../../packages/desktop/src/renderer/diff/parseUnifiedDiff";
import { basename, formatDuration, parsedArgs, prettyJson, truncate } from "../../../packages/desktop/src/renderer/tool-cards/utils";
import type { ToolMessage } from "../../../packages/desktop/src/renderer/types";

// Synthetic standard patch text; no Git command, Electron, browser or UI mount.
// Contracts: Git diff-format "Generating patch text with -p", and parser module
// promises to retain diff --git file identity for the viewer.
describe("ordinary header-only patch identity observations", () => {
  test("mode-only modified file loses both header paths", () => {
    const raw = "diff --git a/run.sh b/run.sh\nold mode 100644\nnew mode 100755\n";
    const files = parseUnifiedDiff(raw);
    console.log(JSON.stringify({ scenario: "mode-only", raw, files }));
    expect(files).toHaveLength(1);
    expect(files[0]).toEqual({ oldPath: null, newPath: null, status: "modified", hunks: [] });
    expect(files.filter(file => (file.newPath ?? file.oldPath) === "run.sh")).toHaveLength(0);
  });

  test("empty added and deleted files retain status but lose identity", () => {
    const raw = "diff --git a/empty.txt b/empty.txt\nnew file mode 100644\nindex 0000000..e69de29\n" +
      "diff --git a/gone.txt b/gone.txt\ndeleted file mode 100644\nindex e69de29..0000000\n";
    const files = parseUnifiedDiff(raw);
    console.log(JSON.stringify({ scenario: "empty-files", raw, files }));
    expect(files).toHaveLength(2);
    expect(files.map(file => file.status)).toEqual(["added", "deleted"]);
    expect(files.map(file => [file.oldPath, file.newPath])).toEqual([[null, null], [null, null]]);
  });

  test("binary notice without text hunk also loses identity", () => {
    const raw = "diff --git a/image.png b/image.png\nindex 1234567..7654321 100644\nBinary files a/image.png and b/image.png differ\n";
    const files = parseUnifiedDiff(raw);
    console.log(JSON.stringify({ scenario: "binary-notice", raw, files }));
    expect(files).toHaveLength(1);
    expect([files[0].oldPath, files[0].newPath]).toEqual([null, null]);
    expect(files[0].hunks).toEqual([]);
  });

  test("ordinary textual hunk control has both paths and numbered contents", () => {
    const raw = "diff --git a/run.sh b/run.sh\nindex 1234567..7654321 100644\n--- a/run.sh\n+++ b/run.sh\n@@ -1 +1 @@\n-old\n+new\n";
    const [file] = parseUnifiedDiff(raw);
    expect([file.oldPath, file.newPath]).toEqual(["run.sh", "run.sh"]);
    expect(file.status).toBe("modified");
    expect(file.hunks[0].lines).toEqual([
      { kind: "del", text: "old", oldLine: 1, newLine: null },
      { kind: "add", text: "new", oldLine: null, newLine: 1 },
    ]);
  });
});

describe("tool-card text display observations and controls", () => {
  test.each([70, 80, 90])("real positive card limit %i splits a valid emoji pair", max => {
    const input = "x".repeat(max - 2) + "😀" + "tail";
    const actual = truncate(input, max);
    const normalized = new TextDecoder().decode(new TextEncoder().encode(actual));
    console.log(JSON.stringify({ scenario: "unicode-card-label", max, input, actual,
      tailUnits: [actual.charCodeAt(actual.length - 2), actual.charCodeAt(actual.length - 1)], normalized }));
    expect(input.isWellFormed()).toBe(true);
    expect(actual.length).toBe(max);
    expect(actual.charCodeAt(actual.length - 2)).toBe(0xd83d);
    expect(actual.isWellFormed()).toBe(false);
    expect(normalized).toBe("x".repeat(max - 2) + "�…");
  });

  test("short Unicode, safe emoji boundary, ASCII and BMP text controls", () => {
    expect(truncate("文😀件", 70)).toBe("文😀件");
    expect(truncate("x".repeat(67) + "😀" + "tail", 70)).toBe("x".repeat(67) + "😀…");
    expect(truncate("x".repeat(72), 70)).toBe("x".repeat(69) + "…");
    expect(truncate("中".repeat(72), 70)).toBe("中".repeat(69) + "…");
  });

  test("ordinary neighbouring metadata helpers preserve their documented values", () => {
    expect(basename("/docs/中文/文😀件.svg/")).toBe("文😀件.svg");
    expect(basename("C:\\docs\\icon.svg")).toBe("icon.svg");
    expect(formatDuration(undefined)).toBeNull();
    expect(formatDuration(-1)).toBeNull();
    expect(formatDuration(999)).toBe("999ms");
    expect(formatDuration(1000)).toBe("1.0s");
    expect(formatDuration(61200)).toBe("1m 1s");
    expect(prettyJson('{"label":"文😀件"}')).toBe('{\n  "label": "文😀件"\n}');
    expect(prettyJson("not-json")).toBe("not-json");
    const message = { kind: "tool", id: "owned", toolName: "Read", args: '{"file_path":"/docs/文😀件.txt"}' } as ToolMessage;
    expect(parsedArgs(message)).toEqual({ file_path: "/docs/文😀件.txt" });
  });
});
