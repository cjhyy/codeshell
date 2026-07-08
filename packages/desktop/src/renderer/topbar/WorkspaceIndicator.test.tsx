import { afterEach, describe, expect, mock, test } from "bun:test";
import React, { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { TooltipProvider } from "../components/ui/tooltip";
import { translate, type TFunction } from "../i18n";
import { ensureMiniDom, flushMicrotasks } from "../test-utils/renderHook";
import { ToastProvider } from "../ui/ToastProvider";
import type {
  SessionWorkspace,
  SessionWorkspaceList,
  SessionWorkspaceWorktreeInfo,
} from "../../preload/types";

const PopoverTestContext = React.createContext<{
  open: boolean;
  onOpenChange?: (open: boolean) => void;
}>({ open: false });

mock.module("../components/ui/popover", () => ({
  Popover({
    open = false,
    onOpenChange,
    children,
  }: {
    open?: boolean;
    onOpenChange?: (open: boolean) => void;
    children: React.ReactNode;
  }) {
    return (
      <PopoverTestContext.Provider value={{ open, onOpenChange }}>
        {children}
      </PopoverTestContext.Provider>
    );
  },
  PopoverTrigger({
    asChild,
    children,
  }: {
    asChild?: boolean;
    children: React.ReactElement<Record<string, unknown>>;
  }) {
    const { open, onOpenChange } = React.useContext(PopoverTestContext);
    const onClick = (event: unknown) => {
      if (React.isValidElement(children) && typeof children.props.onClick === "function") {
        children.props.onClick(event);
      }
      onOpenChange?.(!open);
    };
    if (asChild && React.isValidElement(children)) {
      return React.cloneElement(children, { "aria-expanded": open, onClick });
    }
    return (
      <button type="button" aria-expanded={open} onClick={onClick}>
        {children}
      </button>
    );
  },
  PopoverContent: React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
    ({ children, ...props }, ref) => {
      const { open } = React.useContext(PopoverTestContext);
      if (!open) return null;
      return (
        <div ref={ref} {...props}>
          {children}
        </div>
      );
    },
  ),
}));

const {
  WorkspaceIndicator,
  WorkspaceRow,
  formatWorkspaceDiffSummary,
  workspaceCleanupActionState,
  workspaceCleanupDisabledReason,
  workspaceIndicatorText,
  workspaceIsExternal,
  workspaceRowDisabledReason,
} = await import("./WorkspaceIndicator");
const { TopBar } = await import("../TopBar");

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

function findElement(
  node: unknown,
  predicate: (node: { tagName?: string; childNodes?: unknown[] }) => boolean,
): { tagName?: string; childNodes?: unknown[] } | null {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  if (predicate(current)) return current;
  for (const child of current.childNodes ?? []) {
    const found = findElement(child, predicate);
    if (found) return found;
  }
  return null;
}

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function clickHostNode(node: unknown): void {
  const props = reactPropsOf(node);
  props.onClick?.({
    type: "click",
    defaultPrevented: false,
    preventDefault() {
      this.defaultPrevented = true;
    },
    stopPropagation() {},
    target: node,
    currentTarget: node,
  });
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
    expect(formatWorkspaceDiffSummary(undefined, t)).toBe("checking…");
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

  test("marks explicit non-managed and detached rows as external", () => {
    expect(
      workspaceIsExternal({
        path: "/repo/.worktrees/external",
        branch: "external/feature",
        head: "abc123",
        isManaged: false,
      }),
    ).toBe(true);
    expect(
      workspaceCleanupDisabledReason({
        path: "/repo/.worktrees/external",
        branch: "external/feature",
        head: "abc123",
        isManaged: false,
      }),
    ).toMatch(/not managed/i);
    expect(
      workspaceIsExternal({
        path: "/repo/.worktrees/detached",
        branch: "",
        head: "abc123",
        isManaged: true,
      }),
    ).toBe(true);
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
    expect(html).toMatch(/another session|另一个会话/i);
    expect(cleanupState).toEqual({
      reason: "This worktree is owned by another session. Cleanup is disabled.",
      detachDisabled: true,
      discardDisabled: true,
    });
  });

  test("renders external badge and disables cleanup actions", () => {
    const row: SessionWorkspaceWorktreeInfo = {
      path: "/repo/.worktrees/external",
      branch: "external/feature",
      head: "def456",
      isManaged: false,
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

    expect(html).toMatch(/外部|External/);
    expect(html).toMatch(/Not managed by CodeShell|非 CodeShell 管理/);
    expect(cleanupState.detachDisabled).toBe(true);
    expect(cleanupState.discardDisabled).toBe(true);
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

  test("list loading clears when a current refresh starts during a list refresh", async () => {
    ensureMiniDom();
    const mainWorkspace: SessionWorkspace = { root: "/repo", kind: "main" };
    const currentWorkspace: SessionWorkspace = {
      root: "/repo/.worktrees/current",
      kind: "worktree",
      worktree: {
        path: "/repo/.worktrees/current",
        branch: "worktree/current-session",
        baseRef: "main",
        createdBy: "codeshell",
      },
    };
    const listResponse: SessionWorkspaceList = {
      current: mainWorkspace,
      mainRoot: "/repo",
      worktrees: [
        {
          path: "/repo",
          branch: "main",
          head: "abc123",
          isMain: true,
        },
        {
          path: "/repo/.worktrees/feature",
          branch: "worktree/feature-session",
          head: "def456",
          isMain: false,
        },
      ],
    };
    const currentResponses: Array<ReturnType<typeof deferred<SessionWorkspace>>> = [];
    const listResponses: Array<ReturnType<typeof deferred<SessionWorkspaceList>>> = [];
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: () => {
        const next = deferred<SessionWorkspace>();
        currentResponses.push(next);
        return next.promise;
      },
      listSessionWorktrees: () => {
        const next = deferred<SessionWorkspaceList>();
        listResponses.push(next);
        return next.promise;
      },
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <WorkspaceIndicator
          sessionId="current-session"
          repoPath="/repo"
          repoName="repo"
          sessionBusy={false}
        />,
      );
      await flushMicrotasks();
    });
    expect(currentResponses).toHaveLength(1);

    await act(async () => {
      currentResponses[0].resolve(mainWorkspace);
      await flushMicrotasks();
    });

    const trigger = findElement(container, (node) => node.tagName === "BUTTON");
    expect(trigger).not.toBeNull();
    await act(async () => {
      clickHostNode(trigger);
      await flushMicrotasks();
    });
    expect(listResponses).toHaveLength(1);
    expect(textOf(container)).toContain(translate("zh", "topbar.workspace.loading"));

    await act(async () => {
      root?.render(
        <WorkspaceIndicator
          sessionId="current-session"
          repoPath="/repo"
          repoName="repo"
          sessionBusy
        />,
      );
      await flushMicrotasks();
    });
    expect(currentResponses).toHaveLength(2);

    await act(async () => {
      listResponses[0].resolve(listResponse);
      await flushMicrotasks();
    });

    expect(textOf(container)).not.toContain(translate("zh", "topbar.workspace.loading"));
    expect(textOf(container)).toContain("worktree/feature-session");

    await act(async () => {
      currentResponses[1].resolve(currentWorkspace);
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("worktree/current-session");
  });

  test("renders fast rows with checking placeholder and fills diff asynchronously", async () => {
    ensureMiniDom();
    const mainWorkspace: SessionWorkspace = { root: "/repo", kind: "main" };
    const listResponse: SessionWorkspaceList = {
      current: mainWorkspace,
      mainRoot: "/repo",
      worktrees: [
        {
          path: "/repo/.worktrees/feature",
          branch: "worktree/feature-session",
          head: "def456",
          isMain: false,
          isManaged: true,
        },
      ],
    };
    const diffResponse = deferred<SessionWorkspaceWorktreeInfo["diff"]>();
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: async () => mainWorkspace,
      listSessionWorktrees: async () => listResponse,
      getSessionWorktreeDiff: () => diffResponse.promise,
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(<WorkspaceIndicator sessionId="session" repoPath="/repo" repoName="repo" />);
      await flushMicrotasks();
    });
    const trigger = findElement(container, (node) => node.tagName === "BUTTON");
    expect(trigger).not.toBeNull();

    await act(async () => {
      clickHostNode(trigger);
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("worktree/feature-session");
    expect(textOf(container)).toContain("checking…");
    expect(textOf(container)).not.toMatch(/Dirty|未提交/);

    await act(async () => {
      diffResponse.resolve({
        changedFiles: 2,
        aheadCommits: 1,
        hasUncommittedChanges: true,
      });
      await flushMicrotasks();
    });

    expect(textOf(container)).toMatch(/Dirty|未提交/);
    expect(textOf(container)).toMatch(/2 files|2 文件/);
    expect(textOf(container)).toMatch(/ahead 1|领先 1/);
  });

  test("does not toast when an unmounted list request rejects", async () => {
    ensureMiniDom();
    const mainWorkspace: SessionWorkspace = { root: "/repo", kind: "main" };
    const listResponse = deferred<SessionWorkspaceList>();
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: async () => mainWorkspace,
      listSessionWorktrees: () => listResponse.promise,
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ToastProvider>
          <WorkspaceIndicator sessionId="session" repoPath="/repo" repoName="repo" />
        </ToastProvider>,
      );
      await flushMicrotasks();
    });
    const trigger = findElement(container, (node) => node.tagName === "BUTTON");
    expect(trigger).not.toBeNull();

    await act(async () => {
      clickHostNode(trigger);
      await flushMicrotasks();
    });

    await act(async () => {
      root?.render(
        <ToastProvider>
          <div />
        </ToastProvider>,
      );
      await flushMicrotasks();
    });

    await act(async () => {
      listResponse.reject(new Error("cancelled by unmount"));
      await flushMicrotasks();
    });

    expect(textOf(container)).not.toContain("Workspace action failed");
    expect(textOf(container)).not.toContain("工作区操作失败");
  });

  test("ignores a stale list rejection after the session and repo change", async () => {
    ensureMiniDom();
    const listResponses: Array<
      ReturnType<typeof deferred<SessionWorkspaceList>> & { sessionId: string; cwd: string }
    > = [];
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: async (_sessionId: string, cwd: string) => ({ root: cwd, kind: "main" }),
      listSessionWorktrees: (sessionId: string, cwd: string) => {
        const next = deferred<SessionWorkspaceList>();
        listResponses.push({ ...next, sessionId, cwd });
        return next.promise;
      },
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(
        <ToastProvider>
          <WorkspaceIndicator sessionId="old-session" repoPath="/repo-old" repoName="old" />
        </ToastProvider>,
      );
      await flushMicrotasks();
    });

    const trigger = findElement(container, (node) => node.tagName === "BUTTON");
    expect(trigger).not.toBeNull();
    await act(async () => {
      clickHostNode(trigger);
      await flushMicrotasks();
    });
    expect(listResponses).toHaveLength(1);

    await act(async () => {
      root?.render(
        <ToastProvider>
          <WorkspaceIndicator sessionId="new-session" repoPath="/repo-new" repoName="new" />
        </ToastProvider>,
      );
      await flushMicrotasks();
    });
    expect(listResponses).toHaveLength(2);

    await act(async () => {
      listResponses[0].reject(new Error("old list failed"));
      await flushMicrotasks();
    });

    await act(async () => {
      listResponses[1].resolve({
        current: { root: "/repo-new", kind: "main" },
        mainRoot: "/repo-new",
        worktrees: [
          {
            path: "/repo-new/.worktrees/new",
            branch: "worktree/new-session",
            head: "def456",
            isManaged: true,
          },
        ],
      });
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("worktree/new-session");
    expect(textOf(container)).not.toContain("old list failed");
    expect(textOf(container)).not.toContain("Workspace action failed");
    expect(textOf(container)).not.toContain("工作区操作失败");
  });

  test("clears old rows and ignores stale diff after the session changes", async () => {
    ensureMiniDom();
    const newList = deferred<SessionWorkspaceList>();
    const diffResponses: Array<
      ReturnType<typeof deferred<SessionWorkspaceWorktreeInfo["diff"]>> & {
        sessionId: string;
        path: string;
      }
    > = [];
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: async (_sessionId: string, cwd: string) => ({ root: cwd, kind: "main" }),
      listSessionWorktrees: (sessionId: string) => {
        if (sessionId === "old-session") {
          return Promise.resolve({
            current: { root: "/repo", kind: "main" },
            mainRoot: "/repo",
            worktrees: [
              {
                path: "/repo/.worktrees/shared",
                branch: "worktree/old-session",
                head: "abc123",
                isManaged: true,
              },
            ],
          } satisfies SessionWorkspaceList);
        }
        return newList.promise;
      },
      getSessionWorktreeDiff: (sessionId: string, path: string) => {
        const next = deferred<SessionWorkspaceWorktreeInfo["diff"]>();
        diffResponses.push({ ...next, sessionId, path });
        return next.promise;
      },
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(<WorkspaceIndicator sessionId="old-session" repoPath="/repo" repoName="repo" />);
      await flushMicrotasks();
    });
    const trigger = findElement(container, (node) => node.tagName === "BUTTON");
    expect(trigger).not.toBeNull();

    await act(async () => {
      clickHostNode(trigger);
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("worktree/old-session");
    expect(diffResponses).toHaveLength(1);

    await act(async () => {
      root?.render(<WorkspaceIndicator sessionId="new-session" repoPath="/repo" repoName="repo" />);
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toContain("worktree/old-session");

    await act(async () => {
      diffResponses[0].resolve({
        changedFiles: 9,
        aheadCommits: 3,
        hasUncommittedChanges: true,
      });
      await flushMicrotasks();
    });
    expect(textOf(container)).not.toMatch(/Dirty|未提交/);
    expect(textOf(container)).not.toMatch(/9 files|9 文件/);

    await act(async () => {
      newList.resolve({
        current: { root: "/repo", kind: "main" },
        mainRoot: "/repo",
        worktrees: [
          {
            path: "/repo/.worktrees/shared",
            branch: "worktree/new-session",
            head: "def456",
            isManaged: true,
          },
        ],
      });
      await flushMicrotasks();
    });

    expect(textOf(container)).toContain("worktree/new-session");
    expect(textOf(container)).not.toContain("worktree/old-session");
  });

  test("refreshes the current workspace when workspace:changed targets this session", async () => {
    ensureMiniDom();
    let changed: ((event: { sessionId: string }) => void) | undefined;
    let currentCalls = 0;
    const workspaces: SessionWorkspace[] = [
      { root: "/repo", kind: "main" },
      {
        root: "/repo/.worktrees/feature",
        kind: "worktree",
        worktree: {
          path: "/repo/.worktrees/feature",
          branch: "worktree/feature",
          baseRef: "main",
          createdBy: "codeshell",
        },
      },
    ];
    (window as unknown as { codeshell: Record<string, unknown> }).codeshell = {
      getSessionWorkspace: async () => workspaces[Math.min(currentCalls++, workspaces.length - 1)]!,
      listSessionWorktrees: async () => ({
        current: workspaces[Math.min(currentCalls, workspaces.length - 1)]!,
        mainRoot: "/repo",
        worktrees: [],
      }),
      getSessionWorktreeDiff: async () => undefined,
      onWorkspaceChanged: (cb: (event: { sessionId: string }) => void) => {
        changed = cb;
        return () => {
          changed = undefined;
        };
      },
    };
    const container = document.createElement("div");
    root = createRoot(container);

    await act(async () => {
      root?.render(<WorkspaceIndicator sessionId="session" repoPath="/repo" repoName="repo" />);
      await flushMicrotasks();
    });
    expect(textOf(container)).toContain("main");
    expect(currentCalls).toBe(1);

    await act(async () => {
      changed?.({ sessionId: "other-session" });
      await flushMicrotasks();
    });
    expect(currentCalls).toBe(1);

    await act(async () => {
      changed?.({ sessionId: "session" });
      await flushMicrotasks();
    });

    expect(currentCalls).toBe(2);
    expect(textOf(container)).toContain("worktree/feature");
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
