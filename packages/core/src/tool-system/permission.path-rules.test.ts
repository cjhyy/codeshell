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

describe("ruleMatches Bash head-narrowing guard (shared by Classifier + session cache)", () => {
  // The Bash allow-rule `^git(\s|$)` is the same whether it came from a persisted
  // PROJECT rule (PermissionClassifier.matchesRule) or an in-session grant
  // (InteractiveApprovalBackend). Because both delegate to ruleMatches, testing
  // it here locks the chained-command/pipe guard at its shared source — a future
  // refactor of either consumer can't silently reopen the bypass.
  const gitRule: PermissionRule = {
    tool: "Bash",
    argsPattern: { command: "^git(\\s|$)" },
    decision: "allow",
    reason: "test",
  };

  test("a benign single git command matches (no over-blocking)", () => {
    expect(ruleMatches(gitRule, "Bash", { command: "git status" })).toBe(true);
    expect(ruleMatches(gitRule, "Bash", { command: "git diff --stat" })).toBe(true);
  });

  test("chained / piped / substituted commands do NOT match (no smuggling past the head)", () => {
    for (const command of [
      "git status && rm -rf /",
      "git status; rm -rf /",
      "git status || rm -rf /",
      "git log | sh",
      "git log $(rm -rf /)",
      "git log `rm -rf /`",
      "git status > /etc/hosts",
    ]) {
      expect(ruleMatches(gitRule, "Bash", { command }), command).toBe(false);
    }
  });
});
