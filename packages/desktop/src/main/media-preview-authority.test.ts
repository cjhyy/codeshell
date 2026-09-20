import { afterEach, beforeEach, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { createWorktree } from "@cjhyy/code-shell-capability-coding/git";
import { resolveMediaPreviewAuthority } from "./media-preview-authority.js";
import { ProjectStore } from "./project-store.js";
import { SessionCwdIndex } from "./session-cwd-index.js";
import {
  __setSessionWorkspaceServiceProjectStoreForTests,
  __setSessionWorkspaceServiceSessionManagerForTests,
} from "./session-workspace-service.js";

let directory: string;
let workspace: string;
let sessionsDirectory: string;
let sessions: SessionManager;
let projects: ProjectStore;

beforeEach(async () => {
  directory = await mkdtemp(join(tmpdir(), "cs-media-authority-"));
  workspace = join(directory, "workspace");
  sessionsDirectory = join(directory, "sessions");
  await mkdir(workspace);
  sessions = new SessionManager(sessionsDirectory);
  const index = new SessionCwdIndex({ sessionsRoot: sessionsDirectory });
  await index.ensureLoaded();
  projects = new ProjectStore({
    file: join(directory, "desktop", "projects.json"),
    recentsFile: join(directory, "desktop", "recents.json"),
    migrationMarkerFile: join(directory, "desktop", "migration.json"),
    sessionIndex: index,
    sessionManager: sessions,
    noRepoPath: join(directory, "no-repo"),
    resolveProjectRoot: (path) => path,
  });
  __setSessionWorkspaceServiceSessionManagerForTests(sessions);
  __setSessionWorkspaceServiceProjectStoreForTests(projects);
});

afterEach(async () => {
  __setSessionWorkspaceServiceSessionManagerForTests(undefined);
  __setSessionWorkspaceServiceProjectStoreForTests(undefined);
  await rm(directory, { recursive: true, force: true });
});

async function bind(projectId: string, mainRootId: string) {
  sessions.create(workspace, "model", "provider", "task-1");
  const path = join(sessionsDirectory, "task-1", "state.json");
  const state = JSON.parse(await readFile(path, "utf8"));
  state.project = { projectId, mainRootId };
  await writeFile(path, JSON.stringify(state));
}

test("media resolves a legacy/no-repo task from persisted Main authority and rejects unknown tasks", async () => {
  sessions.create(workspace, "model", "provider", "task-1");
  expect(await resolveMediaPreviewAuthority("task-1")).toEqual({
    mainRootId: "legacy:task-1",
    roots: [{ id: "legacy:task-1", path: workspace, role: "primary" }],
  });
  await expect(resolveMediaPreviewAuthority("missing-task")).rejects.toThrow();
  await expect(resolveMediaPreviewAuthority("../task-1")).rejects.toThrow();
});

test("media retains the Session main root when project primary changes and drops removed mounts", async () => {
  const project = await projects.createFromPath(workspace);
  const secondary = join(directory, "secondary");
  await mkdir(secondary);
  const updated = await projects.addRoot(project.id, secondary);
  const secondaryRoot = updated.project.roots.find((root) => root.id !== project.primaryRootId)!;
  await bind(project.id, project.primaryRootId);
  await projects.setPrimary(project.id, secondaryRoot.id);
  const authority = await resolveMediaPreviewAuthority("task-1");
  expect(authority.mainRootId).toBe(project.primaryRootId);
  expect(authority.roots.find((root) => root.role === "primary")?.path).toBe(workspace);
  expect(authority.roots.find((root) => root.role === "secondary")?.path).toBe(secondaryRoot.path);
  await projects.setPrimary(project.id, project.primaryRootId);
  await projects.removeRoot(project.id, secondaryRoot.id);
  expect((await resolveMediaPreviewAuthority("task-1")).roots).toHaveLength(1);
});

test("media rejects a mounted root redirected to a symlink", async () => {
  const project = await projects.createFromPath(workspace);
  await bind(project.id, project.primaryRootId);
  await rename(workspace, `${workspace}-old`);
  await symlink(`${workspace}-old`, workspace, "dir");
  await expect(resolveMediaPreviewAuthority("task-1")).rejects.toThrow(/root_replaced/);
});

test("media permits the task's real CodeShell worktree and rejects forged worktree paths", async () => {
  const git = (args: string[]) =>
    execFileSync("git", args, {
      cwd: workspace,
      env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
      encoding: "utf8",
    });
  git(["init", "-q"]);
  git(["config", "user.email", "test@example.com"]);
  git(["config", "user.name", "Test"]);
  await writeFile(join(workspace, "readme.txt"), "workspace");
  git(["add", "."]);
  git(["commit", "-qm", "fixture"]);
  const project = await projects.createFromPath(workspace);
  await bind(project.id, project.primaryRootId);
  const tree = await createWorktree(workspace, "media-preview", "task-1");
  sessions.setSessionWorkspace("task-1", {
    root: tree.worktreePath,
    kind: "worktree",
    worktree: {
      path: tree.worktreePath,
      branch: tree.worktreeBranch,
      baseRef: tree.originalBranch ?? "HEAD",
      createdBy: "codeshell",
    },
  });
  expect((await resolveMediaPreviewAuthority("task-1")).roots[0].path).toBe(tree.worktreePath);
  const forged = join(directory, "forged");
  await mkdir(forged);
  sessions.setSessionWorkspace("task-1", {
    root: forged,
    kind: "worktree",
    worktree: { path: forged, branch: "fake", baseRef: "HEAD", createdBy: "codeshell" },
  });
  await expect(resolveMediaPreviewAuthority("task-1")).rejects.toThrow(/authorized worktree/);
});
