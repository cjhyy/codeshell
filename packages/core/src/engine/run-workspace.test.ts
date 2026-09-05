import { describe, expect, test } from "bun:test";
import type { SessionWorkspaceResumeResolution } from "../session/session-manager.js";
import { createWorkspaceContext } from "../workspace/workspace-context.js";
import { resolveRunWorkspace } from "./run-workspace.js";

const profile = { id: "test", disableWorkspaceProfile: true };

function manager(input?: {
  exists?: boolean;
  mainRoot?: string;
  binding?: { projectId: string; mainRootId: string };
  workspace?: { root: string; kind: "main" | "worktree" };
  resume?: SessionWorkspaceResumeResolution;
}) {
  return {
    exists: () => input?.exists === true,
    readSessionKind: () => "work",
    readSessionWorkspaceProfile: () => undefined,
    readSessionMainRoot: () => input?.mainRoot,
    readSessionProjectBinding: () => input?.binding,
    resolveSessionWorkspaceForResume: async () =>
      input?.resume ??
      (input?.workspace
        ? {
            ok: true as const,
            cwd: input.workspace.root,
            workspace: input.workspace,
            reason: input.workspace.kind,
          }
        : {
            ok: true as const,
            cwd: input?.mainRoot ?? "/main",
            workspace: { root: input?.mainRoot ?? "/main", kind: "main" as const },
            reason: "legacy" as const,
          }),
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

  test("reports a bound session's missing context as a failed start", async () => {
    const result = await resolve(
      { sessionId: "s-bound", cwd: "/main" },
      manager({
        exists: true,
        mainRoot: "/main",
        binding: { projectId: "project-1", mainRootId: "root-main" },
      }),
    );

    expect(result).toEqual({
      ok: false,
      result: {
        text: "ERROR: bound Session requires an authoritative WorkspaceContext",
        reason: "model_error",
        sessionId: "s-bound",
        turnCount: 0,
        usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
      },
    });
  });

  test("reports invalid and mismatched contexts as initialization failures", async () => {
    const cases = [
      { cwd: "/main", workspaceContext: { ...context("/main"), roots: [] } },
      { cwd: "/other", workspaceContext: context("/main") },
      { cwd: "/main", workspaceContext: context("/main", "other-project") },
    ];

    for (const options of cases) {
      const result = await resolve(
        { sessionId: "s-1", ...options },
        manager({
          exists: true,
          mainRoot: "/main",
          binding: { projectId: "project-1", mainRootId: "root-main" },
        }),
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.result.reason).toBe("model_error");
        expect(result.result.text).toStartWith("ERROR:");
        expect(result.result.turnCount).toBe(0);
      }
    }
  });

  test.each([
    [false, "workspace_capability_unavailable", "Install the matching workspace capability."],
    [false, "worktree_missing_branch_exists", "Recreate the missing worktree before resuming."],
    [true, "worktree_missing_branch_gone", "Fell back to main. Re-run the request to continue."],
  ] as const)(
    "reports a blocked workspace resume (%s, %s) as a failed start",
    async (ok, reason, message) => {
      const result = await resolve(
        { sessionId: "s-worktree" },
        manager({
          exists: true,
          resume: {
            ok,
            reason,
            message,
            cwd: "/main",
            workspace: { root: "/main", kind: "main" },
          } as SessionWorkspaceResumeResolution,
        }),
      );

      expect(result).toEqual({
        ok: false,
        result: {
          text: `ERROR: ${message}`,
          reason: "model_error",
          sessionId: "s-worktree",
          turnCount: 0,
          usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 },
        },
      });
    },
  );

  test("synthesizes a non-authoritative single-root context for legacy callers", async () => {
    const result = await resolve({ cwd: "/legacy" });
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.resolution.authoritativeWorkspaceContext).toBe(false);
      expect(result.resolution.workspaceContext.roots.map((root) => root.path)).toEqual([
        "/legacy",
      ]);
    }
  });

  test("validates worktree contexts against the persisted workspace root", async () => {
    const result = await resolve(
      { sessionId: "s-1", cwd: "/stale-main", workspaceContext: context("/worktree") },
      manager({
        exists: true,
        mainRoot: "/main",
        workspace: { root: "/worktree", kind: "worktree" },
      }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.resolution.cwd).toBe("/worktree");
  });
});
