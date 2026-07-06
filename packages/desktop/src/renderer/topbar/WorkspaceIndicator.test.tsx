import { describe, expect, test } from "bun:test";
import { translate, type TFunction } from "../i18n";
import {
  formatWorkspaceDiffSummary,
  workspaceIndicatorText,
  workspaceRowDisabledReason,
} from "./WorkspaceIndicator";
import type { SessionWorkspace, SessionWorkspaceWorktreeInfo } from "../../preload/types";

const t: TFunction = (key, params) => translate("en", key, params);

describe("WorkspaceIndicator helpers", () => {
  test("formats the status-bar workspace label", () => {
    const main: SessionWorkspace = { root: "/repo", kind: "main" };
    const worktree: SessionWorkspace = {
      root: "/repo/.worktrees/feature",
      kind: "worktree",
      worktree: {
        path: "/repo/.worktrees/feature",
        branch: "worktree/feature-session",
        baseRef: "main",
        createdBy: "codeshell",
      },
    };

    expect(workspaceIndicatorText(main, "codeshell")).toBe("main (codeshell)");
    expect(workspaceIndicatorText(worktree, "codeshell")).toBe("⑃ worktree/feature-session");
  });

  test("formats the diff summary", () => {
    expect(
      formatWorkspaceDiffSummary(
        { baseRef: "main", changedFiles: 4, aheadCommits: 2, hasUncommittedChanges: true },
        t,
      ),
    ).toBe("±4 files · ahead 2");
  });

  test("marks only the current row as disabled", () => {
    const current: SessionWorkspace = { root: "/repo", kind: "main" };
    const mainRow: SessionWorkspaceWorktreeInfo = {
      path: "/repo",
      branch: "main",
      head: "abc123",
      isMain: true,
    };
    const otherRow: SessionWorkspaceWorktreeInfo = {
      path: "/repo/.worktrees/feature",
      branch: "worktree/feature-session",
      head: "def456",
      occupiedByOtherSession: true,
    };

    expect(workspaceRowDisabledReason(mainRow, current, t)).toBe("Current workspace");
    expect(workspaceRowDisabledReason(otherRow, current, t)).toBeNull();
  });
});
