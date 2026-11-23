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
    resolveProjectRootById: (projectId: string, rootId: string) =>
      projectId === "p1" && rootId === "r1"
        ? { cwd: "/repo", trustCwd: "/repo", workspaceContext }
        : undefined,
    hasPersistedSessionCwd: (cwd: string) => cwd === "/legacy",
    isProjectTrusted: (cwd: string) => cwd === "/repo",
    isNoRepoCwd: (cwd: string) => cwd === "/no-repo",
    isDirectory: (cwd: string) => cwd !== "/deleted-project" && cwd !== "/deleted-session",
  };
}

describe("resolveAutomationWorkspace", () => {
  test("uses no-repo when a job has no cwd", async () => {
    const trustedNoRepoDeps = { ...deps(), isProjectTrusted: () => true };
    expect(await resolveAutomationWorkspace({}, trustedNoRepoDeps)).toEqual({
      cwd: "/no-repo",
      projectTrusted: false,
    });
    expect(await resolveAutomationWorkspace({ cwd: "/no-repo" }, trustedNoRepoDeps)).toEqual({
      cwd: "/no-repo",
      projectTrusted: false,
    });
  });

  test("folds git subdirectories and returns the project WorkspaceContext", async () => {
    expect(await resolveAutomationWorkspace({ cwd: "/repo/subdir" }, deps())).toEqual({
      cwd: "/repo",
      projectTrusted: true,
      workspaceContext,
    });
  });

  test("allows a persisted legacy Session cwd but stops unresolved paths", async () => {
    expect(await resolveAutomationWorkspace({ cwd: "/legacy" }, deps())).toEqual({
      cwd: "/legacy",
      projectTrusted: false,
    });
    expect(await resolveAutomationWorkspace({ cwd: "/removed" }, deps())).toBeNull();
  });

  test("stops permanently when a persisted Session cwd or project root was deleted", async () => {
    expect(
      await resolveAutomationWorkspace(
        { cwd: "/deleted-session" },
        {
          ...deps(),
          hasPersistedSessionCwd: (cwd) => cwd === "/deleted-session",
        },
      ),
    ).toBeNull();
    expect(
      await resolveAutomationWorkspace(
        { cwd: "/deleted-project" },
        {
          ...deps(),
          resolveProjectRoot: (cwd) =>
            cwd === "/deleted-project" ? { cwd, trustCwd: cwd, workspaceContext } : undefined,
        },
      ),
    ).toBeNull();
  });

  test("stops a legacy job before folding when its registered mount identity was replaced", async () => {
    let validated: string | undefined;
    expect(
      await resolveAutomationWorkspace(
        { cwd: "/retargeted-root" },
        {
          ...deps(),
          foldProjectRoot: () => "/outside",
          hasPersistedSessionCwd: (cwd) => cwd === "/outside",
          validatePersistedRoot: (cwd) => {
            validated = cwd;
            throw new Error("project root status root_replaced");
          },
        },
      ),
    ).toBeNull();
    expect(validated).toBe("/retargeted-root");
  });

  test("prefers stable ids, ignores stale cwd, and remains bound across make-primary", async () => {
    expect(
      await resolveAutomationWorkspace(
        { projectId: "p1", rootId: "r1", cwd: "/forged-or-old-primary" },
        deps(),
      ),
    ).toEqual({ cwd: "/repo", projectTrusted: true, workspaceContext });
  });

  test("invalid, cross-project, removed, or partial ids stop without legacy fallback", async () => {
    for (const job of [
      { projectId: "unknown", rootId: "r1", cwd: "/legacy" },
      { projectId: "p1", rootId: "foreign", cwd: "/legacy" },
      { projectId: "p1", cwd: "/legacy" },
      { rootId: "r1", cwd: "/legacy" },
    ]) {
      expect(await resolveAutomationWorkspace(job, deps())).toBeNull();
    }
    expect(
      await resolveAutomationWorkspace(
        { projectId: "p1", rootId: "r1" },
        { ...deps(), resolveProjectRootById: () => undefined },
      ),
    ).toBeNull();
  });
});
