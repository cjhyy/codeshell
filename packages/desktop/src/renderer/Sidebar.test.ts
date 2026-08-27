import { afterEach, describe, expect, test } from "bun:test";
import React, { act, useState } from "react";
import { createRoot, type Root } from "react-dom/client";
import {
  formatRelative,
  ProjectGroup,
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
        getGitStatus: async () => ({ branch: "main" }),
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
});
