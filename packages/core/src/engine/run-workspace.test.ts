import { describe, expect, test } from "bun:test";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { resolveRunWorkspace } from "./run-workspace.js";

const profile = { id: "test", disableWorkspaceProfile: true };

function manager(input?: {
  exists?: boolean;
  mainRoot?: string;
  binding?: { projectId: string; mainRootId: string };
  workspace?: { root: string; kind: "main" | "worktree" };
}) {
  return {
    exists: () => input?.exists === true,
    readSessionKind: () => "work",
    readSessionWorkspaceProfile: () => undefined,
    readSessionMainRoot: () => input?.mainRoot,
    readSessionProjectBinding: () => input?.binding,
    resolveSessionWorkspaceForResume: async () =>
      input?.workspace
        ? { ok: true as const, cwd: input.workspace.root, workspace: input.workspace, reason: input.workspace.kind }
        : { ok: true as const, cwd: input?.mainRoot ?? "/main", workspace: { root: input?.mainRoot ?? "/main", kind: "main" as const }, reason: "legacy" as const },
  };
}

function context(primaryPath: string, projectId = "project-1") {
  return createWorkspaceContext({
    projectId,
    projectRevision: 2,
    sessionMainRootId: "root-main",
    roots: [{ id: "root-main", path: primaryPath, role: "primary" }],
  });
}

async function resolve(options: Record<string, unknown>, session = manager()) {
  return resolveRunWorkspace({
    options: options as never,
    sessionManager: session as never,
    resolveBehaviorProfile: () => profile,
    configPermissionMode: "acceptEdits",
    configCwd: undefined,
    configWorkspaceContext: undefined,
    settings: {} as never,
    processCwd: "/process",
  });
}

describe("resolveRunWorkspace WorkspaceContext", () => {
  test("accepts an authoritative context whose primary is the effective cwd", async () => {
    const result = await resolve({ cwd: "/main", workspaceContext: context("/main") });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.workspaceContext.projectId).toBe("project-1");
      expect(result.resolution.authoritativeWorkspaceContext).toBe(true);
    }
  });

  test("fails closed when cwd or persisted binding disagrees", async () => {
    expect((await resolve({ cwd: "/other", workspaceContext: context("/main") })).ok).toBe(false);
    expect(
      (
        await resolve(
          { sessionId: "s-1", workspaceContext: context("/main", "project-2") },
          manager({
            exists: true,
            mainRoot: "/main",
            binding: { projectId: "project-1", mainRootId: "root-main" },
          }),
        )
      ).ok,
    ).toBe(false);
  });

  test("synthesizes a non-authoritative single-root context for legacy callers", async () => {
    const result = await resolve({ cwd: "/legacy" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.authoritativeWorkspaceContext).toBe(false);
      expect(result.resolution.workspaceContext.roots.map((root) => root.path)).toEqual(["/legacy"]);
    }
  });

  test("validates worktree contexts against the persisted workspace root", async () => {
    const result = await resolve(
      { sessionId: "s-1", cwd: "/stale-main", workspaceContext: context("/worktree") },
      manager({ exists: true, mainRoot: "/main", workspace: { root: "/worktree", kind: "worktree" } }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.cwd).toBe("/worktree");
  });
});
