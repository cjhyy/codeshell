/**
 * Round 12 characterization: pure patch parser + pure matcher only.
 * Tests assert the frozen implementation's observed output, including the
 * context-loss defect. Nothing here executes applyPatch or ApplyPatch tools.
 */
import { describe, expect, it } from "bun:test";
import { parsePatch } from "../../../packages/coding/src/tools/apply-patch/parser.js";
import { seekSequence } from "../../../packages/coding/src/tools/apply-patch/seek-sequence.js";
import type { UpdateFileChunk } from "../../../packages/coding/src/tools/apply-patch/types.js";

function chunk(body: string): UpdateFileChunk {
  const parsed = parsePatch(
    ["*** Begin Patch", "*** Update File: ordinary.txt", body, "*** End Patch"].join("\n"),
  );
  const hunk = parsed.hunks[0];
  if (hunk.kind !== "update") throw new Error("expected update hunk");
  expect(parsed.hunks).toHaveLength(1);
  expect(hunk.chunks).toHaveLength(1);
  return hunk.chunks[0];
}

describe("missing first @@ and explicit whitespace context", () => {
  it("retains ordinary nonblank context without an optional @@ marker", () => {
    const parsed = chunk(" prefix\n-same\n+changed");
    expect(parsed.oldLines).toEqual(["prefix", "same"]);
    expect(parsed.newLines).toEqual(["prefix", "changed"]);
  });

  it("drops a valid space-prefixed empty first context line without @@", () => {
    const parsed = chunk(" \n-same\n+changed");
    // Defect characterization: grammar requires ["", "same"].
    expect(parsed.oldLines).toEqual(["same"]);
    expect(parsed.newLines).toEqual(["changed"]);
  });

  it("retains exactly the same empty context line with explicit @@", () => {
    const parsed = chunk("@@\n \n-same\n+changed");
    expect(parsed.oldLines).toEqual(["", "same"]);
    expect(parsed.newLines).toEqual(["", "changed"]);
  });

  it("drops all initial marked whitespace context including tabs", () => {
    const parsed = chunk(" \n  \t\n-same\n+changed");
    expect(parsed.oldLines).toEqual(["same"]);
    expect(parsed.newLines).toEqual(["changed"]);
  });

  it("preserves the marked whitespace bytes after explicit @@", () => {
    const parsed = chunk("@@\n \n  \t\n-same\n+changed");
    expect(parsed.oldLines).toEqual(["", " \t", "same"]);
    expect(parsed.newLines).toEqual(["", " \t", "changed"]);
  });

  it("matches the earlier duplicate after the parser drops unique empty context", () => {
    const fileLines = ["same", "separator", "", "same"];
    const lostContext = chunk(" \n-same\n+changed");
    const retainedContext = chunk("@@\n \n-same\n+changed");
    expect(seekSequence(fileLines, lostContext.oldLines, 0, false)).toBe(0);
    expect(seekSequence(fileLines, retainedContext.oldLines, 0, false)).toBe(2);
  });

  it("retains interior empty context when a nonblank context starts the chunk", () => {
    const parsed = chunk(" prefix\n \n-same\n+changed");
    expect(parsed.oldLines).toEqual(["prefix", "", "same"]);
    expect(parsed.newLines).toEqual(["prefix", "", "changed"]);
  });

  it("preserves literal punctuation, Unicode, and whitespace in added content", () => {
    const parsed = parsePatch(
      [
        "*** Begin Patch",
        "*** Add File: ordinary.txt",
        "+  literal $& $$ $' ` 中文\t  ",
        "+",
        "*** End Patch",
      ].join("\n"),
    );
    expect(parsed.hunks).toEqual([
      { kind: "add", path: "ordinary.txt", contents: "  literal $& $$ $' ` 中文\t  \n\n" },
    ]);
  });
});
