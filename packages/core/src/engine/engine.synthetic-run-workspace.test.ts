import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createWorkspaceContext, workspacePrimaryRoot } from "../workspace/workspace-context.js";
import { Engine } from "./engine.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Engine synthetic run workspace", () => {
  test("rebases a bound Session's main-root authority onto its persisted worktree", () => {
    const fixture = mkdtempSync(join(tmpdir(), "codeshell-synthetic-workspace-"));
    dirs.push(fixture);
    const mainRoot = join(fixture, "main");
    const worktreeRoot = join(fixture, "worktree");
    mkdirSync(mainRoot);
    mkdirSync(worktreeRoot);
    const workspaceContext = createWorkspaceContext({
      projectId: "project-synthetic-wake",
      projectRevision: 4,
      sessionMainRootId: "root-main",
      roots: [{ id: "root-main", path: mainRoot, role: "primary" }],
    });
    const engine = new Engine({
      llm: { provider: "openai", model: "gpt-4o", apiKey: "test" },
      cwd: mainRoot,
      workspaceContext,
      sessionStorageDir: join(fixture, "sessions"),
      settingsScope: "isolated",
      permissionMode: "bypassPermissions",
    });
    const sessionId = "synthetic-worktree-wake";
    const manager = engine.getSessionManager();
    manager.create(mainRoot, "gpt-4o", "openai", sessionId);
    manager.updateSessionState(sessionId, {
      project: {
        projectId: workspaceContext.projectId,
        mainRootId: workspaceContext.sessionMainRootId,
      },
    });
    manager.setSessionWorkspace(sessionId, {
      root: worktreeRoot,
      kind: "worktree",
      worktree: {
        path: worktreeRoot,
        branch: "worktree/synthetic-wake",
        baseRef: "main",
        createdBy: "codeshell",
      },
    });

    const resolved = engine.resolveSessionRunWorkspace(sessionId);

    expect(resolved.cwd).toBe(worktreeRoot);
    expect(workspacePrimaryRoot(resolved.workspaceContext!).path).toBe(worktreeRoot);
    expect(resolved.workspaceContext).toMatchObject({
      projectId: workspaceContext.projectId,
      projectRevision: workspaceContext.projectRevision,
      sessionMainRootId: workspaceContext.sessionMainRootId,
    });
  });
});
