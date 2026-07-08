import { describe, expect, test } from "bun:test";
import {
  applyPrefix,
  isManagedWorktreeBranch,
  normalizeWorktreeBranchPrefix,
  validateWorktreeSlug,
} from "./slug.js";

describe("worktree slug and branch prefix helpers", () => {
  test("validateWorktreeSlug rejects empty or whitespace slugs", () => {
    expect(() => validateWorktreeSlug("")).toThrow(/empty/i);
    expect(() => validateWorktreeSlug("   ")).toThrow(/empty/i);
  });

  test("applyPrefix uses the default prefix and short session id", () => {
    expect(applyPrefix(undefined, "feat", "session123456")).toBe("worktree/feat-session1");
  });

  test("applyPrefix normalizes custom prefixes to a trailing slash", () => {
    expect(applyPrefix("agent", "feat", "abcdef123456")).toBe("agent/feat-abcdef12");
    expect(applyPrefix("agent/", "feat", "abcdef123456")).toBe("agent/feat-abcdef12");
  });

  test("normalizeWorktreeBranchPrefix rejects unsafe git branch namespaces", () => {
    expect(() => normalizeWorktreeBranchPrefix("")).toThrow(/invalid/i);
    expect(() => normalizeWorktreeBranchPrefix("../bad")).toThrow(/invalid/i);
    expect(() => normalizeWorktreeBranchPrefix("bad prefix")).toThrow(/invalid/i);
  });

  test("managed branch detection accepts configured and historical prefixes", () => {
    expect(isManagedWorktreeBranch("agent/feat-abcdef12", "agent/")).toBe(true);
    expect(isManagedWorktreeBranch("worktree/old-abcdef12", "agent/")).toBe(true);
    expect(isManagedWorktreeBranch("external/feat-abcdef12", "agent/")).toBe(false);
  });
});
