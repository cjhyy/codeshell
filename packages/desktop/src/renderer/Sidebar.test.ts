import { describe, expect, test } from "bun:test";
import { formatRelative, sessionHoverBranch, worktreeBranchOf } from "./Sidebar";

describe("Sidebar relative time", () => {
  const now = Date.UTC(2026, 6, 16, 12, 0, 0);

  test("uses the selected UI language", () => {
    expect(formatRelative(now - 3 * 60_000, "zh", now)).toContain("3分钟");
    expect(formatRelative(now - 3 * 60_000, "en", now)).toContain("3m");
    expect(formatRelative(now - 3 * 60_000, "en", now)).not.toContain("分");
  });

  test("clamps future timestamps to the present", () => {
    expect(formatRelative(now + 60_000, "en", now)).toBe("now");
  });
});

describe("Sidebar worktree marker", () => {
  test("shows the worktree branch in the session hover title", () => {
    const branch = worktreeBranchOf({
      root: "/repo/.worktrees/feature",
      kind: "worktree",
      worktree: {
        path: "/repo/.worktrees/feature",
        branch: "worktree/feature-session",
        baseRef: "main",
        createdBy: "codeshell",
      },
    });

    expect(branch).toBe("worktree/feature-session");
    expect(sessionHoverBranch(branch, "main")).toBe("worktree/feature-session");
  });

  test("falls back to the project branch for ordinary Sessions", () => {
    expect(worktreeBranchOf({ root: "/repo", kind: "main" })).toBeUndefined();
    expect(sessionHoverBranch(undefined, "main")).toBe("main");
  });
});
