import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { SessionManager } from "@cjhyy/code-shell-core";
import { createWorktree } from "@cjhyy/code-shell-capability-coding/git";
import {
  assertBunTestCompletion,
  createBunTestEnvironment,
} from "../../../../scripts/bun-test-completion.mjs";
import { ProjectStore, type LocalProject } from "./project-store.js";
import { requireRendererProjectPath } from "./renderer-project-path.js";
import { SessionCwdIndex } from "./session-cwd-index.js";
import {
  __setSessionWorkspaceServiceProjectStoreForTests,
  __setSessionWorkspaceServiceSessionManagerForTests,
} from "./session-workspace-service.js";

if (process.env.CODESHELL_EXTERNAL_WORKSPACE_IPC_FIXTURE === "1") {
  // Electron exports and IPC handlers are process-wide. Keep this fixture's
  // module mock out of the shared Desktop unit-test process.
  mock.module("electron", () => ({ BrowserWindow: {}, ipcMain: {} }));
  const { resolveExternalRuntimeStartWorkspace } = await import("./external-runtime-ipc.js");

  describe("external runtime startup workspace authority", () => {
    let root: string;
    let mainRoot: string;
    let sessionsRoot: string;
    let sessions: SessionManager;
    let projects: ProjectStore;
    let project: LocalProject;
    let registeredPaths: string[];

    beforeEach(async () => {
      root = realpathSync(mkdtempSync(join(tmpdir(), "cs-external-start-workspace-")));
      mainRoot = join(root, "project");
      mkdirSync(mainRoot);
      const git = (args: string[]) =>
        execFileSync("git", args, {
          cwd: mainRoot,
          env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
          stdio: "pipe",
        });
      git(["init", "-q"]);
      git(["config", "user.email", "test@example.invalid"]);
      git(["config", "user.name", "Test"]);
      git(["commit", "--allow-empty", "-qm", "initial"]);
      sessionsRoot = join(root, "sessions");
      sessions = new SessionManager(sessionsRoot);
      const index = new SessionCwdIndex({ sessionsRoot });
      await index.ensureLoaded();
      projects = new ProjectStore({
        file: join(root, "projects.json"),
        recentsFile: join(root, "recents.json"),
        migrationMarkerFile: join(root, "migration.json"),
        sessionIndex: index,
        sessionManager: sessions,
        noRepoPath: join(root, "no-repo"),
      });
      project = await projects.createFromPath(mainRoot);
      registeredPaths = [mainRoot];
      __setSessionWorkspaceServiceProjectStoreForTests(projects);
      __setSessionWorkspaceServiceSessionManagerForTests(sessions);
    });

    afterEach(() => {
      __setSessionWorkspaceServiceProjectStoreForTests(undefined);
      __setSessionWorkspaceServiceSessionManagerForTests(undefined);
      rmSync(root, { recursive: true, force: true });
    });

    const projectPath: typeof requireRendererProjectPath = (input) =>
      requireRendererProjectPath(input, { registeredPaths, noRepoPath: join(root, "no-repo") });

    const resolve = (sessionId: string, hint: unknown) =>
      resolveExternalRuntimeStartWorkspace(sessionId, hint, { sessions, projectPath });

    function createSession(sessionId: string, bind = true) {
      sessions.create(mainRoot, "model", "codex", sessionId);
      if (bind) {
        sessions.migrateSessionMainRoot(
          sessionId,
          { projectId: project.id, mainRootId: project.primaryRootId },
          mainRoot,
        );
      }
    }

    async function enterWorktree(sessionId: string) {
      const worktree = await createWorktree(mainRoot, sessionId, sessionId);
      sessions.setSessionWorkspace(sessionId, {
        kind: "worktree",
        root: worktree.worktreePath,
        worktree: {
          path: worktree.worktreePath,
          branch: worktree.worktreeBranch,
          baseRef: worktree.originalBranch ?? "HEAD",
          createdBy: "codeshell",
        },
      });
      return worktree.worktreePath;
    }

    test("starts in the Session worktree while keeping the registered main root for authority", async () => {
      createSession("bound-worktree");
      const worktree = await enterWorktree("bound-worktree");
      const previous = sessions.readSessionState("bound-worktree");

      const workspace = await resolve("bound-worktree", mainRoot);

      expect(workspace).toMatchObject({ cwd: worktree, mainRoot });
      expect(() => workspace.assertStartAuthority()).not.toThrow();
      expect(sessions.readSessionState("bound-worktree")).toEqual(previous);
    });

    test("accepts the current Session worktree hint without registering it as a project root", async () => {
      createSession("worktree-hint");
      const worktree = await enterWorktree("worktree-hint");
      await expect(projectPath(worktree)).rejects.toThrow(/not registered/);

      await expect(resolve("worktree-hint", worktree)).resolves.toMatchObject({
        cwd: worktree,
        mainRoot,
      });
    });

    test("rejects another registered project or unowned worktree hint instead of retargeting the Session", async () => {
      createSession("fixed-project");
      const otherRoot = join(root, "other-project");
      mkdirSync(otherRoot);
      await projects.createFromPath(otherRoot);
      registeredPaths.push(otherRoot);
      const unowned = await createWorktree(mainRoot, "unowned", "unowned-owner");

      for (const hint of [otherRoot, unowned.worktreePath]) {
        await expect(resolve("fixed-project", hint)).rejects.toThrow(
          /does not match persisted Session workspace/,
        );
      }
      expect(sessions.getSessionWorkspace("fixed-project")).toEqual({
        kind: "main",
        root: mainRoot,
      });
    });

    test("a first Session may start only from a registered project root", async () => {
      const unowned = await createWorktree(mainRoot, "new-session-unowned", "unowned-start");
      const arbitrary = join(root, "unregistered");
      mkdirSync(arbitrary);

      await expect(resolve("new-session", mainRoot)).resolves.toMatchObject({
        cwd: mainRoot,
        mainRoot,
      });
      for (const hint of [unowned.worktreePath, arbitrary]) {
        await expect(resolve("new-session", hint)).rejects.toThrow(/not registered/);
      }
      expect(sessions.exists("new-session")).toBe(false);
    });

    test("an existing corrupt Session cannot fall back to a new registered-root start", async () => {
      mkdirSync(join(sessionsRoot, "corrupt-session"), { recursive: true });
      writeFileSync(join(sessionsRoot, "corrupt-session", "state.json"), "{");

      await expect(resolve("corrupt-session", mainRoot)).rejects.toThrow(/no valid state/);
    });

    test("a removed project binding cannot fall back to its old cwd hint", async () => {
      createSession("removed-project");
      await projects.remove(project.id);

      await expect(resolve("removed-project", mainRoot)).rejects.toThrow(/root_removed/);
    });

    test("legacy Sessions retain registered-root admission and startup permits their Main-owned project upgrade", async () => {
      createSession("legacy-session", false);
      const workspace = await resolve("legacy-session", mainRoot);
      sessions.migrateSessionMainRoot(
        "legacy-session",
        { projectId: project.id, mainRootId: project.primaryRootId },
        mainRoot,
      );
      expect(() => workspace.assertStartAuthority()).not.toThrow();

      const unregistered = join(root, "unregistered-session-root");
      mkdirSync(unregistered);
      sessions.create(unregistered, "model", "codex", "unregistered-session");
      await expect(resolve("unregistered-session", mainRoot)).rejects.toThrow(/not registered/);
    });

    test("rechecks Session workspace when a resolved start reaches the lifecycle queue", async () => {
      createSession("delayed-start");
      const worktree = await enterWorktree("delayed-start");
      const workspace = await resolve("delayed-start", mainRoot);
      sessions.setSessionWorkspace("delayed-start", { kind: "main", root: mainRoot });

      expect(workspace.cwd).toBe(worktree);
      expect(() => workspace.assertStartAuthority()).toThrow(/workspace changed before startup/);
      await expect(resolve("delayed-start", mainRoot)).resolves.toMatchObject({
        cwd: mainRoot,
        mainRoot,
      });
    });

    test("a workspace change during async path admission cannot return an old execution directory", async () => {
      createSession("admission-race");
      await enterWorktree("admission-race");
      let admitted!: () => void;
      let resume!: () => void;
      const atAdmission = new Promise<void>((resolve) => (admitted = resolve));
      const gate = new Promise<void>((resolve) => (resume = resolve));
      const pending = resolveExternalRuntimeStartWorkspace("admission-race", mainRoot, {
        sessions,
        projectPath: async (input) => {
          const path = await projectPath(input);
          admitted();
          await gate;
          return path;
        },
      });
      await atAdmission;
      sessions.setSessionWorkspace("admission-race", { kind: "main", root: mainRoot });
      resume();

      await expect(pending).rejects.toThrow(/workspace changed before startup/);
    });
  });
} else {
  test("external startup resolves Session-owned workspaces in an isolated Electron fixture", async () => {
    const directory = mkdtempSync(join(tmpdir(), "cs-external-start-ipc-test-"));
    const report = join(directory, "junit.xml");
    try {
      const child = Bun.spawn(
        [
          process.execPath,
          "test",
          fileURLToPath(import.meta.url),
          "--reporter",
          "junit",
          "--reporter-outfile",
          report,
        ],
        {
          env: {
            ...createBunTestEnvironment(process.env, directory),
            CODESHELL_EXTERNAL_WORKSPACE_IPC_FIXTURE: "1",
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      );
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
        child.exited,
      ]);
      if (exitCode !== 0) throw new Error(`${stdout}\n${stderr}`.trim());
      expect(assertBunTestCompletion(report)).toEqual({ tests: 9, skipped: 0 });
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  }, 30_000);
}
