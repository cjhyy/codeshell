import { describe, expect, test } from "bun:test";
import { patchBackupTargets, patchDiffTargets } from "./backup-targets.js";
import { resolve } from "node:path";

const wrap = (body: string) => `*** Begin Patch\n${body}\n*** End Patch`;

describe("coding patchBackupTargets", () => {
  test("update + delete hunks → their resolved paths", () => {
    const patch = wrap(
      ["*** Update File: src/a.ts", "@@", "-old", "+new", "*** Delete File: src/b.ts"].join("\n"),
    );
    const out = patchBackupTargets(patch, "/repo");
    expect(out).toEqual([resolve("/repo", "src/a.ts"), resolve("/repo", "src/b.ts")]);
  });

  test("add hunks are excluded (no prior content)", () => {
    const patch = wrap(["*** Add File: src/new.ts", "+hello"].join("\n"));
    expect(patchBackupTargets(patch, "/repo")).toEqual([]);
  });

  test("resolves relative paths against the given cwd", () => {
    const patch = wrap(["*** Update File: pkg/x.ts", "@@", "-a", "+b"].join("\n"));
    expect(patchBackupTargets(patch, "/work/dir")).toEqual([resolve("/work/dir", "pkg/x.ts")]);
  });

  test("unparseable patch → empty (tool will reject it anyway)", () => {
    expect(patchBackupTargets("not a patch", "/repo")).toEqual([]);
  });
});

describe("coding patchDiffTargets", () => {
  test("captures additions, updates, deletions, and both move locations", () => {
    const patch = wrap(
      [
        "*** Add File: src/new.ts",
        "+created",
        "*** Update File: src/old.ts",
        "*** Move to: lib/moved.ts",
        "@@",
        "-before",
        "+after",
        "*** Delete File: removed.ts",
      ].join("\n"),
    );
    expect(patchDiffTargets(patch, "/repo")).toEqual(
      ["src/new.ts", "src/old.ts", "lib/moved.ts", "removed.ts"].map((path) =>
        resolve("/repo", path),
      ),
    );
    // Existing undo selection stays separate from the complete diff targets.
    expect(patchBackupTargets(patch, "/repo")).toEqual([
      resolve("/repo", "src/old.ts"),
      resolve("/repo", "removed.ts"),
    ]);
  });

  test("normalizes aliases and preserves absolute paths and filenames with spaces", () => {
    const absolute = resolve("/outside", "文 件.ts");
    const patch = wrap(
      [
        "*** Add File: ./src/../src/a.ts",
        "+one",
        "*** Update File: src/a.ts",
        "@@",
        "-one",
        "+two",
        `*** Delete File: ${absolute}`,
      ].join("\n"),
    );
    expect(patchDiffTargets(patch, "/repo")).toEqual([resolve("/repo", "src/a.ts"), absolute]);
  });

  test("a malformed later hunk yields no partial targets", () => {
    expect(
      patchDiffTargets(wrap("*** Add File: ok.ts\n+ok\n*** Unknown File: invalid.ts"), "/repo"),
    ).toEqual([]);
    expect(patchDiffTargets("not a patch", "/repo")).toEqual([]);
    expect(patchDiffTargets(wrap(""), "/repo")).toEqual([]);
  });

  test("accepts the same lenient heredoc wrapper as the actual tool", () => {
    const patch = `<<'EOF'\n${wrap("*** Add File: file.ts\n+new")}\nEOF`;
    expect(patchDiffTargets(patch, "/repo")).toEqual([resolve("/repo", "file.ts")]);
  });
});
