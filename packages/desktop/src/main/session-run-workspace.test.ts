import { describe, expect, test } from "bun:test";
import { createWorkspaceContext } from "@cjhyy/code-shell-core/internal";
import type { AgentRunMetadataDeps } from "./agent-run-metadata.js";
import type { SessionCwdIndexEntry } from "./session-cwd-index.js";
import { resolveSessionRunWorkspace } from "./session-run-workspace.js";

function bound(sessionId: string, mainRootId: "a" | "b"): SessionCwdIndexEntry {
  return {
    sessionId,
    cwd: `/${mainRootId}`,
    projectId: "project",
    mainRootId,
    status: "confirmed",
  };
}

function fixture(entries = [bound("source", "a"), bound("target", "b")]) {
  const current = new Map(entries.map((entry) => [entry.sessionId, entry]));
  const cached = new Map(current);
  const resolved: Array<{ projectId: string; sessionId: string; session?: SessionCwdIndexEntry }> =
    [];
  const deps: AgentRunMetadataDeps = {
    lookupSession: (id, refresh) => (refresh ? current : cached).get(id),
    isProjectTrusted: (cwd) => cwd === "/b",
    resolveProjectRun: (projectId, sessionId, session, rootId) => {
      resolved.push({ projectId, sessionId, session });
      const mainRootId = session?.mainRootId ?? rootId ?? "a";
      const cwd = session?.workspaceRoot ?? session?.cwd ?? `/${mainRootId}`;
      return {
        cwd,
        trustCwd: `/${mainRootId}`,
        projectId,
        mainRootId,
        projectPrimaryRootId: "a",
        workspaceContext: createWorkspaceContext({
          projectId,
          projectRevision: 5,
          sessionMainRootId: mainRootId,
          roots: ["a", "b"].map((id) => ({
            id,
            path: id === mainRootId ? cwd : `/${id}`,
            role: id === mainRootId ? "primary" : "secondary",
          })),
        }),
      };
    },
  };
  const resolve = () =>
    resolveSessionRunWorkspace({ sourceSessionId: "source", targetSessionId: "target" }, deps);
  return { deps, current, cached, resolved, resolve };
}

describe("host resolution of cross-Session workspaces", () => {
  test("cold target uses its own main root and target-root trust", () => {
    const f = fixture();
    f.cached.clear();
    const result = f.resolve();
    expect(result).toMatchObject({
      cwd: "/b",
      projectTrusted: true,
      workspaceContext: { projectId: "project", sessionMainRootId: "b", projectRevision: 5 },
    });
    expect(result.workspaceContext?.roots).toEqual([
      { id: "a", path: "/a", role: "secondary" },
      { id: "b", path: "/b", role: "primary" },
    ]);
    expect(f.resolved[0]?.sessionId).toBe("target");
  });

  test("fresh persisted binding and worktree win over cached source-like metadata", () => {
    const f = fixture();
    f.cached.set("target", bound("target", "a"));
    f.current.set("target", { ...bound("target", "b"), workspaceRoot: "/worktrees/target" });
    f.current.set("source", { ...bound("source", "a"), workspaceRoot: "/worktrees/source" });
    expect(f.resolve()).toMatchObject({
      cwd: "/worktrees/target",
      projectTrusted: true,
      workspaceContext: {
        sessionMainRootId: "b",
        roots: [
          { id: "a", path: "/a", role: "secondary" },
          { id: "b", path: "/worktrees/target", role: "primary" },
        ],
      },
    });
  });

  test("a stale catalog cannot authorize a target migrated to another project", () => {
    const f = fixture();
    f.current.set("target", { ...bound("target", "b"), projectId: "foreign" });
    expect(f.resolve).toThrow("another project");
    expect(f.resolved).toHaveLength(0);
  });

  test("removed target and invalid Session id fail closed", () => {
    const f = fixture();
    f.current.delete("target");
    expect(f.resolve).toThrow("no longer available");
    expect(() =>
      resolveSessionRunWorkspace(
        { sourceSessionId: "source", targetSessionId: "../target" },
        f.deps,
      ),
    ).toThrow("invalid Session id");
  });

  test("planned target uses source's mounted main root, not its active worktree", () => {
    const f = fixture([{ ...bound("source", "b"), workspaceRoot: "/worktrees/source" }]);
    expect(f.resolve()).toMatchObject({ cwd: "/b", workspaceContext: { sessionMainRootId: "b" } });
    expect(f.resolved[0]?.session).toBeUndefined();
  });

  test("legacy target preserves its worktree without acquiring a project binding", () => {
    const f = fixture([
      bound("source", "a"),
      { sessionId: "target", cwd: "/a", workspaceRoot: "/legacy-worktree", status: "confirmed" },
    ]);
    expect(f.resolve()).toEqual({ cwd: "/legacy-worktree", projectTrusted: false });
    expect(f.resolved).toHaveLength(0);
  });

  test("planned legacy target stays legacy even if the root has since been registered", () => {
    const f = fixture([
      { sessionId: "source", cwd: "/a", workspaceRoot: "/source-worktree", status: "confirmed" },
    ]);
    f.deps.resolveExactRoot = () => {
      throw new Error("must not implicitly bind legacy Session");
    };
    expect(f.resolve()).toEqual({ cwd: "/a", projectTrusted: false });
  });

  test("unbound targets on unrelated roots are rejected", () => {
    const f = fixture([
      bound("source", "a"),
      { sessionId: "target", cwd: "/foreign", status: "confirmed" },
    ]);
    expect(f.resolve).toThrow("authorized main root");
  });
});
