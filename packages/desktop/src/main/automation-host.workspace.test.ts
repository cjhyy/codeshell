import { describe, expect, test } from "bun:test";
import { createWorkspaceContext } from "@cjhyy/code-shell-core/internal";
import { resolveAutomationWorkspace } from "./automation-host.js";

const workspaceContext = createWorkspaceContext({
  projectId: "p1",
  projectRevision: 1,
  sessionMainRootId: "r1",
  roots: [{ id: "r1", path: "/repo", role: "primary" }],
});

function deps() {
  return {
    noRepoCwd: () => "/no-repo",
    foldProjectRoot: (cwd: string) => (cwd === "/repo/subdir" ? "/repo" : cwd),
    resolveProjectRoot: (cwd: string) =>
      cwd === "/repo" ? { cwd: "/repo", trustCwd: "/repo", workspaceContext } : undefined,
    hasPersistedSessionCwd: (cwd: string) => cwd === "/legacy",
    isProjectTrusted: (cwd: string) => cwd === "/repo",
    isNoRepoCwd: (cwd: string) => cwd === "/no-repo",
    isDirectory: (cwd: string) => cwd !== "/deleted-project" && cwd !== "/deleted-session",
  };
}

describe("resolveAutomationWorkspace", () => {
  test("uses no-repo when a job has no cwd", () => {
    const trustedNoRepoDeps = { ...deps(), isProjectTrusted: () => true };
    expect(resolveAutomationWorkspace(undefined, trustedNoRepoDeps)).toEqual({
      cwd: "/no-repo",
      projectTrusted: false,
    });
    expect(resolveAutomationWorkspace("/no-repo", trustedNoRepoDeps)).toEqual({
      cwd: "/no-repo",
      projectTrusted: false,
    });
  });

  test("folds git subdirectories and returns the project WorkspaceContext", () => {
    expect(resolveAutomationWorkspace("/repo/subdir", deps())).toEqual({
      cwd: "/repo",
      projectTrusted: true,
      workspaceContext,
    });
  });

  test("allows a persisted legacy Session cwd but stops unresolved paths", () => {
    expect(resolveAutomationWorkspace("/legacy", deps())).toEqual({
      cwd: "/legacy",
      projectTrusted: false,
    });
    expect(resolveAutomationWorkspace("/removed", deps())).toBeNull();
  });

  test("stops permanently when a persisted Session cwd or project root was deleted", () => {
    expect(
      resolveAutomationWorkspace("/deleted-session", {
        ...deps(),
        hasPersistedSessionCwd: (cwd) => cwd === "/deleted-session",
      }),
    ).toBeNull();
    expect(
      resolveAutomationWorkspace("/deleted-project", {
        ...deps(),
        resolveProjectRoot: (cwd) =>
          cwd === "/deleted-project" ? { cwd, trustCwd: cwd, workspaceContext } : undefined,
      }),
    ).toBeNull();
  });
});
