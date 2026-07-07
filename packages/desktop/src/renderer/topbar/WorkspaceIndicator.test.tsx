import { afterEach, describe, expect, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TopBar } from "../TopBar";
import { TooltipProvider } from "../components/ui/tooltip";
import { translate, type TFunction } from "../i18n";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import {
  WorkspaceIndicator,
  WorkspaceRow,
  formatWorkspaceDiffSummary,
  workspaceCleanupActionState,
  workspaceCleanupDisabledReason,
  workspaceIndicatorText,
  workspaceRowDisabledReason,
} from "./WorkspaceIndicator";
import type { SessionWorkspace, SessionWorkspaceWorktreeInfo } from "../../preload/types";

const t: TFunction = (key, params) => translate("en", key, params);

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function textOf(node: unknown): string {
  const current = node as {
    nodeType?: number;
    data?: string;
    childNodes?: unknown[];
    textContent?: string;
  };
  if (current.nodeType === 3) return current.data ?? current.textContent ?? "";
  const children = Array.from(current.childNodes ?? []);
  if (children.length === 0) return current.textContent ?? "";
  return children.map((child) => textOf(child)).join("");
}

let root: Root | null = null;

afterEach(async () => {
  if (!root) return;
  await act(async () => {
    root?.unmount();
    await flushMicrotasks();
  });
  root = null;
});

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
    expect(workspaceIndicatorText(main, "codeshell", { includeRepoName: false })).toBe("main");
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

  test("marks only non-selectable rows as disabled for switching", () => {
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

  test("marks occupied rows as cleanup-disabled with an explanatory reason", () => {
    const occupiedRow: SessionWorkspaceWorktreeInfo = {
      path: "/repo/.worktrees/feature",
      branch: "worktree/feature-session",
      head: "def456",
      occupiedByOtherSession: true,
      occupiedBySessionIds: ["other-session"],
    };

    expect(workspaceCleanupDisabledReason(occupiedRow)).toMatch(/another session/i);
  });
});

describe("WorkspaceRow", () => {
  test("renders occupied cleanup actions disabled with an explanatory tooltip", () => {
    const row: SessionWorkspaceWorktreeInfo = {
      path: "/repo/.worktrees/feature",
      branch: "worktree/feature-session",
      head: "def456",
      occupiedByOtherSession: true,
      occupiedBySessionIds: ["other-session"],
      diff: {
        changedFiles: 0,
        aheadCommits: 0,
        hasUncommittedChanges: false,
      },
    };

    const html = renderToStaticMarkup(
      <TooltipProvider>
        <WorkspaceRow
          row={row}
          current={{ root: "/repo", kind: "main" }}
          busy={null}
          onSwitch={() => {}}
          onCleanup={() => {}}
          cleanupMenuOpen
        />
      </TooltipProvider>,
    );

    const cleanupState = workspaceCleanupActionState(row);

    expect(html).toMatch(/占用中|Occupied/);
    expect(html).toMatch(/another session/i);
    expect(cleanupState).toEqual({
      reason: "This worktree is owned by another session. Cleanup is disabled.",
      detachDisabled: true,
      discardDisabled: true,
    });
  });
});

describe("WorkspaceIndicator", () => {
  test("rapid session switching keeps the latest workspace state", async () => {
    ensureMiniDom();
    const oldWorkspace: SessionWorkspace = {
      root: "/repo-old/.worktrees/old",
      kind: "worktree",
      worktree: {
        path: "/repo-old/.worktrees/old",
        branch: "worktree/old-session",
        baseRef: "main",
        createdBy: "codeshell",
      },
    };
    const newWorkspace: SessionWorkspace = {
      root: "/repo-new/.worktrees/new",
      kind: "worktree",
      worktree: {
        path: "/repo-new/.worktrees/new",
        branch: "worktree/new-session",
        baseRef: "main",
        createdBy: "codeshell",
      },
    };
    const responses: Array<ReturnType<typeof deferred<SessionWorkspace>>> = [];
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: () => {
        const next = deferred<SessionWorkspace>();
        responses.push(next);
        return next.promise;
      },
      listSessionWorktrees: async () => ({
        current: newWorkspace,
        mainRoot: "/repo-new",
        worktrees: [],
      }),
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <WorkspaceIndicator sessionId="old-session" repoPath="/repo-old" repoName="old" />,
      );
      await flushMicrotasks();
    });
    expect(responses).toHaveLength(1);

    await act(async () => {
      root?.render(
        <WorkspaceIndicator sessionId="new-session" repoPath="/repo-new" repoName="new" />,
      );
      await flushMicrotasks();
    });
    expect(responses).toHaveLength(2);

    await act(async () => {
      responses[1].resolve(newWorkspace);
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("worktree/new-session");

    await act(async () => {
      responses[0].resolve(oldWorkspace);
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("worktree/new-session");
    expect(textOf(container)).not.toContain("worktree/old-session");
  });
});

describe("TopBar workspace label", () => {
  test("does not repeat the repo name in the adjacent workspace chip", () => {
    const html = renderToStaticMarkup(
      <TopBar
        repoName="codeshell"
        repoPath="/repo/codeshell"
        sessionId="session"
        sessionTitle={null}
        busy={false}
        sidebarCollapsed={false}
        onToggleSidebar={() => {}}
        panelOpen={false}
        onTogglePanel={() => {}}
        isMac={false}
        isFullscreen={false}
      />,
    );

    expect(html).toContain("code-shell");
    expect(html).toContain("codeshell");
    expect(html).toContain("main");
    expect(html).not.toContain("main (codeshell)");
  });
});
