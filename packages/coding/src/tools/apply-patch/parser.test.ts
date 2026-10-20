import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { applyPatch } from "./applier.js";
import { parsePatch } from "./parser.js";

describe("parsePatch: first Update chunk without @@", () => {
  test("keeps space-marked whitespace context lines", () => {
    const withoutAnchor = parsePatch(
      "*** Begin Patch\n*** Update File: a.txt\n \n  \t\n-same\n+changed\n*** End Patch",
    );
    const withAnchor = parsePatch(
      "*** Begin Patch\n*** Update File: a.txt\n@@\n \n  \t\n-same\n+changed\n*** End Patch",
    );
    const chunk = (p: ReturnType<typeof parsePatch>) =>
      p.hunks[0]!.kind === "update" ? p.hunks[0]!.chunks[0] : undefined;
    expect(chunk(withoutAnchor)?.oldLines).toEqual(["", " \t", "same"]);
    expect(chunk(withoutAnchor)?.newLines).toEqual(["", " \t", "changed"]);
    expect(chunk(withoutAnchor)?.oldLines).toEqual(chunk(withAnchor)?.oldLines);
  });
});

describe("applyPatch: leading blank context selects the anchored occurrence", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-applypatch-parser-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("changes the occurrence that follows the blank line", async () => {
    const file = join(dir, "a.txt");
    writeFileSync(file, "same\nseparator\n\nsame\n");
    const { hunks } = parsePatch(
      "*** Begin Patch\n*** Update File: a.txt\n \n-same\n+changed\n*** End Patch",
    );
    await applyPatch(hunks, { cwd: dir });
    expect(readFileSync(file, "utf-8")).toBe("same\nseparator\n\nchanged\n");
  });
});
