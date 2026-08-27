import { afterEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  formatRelative,
  ProjectGroup,
  sessionMainRootLabel,
  sessionHoverBranch,
  shouldPromptForPrimaryTrust,
  worktreeBranchOf,
} from "./Sidebar";
import { ensureMiniDom, flushMicrotasks } from "./test-utils/renderHook";
import type { TrackedProject } from "./projects";
import type { SessionIndex } from "./transcripts";

function reactPropsOf(node: unknown): Record<string, any> {
  const current = node as Record<string, any>;
  const key = Object.keys(current).find((name) => name.startsWith("__reactProps$"));
  return key ? current[key] : {};
}

function findElements(node: unknown, tagName: string): any[] {
  const current = node as { tagName?: string; childNodes?: unknown[] };
  return [
    ...(current.tagName === tagName ? [current] : []),
    ...(current.childNodes ?? []).flatMap((child) => findElements(child, tagName)),
  ];
}

function reactChildText(value: unknown): string {
  if (typeof value === "string" || typeof value === "number") return String(value);
  if (Array.isArray(value)) return value.map(reactChildText).join("");
  if (value && typeof value === "object" && "props" in value) {
    return reactChildText((value as { props?: { children?: unknown } }).props?.children);
  }
  return "";
}

function buttonWithText(container: HTMLElement, text: string): any {
  return findElements(container, "BUTTON").find(
    (button) => reactChildText(reactPropsOf(button).children) === text,
  );
}

const project: TrackedProject = {
  id: "project-1",
  name: "Project",
  path: "/repo",
  roots: [{ id: "root-1", path: "/repo", name: "repo", addedAt: 1 }],
  primaryRootId: "root-1",
  addedAt: 1,
};

const sessionIndex: SessionIndex = {
  sessions: Array.from({ length: 8 }, (_, index) => ({
    id: `session-${index + 1}`,
    title: `Session ${index + 1}`,
    createdAt: index + 1,
    updatedAt: index + 1,
  })),
  activeSessionId: null,
};

let root: Root | null = null;

afterEach(async () => {
  if (root) {
    await act(async () => {
      root?.unmount();
      await flushMicrotasks();
    });
  }
  root = null;
});

function ProjectGroupHarness() {
  const [collapsed, setCollapsed] = useState(false);
  return React.createElement(ProjectGroup, {
    project,
    index: sessionIndex,
    collapsed,
    isActiveProject: false,
    activeSessionId: null,
    statusFor: () => undefined,
    onToggle: () => setCollapsed((current) => !current),
    onSelectProject: () => undefined,
    onSelectSession: () => undefined,
    onMenuClick: () => undefined,
    onNewChat: () => undefined,
    onProjectContextMenu: () => undefined,
    onSessionContextMenu: () => undefined,
    onPinSession: () => undefined,
    onArchiveSession: () => undefined,
    workspaceChange: null,
  });
}

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

  test("uses the Session main-root label instead of the project's new primary", () => {
    const switched: TrackedProject = {
      id: "project-1",
      name: "Project",
      path: "/notes",
      roots: [
        { id: "old-main", path: "/repo", name: "repo", addedAt: 1 },
        { id: "new-primary", path: "/notes", name: "notes", addedAt: 2 },
      ],
      primaryRootId: "new-primary",
      addedAt: 1,
    };

    expect(
      sessionMainRootLabel(switched, {
        mainRootId: "old-main",
        mainRootName: "repo",
      }),
    ).toBe("repo");
  });
});

describe("Sidebar project root trust", () => {
  test("requires TrustGate again for unknown and explicitly untrusted secondary roots", () => {
    expect(shouldPromptForPrimaryTrust("trusted")).toBe(false);
    expect(shouldPromptForPrimaryTrust("unknown")).toBe(true);
    expect(shouldPromptForPrimaryTrust("untrusted")).toBe(true);
  });
});

describe("Sidebar project session visibility", () => {
  test("returns to the compact session list after the project is closed and reopened", async () => {
    ensureMiniDom();
    Object.assign(window, {
      codeshell: {
        getProjectGitStatus: async () => ({ branch: "main" }),
      },
    });

    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);
    await act(async () => {
      root?.render(React.createElement(ProjectGroupHarness));
      await flushMicrotasks();
    });

    expect(buttonWithText(container, "Session 4")).toBeDefined();
    expect(buttonWithText(container, "Session 3")).toBeUndefined();
    expect(buttonWithText(container, "展开显示3")).toBeDefined();

    await act(async () => {
      reactPropsOf(buttonWithText(container, "展开显示3")).onClick();
      await flushMicrotasks();
    });
    expect(buttonWithText(container, "Session 1")).toBeDefined();
    expect(buttonWithText(container, "展开显示3")).toBeUndefined();

    await act(async () => {
      reactPropsOf(buttonWithText(container, "Project")).onClick();
      await flushMicrotasks();
    });
    expect(buttonWithText(container, "Session 8")).toBeUndefined();

    await act(async () => {
      reactPropsOf(buttonWithText(container, "Project")).onClick();
      await flushMicrotasks();
    });
    expect(buttonWithText(container, "Session 4")).toBeDefined();
    expect(buttonWithText(container, "Session 3")).toBeUndefined();
    expect(buttonWithText(container, "展开显示3")).toBeDefined();
  });

  test("probes an old Session's Git branch through the Session-scoped API", async () => {
    ensureMiniDom();
    const calls: string[] = [];
    Object.assign(window, {
      codeshell: {
        getSessionWorkspaceAuthority: async (sessionId: string) => {
          calls.push(`authority:${sessionId}`);
          return {
            workspace: { root: "/repo", kind: "main" },
            projectId: "project-1",
            mainRootId: "root-1",
            mainRoot: "/repo",
            mainRootName: "repo",
            rootStatus: "ok",
          };
        },
        getSessionGitStatus: async (sessionId: string) => {
          calls.push(`git:${sessionId}`);
          return { branch: "old-main", entries: [], clean: true };
        },
        getProjectGitStatus: async () => {
          calls.push("generic-git");
          return { branch: "new-primary", entries: [], clean: true };
        },
      },
    });
    const boundIndex: SessionIndex = {
      sessions: [
        {
          id: "ui-session",
          engineSessionId: "engine-old",
          title: "Old Session",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeSessionId: null,
    };
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(ProjectGroup, {
          project,
          index: boundIndex,
          collapsed: false,
          isActiveProject: false,
          activeSessionId: null,
          statusFor: () => undefined,
          onToggle: () => undefined,
          onSelectProject: () => undefined,
          onSelectSession: () => undefined,
          onMenuClick: () => undefined,
          onNewChat: () => undefined,
          onProjectContextMenu: () => undefined,
          onSessionContextMenu: () => undefined,
          onPinSession: () => undefined,
          onArchiveSession: () => undefined,
          workspaceChange: null,
        }),
      );
      await flushMicrotasks();
    });

    expect(calls).toContain("authority:engine-old");
    expect(calls).toContain("git:engine-old");
  });

  test("shows a root_removed badge and repairs through sessionId plus Main-resolved targetRootId", async () => {
    ensureMiniDom();
    const calls: unknown[][] = [];
    const multiRootProject: TrackedProject = {
      ...project,
      path: "/current-primary",
      roots: [
        { id: "root-primary", path: "/current-primary", name: "current-primary", addedAt: 1 },
        { id: "root-other", path: "/other", name: "other", addedAt: 2 },
      ],
      primaryRootId: "root-primary",
    };
    Object.assign(window, {
      codeshell: {
        getProjectGitStatus: async () => ({ branch: "main", entries: [], clean: true }),
        getSessionWorkspaceAuthority: async (sessionId: string) =>
          sessionId === "engine-missing-dir"
            ? {
                workspace: { root: "/other", kind: "main" },
                projectId: project.id,
                mainRootId: "root-other",
                mainRoot: "/other",
                mainRootName: "other",
                rootStatus: "dir_missing",
                rootStatusReason: "directory_missing",
                rootStatusMessage: "Session main root directory is missing",
              }
            : {
                workspace: { root: "/removed", kind: "main" },
                projectId: project.id,
                mainRootId: "root-removed",
                mainRoot: "/removed",
                mainRootName: "removed",
                rootStatus: "root_removed",
                rootStatusReason: "root_not_mounted",
                rootStatusMessage: "Session main root is no longer mounted",
              },
        getSessionGitStatus: async () => {
          throw new Error("missing roots must not reach Git");
        },
        projectRegistry: {
          migrateSessionMainRoot: async (sessionId: string, targetRootId: string) => {
            calls.push([sessionId, targetRootId]);
          },
        },
      },
    });
    const index: SessionIndex = {
      sessions: [
        {
          id: "ui-session-dir",
          engineSessionId: "engine-missing-dir",
          title: "Missing Directory Session",
          createdAt: 2,
          updatedAt: 2,
        },
        {
          id: "ui-session",
          engineSessionId: "engine-missing",
          title: "Missing Session",
          createdAt: 1,
          updatedAt: 1,
        },
      ],
      activeSessionId: null,
    };
    const container = document.createElement("div") as unknown as HTMLElement;
    root = createRoot(container);

    await act(async () => {
      root?.render(
        React.createElement(ProjectGroup, {
          project: multiRootProject,
          index,
          collapsed: false,
          isActiveProject: false,
          activeSessionId: null,
          statusFor: () => undefined,
          onToggle: () => undefined,
          onSelectProject: () => undefined,
          onSelectSession: () => undefined,
          onMenuClick: () => undefined,
          onNewChat: () => undefined,
          onProjectContextMenu: () => undefined,
          onSessionContextMenu: () => undefined,
          onPinSession: () => undefined,
          onArchiveSession: () => undefined,
          workspaceChange: null,
        }),
      );
      await flushMicrotasks();
    });

    expect(
      findElements(container, "SPAN").some(
        (span) => reactPropsOf(span)["data-session-root-status"] === "root_removed",
      ),
    ).toBe(true);
    expect(
      findElements(container, "SPAN").some(
        (span) => reactPropsOf(span)["data-session-root-status"] === "dir_missing",
      ),
    ).toBe(true);
    const repair = buttonWithText(container, "修复");
    expect(repair).toBeDefined();
    await act(async () => {
      reactPropsOf(repair).onClick({ stopPropagation: () => undefined });
      await flushMicrotasks();
    });
    expect(calls).toEqual([["engine-missing-dir", "root-primary"]]);
  });
});
