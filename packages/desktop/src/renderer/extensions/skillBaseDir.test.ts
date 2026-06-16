import { describe, test, expect } from "bun:test";
import { skillBaseDir } from "./skillBaseDir";

describe("skillBaseDir", () => {
  test("returns the directory of an absolute SKILL.md path", () => {
    expect(skillBaseDir("/Users/me/.code-shell/plugins/sp/skills/using-superpowers/SKILL.md")).toBe(
      "/Users/me/.code-shell/plugins/sp/skills/using-superpowers",
    );
  });

  test("handles a path with CJK segments", () => {
    expect(skillBaseDir("/Users/me/个人学习/skills/foo/SKILL.md")).toBe(
      "/Users/me/个人学习/skills/foo",
    );
  });

  test("strips a trailing slash before taking the dir (defensive)", () => {
    expect(skillBaseDir("/a/b/SKILL.md/")).toBe("/a/b");
  });

  test("returns null for a bare filename with no directory", () => {
    expect(skillBaseDir("SKILL.md")).toBeNull();
  });

  test("returns null for empty / undefined input", () => {
    expect(skillBaseDir("")).toBeNull();
    expect(skillBaseDir(undefined as unknown as string)).toBeNull();
  });
});
