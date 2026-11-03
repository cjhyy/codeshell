import { describe, expect, test } from "bun:test";
import {
  sanitizeExternalChangedFilesProvenance,
  sanitizeGitBlobRef,
} from "./external-file-provenance.js";

const ref = {
  kind: "git-blob",
  commit: "a".repeat(40),
  blob: "b".repeat(40),
  repoPath: "dir/file.ts",
  worktreePath: "/tmp/work",
  linkedWorktree: true,
  repositoryId: "c".repeat(64),
};
const file = {
  path: "exact.ts",
  absolutePath: "/tmp/work/dir/file.ts",
  presence: "present",
  size: 3,
  versionStatus: "recorded",
  contentRef: ref,
};
const provenance = (files: unknown[] = [file]) => ({
  schemaVersion: 1,
  cli: "claude",
  observedAt: 123,
  capture: "completion",
  files,
});

describe("external changed files provenance", () => {
  test("copies the optional protocol and accepts SHA256 Git objects", () => {
    expect(sanitizeExternalChangedFilesProvenance(provenance(), [file.path])).toEqual(provenance());
    expect(
      sanitizeGitBlobRef({ ...ref, commit: "a".repeat(64), blob: "b".repeat(64) }),
    ).toBeDefined();
  });
  test("rejects malformed schemas and never throws even on hostile objects", () => {
    for (const v of [
      null,
      [],
      {},
      { ...provenance(), schemaVersion: 2 },
      { ...provenance(), cli: "shell" },
      { ...provenance(), observedAt: Infinity },
      { ...provenance(), observedAt: -1 },
      { ...provenance(), capture: "write" },
      new Proxy(
        {},
        {
          get() {
            throw Error("hostile");
          },
        },
      ),
    ]) {
      expect(sanitizeExternalChangedFilesProvenance(v, [file.path])).toBeUndefined();
    }
  });
  test("isolates damaged entries and rejects unknown paths, invalid fields and excess entries", () => {
    const bad = [
      { ...file, path: "other.ts" },
      { ...file, presence: "exists" },
      { ...file, absolutePath: "relative" },
      { ...file, size: -1 },
      { ...file, size: 1.5 },
      { ...file, versionStatus: "guessed" },
    ];
    expect(
      sanitizeExternalChangedFilesProvenance(provenance([...bad, file]), [file.path])?.files,
    ).toEqual([file]);
    expect(
      sanitizeExternalChangedFilesProvenance(
        provenance([{ ...file, contentRef: { ...ref, blob: "HEAD" } }]),
        [file.path],
      )?.files[0]?.contentRef,
    ).toBeUndefined();
    const files = Array.from({ length: 105 }, (_, i) => ({ ...file, path: `f${i}` }));
    expect(
      sanitizeExternalChangedFilesProvenance(
        provenance(files),
        files.map((x) => x.path),
      )?.files,
    ).toHaveLength(100);
  });
  test("strict literal repo paths and all contentRef fields", () => {
    for (const repoPath of [
      "",
      "/etc/passwd",
      "../a",
      "a/../b",
      "./a",
      "a//b",
      "a/",
      "a\\b",
      "a\0b",
      "a".repeat(4097),
      "C:/a",
    ]) {
      expect(sanitizeGitBlobRef({ ...ref, repoPath })).toBeUndefined();
    }
    for (const patch of [
      { commit: "HEAD" },
      { blob: "abc" },
      { worktreePath: "x" },
      { linkedWorktree: 1 },
      { branch: 1 },
      { repositoryId: "bad" },
    ])
      expect(sanitizeGitBlobRef({ ...ref, ...patch })).toBeUndefined();
    expect(sanitizeGitBlobRef({ ...ref, repoPath: ":(glob)* [a]\n文.ts" })).toBeDefined();
  });
});
