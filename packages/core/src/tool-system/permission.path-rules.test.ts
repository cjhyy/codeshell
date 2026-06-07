import { describe, expect, test } from "bun:test";
import { pathRuleArgsPattern, ruleMatches } from "./permission.js";
import type { PermissionRule } from "../types.js";

describe("pathRuleArgsPattern", () => {
  test("file → exact-path anchored regex", () => {
    expect(pathRuleArgsPattern("/repo/src/foo.ts", "file")).toEqual({
      file_path: "^/repo/src/foo\\.ts$",
    });
  });

  test("dir → directory prefix with trailing slash", () => {
    expect(pathRuleArgsPattern("/repo/src/foo.ts", "dir")).toEqual({
      file_path: "^/repo/src/",
    });
  });

  test("tool → null (no narrowing)", () => {
    expect(pathRuleArgsPattern("/repo/src/foo.ts", "tool")).toBeNull();
  });

  test("escapes regex metacharacters in the path", () => {
    const p = pathRuleArgsPattern("/repo/a.b(c)/f.ts", "dir");
    expect(p!.file_path).toBe("^/repo/a\\.b\\(c\\)/");
  });
});

describe("path-scoped rule matching (ruleMatches regression)", () => {
  const dirRule: PermissionRule = {
    tool: "Write",
    argsPattern: pathRuleArgsPattern("/r/src/foo.ts", "dir")!,
    decision: "allow",
  };

  test("dir rule matches a sibling file in the same directory", () => {
    expect(ruleMatches(dirRule, "Write", { file_path: "/r/src/bar.ts" })).toBe(true);
  });

  test("dir rule matches a file in a subdirectory", () => {
    expect(ruleMatches(dirRule, "Write", { file_path: "/r/src/deep/x.ts" })).toBe(true);
  });

  test("dir rule does NOT match a file outside the directory", () => {
    expect(ruleMatches(dirRule, "Write", { file_path: "/r/lib/a.ts" })).toBe(false);
  });

  test("dir rule does NOT match a sibling dir sharing the name prefix", () => {
    // The trailing-slash anchor is what prevents /r/src matching /r/src-secret.
    expect(ruleMatches(dirRule, "Write", { file_path: "/r/src-secret/a.ts" })).toBe(false);
  });

  test("file rule matches only the exact file", () => {
    const fileRule: PermissionRule = {
      tool: "Write",
      argsPattern: pathRuleArgsPattern("/r/src/foo.ts", "file")!,
      decision: "allow",
    };
    expect(ruleMatches(fileRule, "Write", { file_path: "/r/src/foo.ts" })).toBe(true);
    expect(ruleMatches(fileRule, "Write", { file_path: "/r/src/foo.ts.bak" })).toBe(false);
    expect(ruleMatches(fileRule, "Write", { file_path: "/r/src/bar.ts" })).toBe(false);
  });
});
