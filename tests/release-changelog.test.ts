import { expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { collectReleaseChangelogErrors } from "../scripts/verify-release-versions";
test("release notes require an exact version heading rather than a mention or prefix", () => {
  const root = mkdtempSync(join(tmpdir(), "release-notes-"));
  try {
    expect(collectReleaseChangelogErrors("0.9.52", root)).toEqual(["CHANGELOG.md is missing"]);
    for (const text of [
      "## [Unreleased]\n0.9.52 is coming",
      "## [0.9.520]",
      "### [0.9.52]",
      "## [0x9x52]",
    ]) {
      writeFileSync(join(root, "CHANGELOG.md"), text);
      expect(collectReleaseChangelogErrors("0.9.52", root)).toHaveLength(1);
    }
    for (const text of ["## [0.9.52]", "## [0.9.52] - 2026-11-02\n\n### Fixed\n- Details"]) {
      writeFileSync(join(root, "CHANGELOG.md"), text);
      expect(collectReleaseChangelogErrors("0.9.52", root)).toEqual([]);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
