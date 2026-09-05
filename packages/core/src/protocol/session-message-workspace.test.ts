import { describe, expect, test } from "bun:test";
import type { SessionProjectBinding, SessionWorkspace } from "../types.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { resolveSessionMessageWorkspace } from "./session-message-workspace.js";

function fixture() {
  const roots = new Map([
    ["source", "/a"],
    ["target", "/b"],
  ]);
  const bindings = new Map<string, SessionProjectBinding>([
    ["source", { projectId: "project", mainRootId: "a" }],
    ["target", { projectId: "project", mainRootId: "b" }],
  ]);
  const workspaces = new Map<string, SessionWorkspace>();
  const sourceWorkspace = {
    cwd: "/source-worktree",
    projectTrusted: true,
    workspaceContext: createWorkspaceContext({
      projectId: "project",
      projectRevision: 3,
      sessionMainRootId: "a",
      roots: [
        { id: "a", path: "/source-worktree", role: "primary" },
        { id: "b", path: "/b", role: "secondary" },
      ],
    }),
  };
  const input = {
    sourceSessionId: "source",
    targetSessionId: "target",
    sourceWorkspace,
    sessionManager: {
      readSessionMainRoot: (id: string) => roots.get(id),
      readSessionProjectBinding: (id: string) => bindings.get(id),
      getSessionWorkspace: (id: string) => workspaces.get(id),
    },
  };
  return {
    roots,
    bindings,
    workspaces,
    input,
    resolve: () => resolveSessionMessageWorkspace(input),
  };
}

describe("protocol-only cross-Session workspace resolution", () => {
  test("a cold bound target selects its own mounted root", () => {
    const f = fixture();
    expect(f.resolve()).toMatchObject({
      cwd: "/b",
      projectTrusted: false,
      workspaceContext: {
        sessionMainRootId: "b",
        roots: [
          { id: "a", path: "/a", role: "secondary" },
          { id: "b", path: "/b", role: "primary" },
        ],
      },
    });
    expect(f.input.sourceWorkspace.workspaceContext.roots[0]?.path).toBe("/source-worktree");
  });

  test("target worktree comes from persisted workspace and source worktree is not propagated", () => {
    const f = fixture();
    f.workspaces.set("target", { kind: "worktree", root: "/target-worktree" });
    const result = f.resolve();
    expect(result.cwd).toBe("/target-worktree");
    expect(result.workspaceContext?.roots).toEqual([
      { id: "a", path: "/a", role: "secondary" },
      { id: "b", path: "/target-worktree", role: "primary" },
    ]);
  });

  test("foreign project and removed or remapped mounts fail closed", () => {
    const f = fixture();
    f.bindings.set("target", { projectId: "foreign", mainRootId: "b" });
    expect(f.resolve).toThrow("not authorized");
    f.bindings.set("target", { projectId: "project", mainRootId: "removed" });
    expect(f.resolve).toThrow("host-authorized project roots");
    f.bindings.set("target", { projectId: "project", mainRootId: "b" });
    f.roots.set("target", "/remapped-b");
    expect(f.resolve).toThrow("host-authorized project roots");
  });

  test("missing or mismatched source context cannot mint target authority", () => {
    const f = fixture();
    expect(() =>
      resolveSessionMessageWorkspace({ ...f.input, sourceWorkspace: { cwd: "/a" } }),
    ).toThrow("authoritative WorkspaceContext");
    f.bindings.set("source", { projectId: "project", mainRootId: "wrong-root" });
    expect(f.resolve).toThrow("source WorkspaceContext");
  });

  test("legacy target preserves its persisted workspace without gaining a binding", () => {
    const f = fixture();
    f.bindings.delete("target");
    f.roots.set("target", "/a");
    f.workspaces.set("target", { kind: "worktree", root: "/legacy-worktree" });
    expect(f.resolve()).toEqual({ cwd: "/legacy-worktree", projectTrusted: true });
    f.roots.set("target", "/elsewhere");
    expect(f.resolve).toThrow("authorized main root");
  });

  test("planned target uses the source main mount without inheriting its worktree", () => {
    const f = fixture();
    f.roots.delete("target");
    f.bindings.delete("target");
    expect(f.resolve()).toMatchObject({ cwd: "/a", workspaceContext: { sessionMainRootId: "a" } });
    f.bindings.delete("source");
    expect(f.resolve()).toEqual({ cwd: "/a", projectTrusted: true });
  });
});
