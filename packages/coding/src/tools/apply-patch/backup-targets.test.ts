import { describe, expect, test } from "bun:test";
import { patchBackupTargets } from "./backup-targets.js";
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
