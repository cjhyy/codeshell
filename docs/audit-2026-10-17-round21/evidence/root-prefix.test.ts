import { expect, test } from "bun:test";
import {
  normalizeWorktreeBranchPrefix,
  managedBranchPrefixes,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/coding/src/git/worktree/slug.ts";

test("ordinary omitted prefix uses the documented default namespace", () => {
  expect(normalizeWorktreeBranchPrefix()).toBe("worktree/");
  expect(normalizeWorktreeBranchPrefix(undefined)).toBe("worktree/");
});
test("ordinary one-level prefix normalizes to exactly one trailing slash", () => {
  expect(normalizeWorktreeBranchPrefix("codex")).toBe("codex/");
  expect(normalizeWorktreeBranchPrefix("codex/")).toBe("codex/");
});
test("ordinary hierarchical prefix preserves its components", () => {
  expect(normalizeWorktreeBranchPrefix("codex/audit")).toBe("codex/audit/");
  expect(normalizeWorktreeBranchPrefix("codex/audit/")).toBe("codex/audit/");
});
test("ordinary configured whitespace is trimmed before canonical formatting", () => {
  expect(normalizeWorktreeBranchPrefix("  codex/audit  ")).toBe("codex/audit/");
  expect(normalizeWorktreeBranchPrefix("  codex/audit/  ")).toBe("codex/audit/");
});
test("short Unicode prefix labels retain their text in this string mapping", () => {
  expect(normalizeWorktreeBranchPrefix("团队/任务")).toBe("团队/任务/");
  expect(normalizeWorktreeBranchPrefix("Team/任务/")).toBe("Team/任务/");
});
test("default configured and historical namespaces produce one list entry", () => {
  expect(managedBranchPrefixes()).toEqual(["worktree/"]);
  expect(managedBranchPrefixes("worktree")).toEqual(["worktree/"]);
  expect(managedBranchPrefixes("  worktree/  ")).toEqual(["worktree/"]);
});
test("custom namespace lists keep configured-first order and caller-owned arrays", () => {
  const first = managedBranchPrefixes("codex/audit");
  const second = managedBranchPrefixes("codex/audit");
  expect(first).toEqual(["codex/audit/", "worktree/"]);
  expect(second).toEqual(first);
  expect(second).not.toBe(first);
  first[0] = "changed-owned-label/";
  expect(managedBranchPrefixes("codex/audit")).toEqual(["codex/audit/", "worktree/"]);
});
