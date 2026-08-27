import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@cjhyy/code-shell-core";
import { SessionCwdIndex, type SessionCwdIndexFs } from "./session-cwd-index.js";
import { ProjectStore } from "./project-store.js";

let fixtureRoot: string;
let projectsFile: string;
let recentsFile: string;
let migrationMarkerFile: string;

beforeEach(() => {
  fixtureRoot = mkdtempSync(join(tmpdir(), "codeshell-project-store-"));
  projectsFile = join(fixtureRoot, "desktop", "projects.json");
  recentsFile = join(fixtureRoot, "desktop", "recents.json");
  migrationMarkerFile = join(fixtureRoot, "desktop", "projects-v2-migration.json");
  mkdirSync(join(fixtureRoot, "desktop"), { recursive: true });
});

afterEach(() => {
  rmSync(fixtureRoot, { recursive: true, force: true });
});

function dir(name: string): string {
  const value = join(fixtureRoot, name);
  mkdirSync(value, { recursive: true });
  return value;
}

function registryProject(
  id: string,
  roots: Array<{ id: string; path: string }>,
): Record<string, unknown> {
  return {
    id,
    name: id,
    roots: roots.map((root) => ({ ...root, name: root.id, addedAt: 1 })),
    primaryRootId: roots[0]!.id,
    createdAt: 1,
    updatedAt: 1,
    lastOpenedAt: 1,
    revision: 1,
  };
}

function store(
  options: {
    index?: SessionCwdIndex;
    sessionManager?: SessionManager;
    noRepoPath?: string;
  } = {},
): ProjectStore {
  let sequence = 0;
  return new ProjectStore({
    file: projectsFile,
    recentsFile,
    migrationMarkerFile,
    sessionIndex:
      options.index ??
      new SessionCwdIndex({
        sessionsRoot: join(fixtureRoot, "sessions"),
        fs: {
          async readdir() {
            return [];
          },
          async readFile() {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
          async stat() {
            throw Object.assign(new Error("missing"), { code: "ENOENT" });
          },
        },
      }),
    sessionManager: options.sessionManager,
    noRepoPath: options.noRepoPath ?? join(fixtureRoot, "no-repo"),
    randomUUID: () => `id-${++sequence}`,
    now: () => 1_000 + sequence,
  });
}

describe("ProjectStore", () => {
  test("migrates live and tombstoned recents once with stable ids and downgrade projection", async () => {
    const alpha = dir("alpha");
    const removed = dir("removed");
    writeFileSync(
      recentsFile,
      JSON.stringify([
        { path: alpha, name: "Alpha", lastOpenedAt: 20, pinned: true },
        { path: removed, name: "Removed", lastOpenedAt: 10, deletedAt: 11 },
      ]),
    );
    const projects = store();
    const first = await projects.list({ includeDeleted: true });
    const second = await projects.list({ includeDeleted: true });

    expect(first).toEqual(second);
    expect(first).toHaveLength(2);
    expect(first[0]).toMatchObject({
      id: "id-2",
      name: "Alpha",
      pinned: true,
      primaryRootId: "id-1",
      revision: 1,
    });
    expect(first[1]?.deletedAt).toBe(11);
    expect(JSON.parse(readFileSync(recentsFile, "utf8"))).toHaveLength(2);
    if (process.platform !== "win32") expect(statSync(projectsFile).mode & 0o777).toBe(0o600);
  });

  test("folds a picked git subdirectory and rejects a fold onto the primary", async () => {
    const repo = dir("repo");
    execFileSync("git", ["init"], { cwd: repo, stdio: "ignore" });
    const sub = join(repo, "packages", "desktop");
    mkdirSync(sub, { recursive: true });
    const other = dir("other");
    const projects = store();
    const project = await projects.createFromPath(other);

    const added = await projects.addRoot(project.id, sub);
    expect(added.folded).toEqual({ picked: sub, root: realpathSync(repo) });
    expect(added.project.roots[1]?.path).toBe(realpathSync(repo));
    await expect(projects.addRoot(project.id, join(repo, "packages"))).rejects.toThrow(/already/);
  });

  test("rejects overlapping roots in one project and exact duplicates across projects", async () => {
    const parent = dir("parent");
    const child = join(parent, "child");
    mkdirSync(child);
    const other = dir("other");
    const projects = store();
    const project = await projects.createFromPath(parent);

    await expect(projects.addRoot(project.id, child)).rejects.toThrow(/overlap/);
    await projects.createFromPath(other);
    await expect(projects.createFromPath(parent)).resolves.toMatchObject({ id: project.id });
    await expect(projects.addRoot(project.id, other)).rejects.toThrow(/another project/);
  });

  test("serializes concurrent edits and increments revision monotonically", async () => {
    const primary = dir("primary");
    const a = dir("a");
    const b = dir("b");
    const projects = store();
    const project = await projects.createFromPath(primary);

    await Promise.all([projects.addRoot(project.id, a), projects.addRoot(project.id, b)]);
    const updated = (await projects.list())[0]!;
    expect(updated.roots.map((root) => root.path)).toEqual([
      realpathSync(primary),
      realpathSync(a),
      realpathSync(b),
    ]);
    expect(updated.revision).toBe(3);
  });

  test("refuses to remove a secondary used as a legacy or bound Session main root", async () => {
    const primary = dir("remove-primary");
    const secondary = dir("remove-secondary");
    const index = new SessionCwdIndex({
      sessionsRoot: join(fixtureRoot, "sessions"),
      fs: fakeEmptySessionFs(),
    });
    await index.ensureLoaded();
    const projects = store({ index });
    const project = await projects.createFromPath(primary);
    const added = await projects.addRoot(project.id, secondary);
    const secondaryRoot = added.project.roots.find(
      (root) => root.path === realpathSync(secondary),
    )!;

    index.upsert("legacy-session", { cwd: secondary });
    await expect(projects.removeRoot(project.id, secondaryRoot.id)).rejects.toThrow(
      /legacy-session/,
    );
    index.forget("legacy-session");
    index.upsert("bound-session", {
      cwd: secondary,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });
    await expect(projects.removeRoot(project.id, secondaryRoot.id)).rejects.toThrow(
      /bound-session/,
    );
  });

  test("atomically migrates a bound worktree Session to main and synchronizes index, handoff, and removal lifecycle", async () => {
    const primary = dir("migration-primary");
    const secondary = dir("migration-secondary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;
    const sessionId = "migrate-worktree-session";
    const worktree = join(fixtureRoot, "old-worktree");
    mkdirSync(worktree);
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
      workspace: {
        root: worktree,
        kind: "worktree",
        worktree: {
          path: worktree,
          branch: "worktree/old",
          baseRef: "main",
          createdBy: "codeshell",
        },
      },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      workspaceRoot: worktree,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });

    await projects.migrateSessionMainRoot(sessionId, project.primaryRootId);

    expect(sessionManager.readSessionState(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      project: { projectId: project.id, mainRootId: project.primaryRootId },
      workspace: { root: realpathSync(primary), kind: "main" },
    });
    expect(index.lookupCached(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      workspaceRoot: realpathSync(primary),
      projectId: project.id,
      mainRootId: project.primaryRootId,
    });
    const transcript = readFileSync(join(sessionsDir, sessionId, "transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(transcript.at(-1)).toMatchObject({
      type: "session_meta",
      data: {
        handoffFrom: worktree,
        workspace: { root: realpathSync(primary), kind: "main" },
      },
    });
    await expect(projects.removeRoot(project.id, secondaryRoot.id)).resolves.toMatchObject({
      id: project.id,
    });
  });

  test("uses the resident worker as the single migration writer", async () => {
    const primary = dir("resident-migration-primary");
    const secondary = dir("resident-migration-secondary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;
    const sessionId = "resident-owner-migration";
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      workspaceRoot: secondaryRoot.path,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });
    let ownerWrites = 0;
    let completed = false;

    await projects.migrateSessionMainRoot(sessionId, project.primaryRootId, {
      owner: {
        async migrate(input) {
          ownerWrites += 1;
          sessionManager.migrateSessionMainRoot(
            input.sessionId,
            { projectId: input.projectId, mainRootId: input.mainRootId },
            input.mainRoot,
          );
          return {
            status: "migrated",
            workspace: { root: input.mainRoot, kind: "main" },
          };
        },
        async complete() {
          completed = true;
        },
      },
    });

    expect(ownerWrites).toBe(1);
    expect(completed).toBe(false);
    expect(sessionManager.readSessionState(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      project: { projectId: project.id, mainRootId: project.primaryRootId },
      workspace: { root: realpathSync(primary), kind: "main" },
    });
    expect(index.lookupCached(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      workspaceRoot: realpathSync(primary),
      projectId: project.id,
      mainRootId: project.primaryRootId,
    });
  });

  test("migrates an idle-evicted Session through durable state only after the worker proves not-resident", async () => {
    const primary = dir("idle-migration-primary");
    const secondary = dir("idle-migration-secondary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;
    const sessionId = "idle-evicted-migration";
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      workspaceRoot: secondaryRoot.path,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });
    const calls: unknown[] = [];

    await projects.migrateSessionMainRoot(sessionId, project.primaryRootId, {
      owner: {
        async migrate(input) {
          calls.push({ migrate: input });
          return { status: "not-resident", ownershipToken: "idle-claim" };
        },
        async complete(input) {
          calls.push({ complete: input });
        },
      },
    });

    expect(calls).toEqual([
      {
        migrate: {
          sessionId,
          projectId: project.id,
          mainRootId: project.primaryRootId,
          mainRoot: realpathSync(primary),
        },
      },
      { complete: { sessionId, ownershipToken: "idle-claim" } },
    ]);
    expect(sessionManager.readSessionState(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      project: { projectId: project.id, mainRootId: project.primaryRootId },
      workspace: { root: realpathSync(primary), kind: "main" },
    });
    expect(index.lookupCached(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      workspaceRoot: realpathSync(primary),
      projectId: project.id,
      mainRootId: project.primaryRootId,
    });
    const transcript = readFileSync(join(sessionsDir, sessionId, "transcript.jsonl"), "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(transcript.at(-1)).toMatchObject({
      type: "session_meta",
      data: {
        handoffFrom: secondaryRoot.path,
        workspace: { root: realpathSync(primary), kind: "main" },
      },
    });
  });

  test("fails closed when the resident worker reports a real migration error", async () => {
    const primary = dir("failed-owner-primary");
    const secondary = dir("failed-owner-secondary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;
    const sessionId = "failed-owner-migration";
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      workspaceRoot: secondaryRoot.path,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });
    const before = readFileSync(join(sessionsDir, sessionId, "state.json"), "utf8");
    let completed = false;

    await expect(
      projects.migrateSessionMainRoot(sessionId, project.primaryRootId, {
        owner: {
          async migrate() {
            return { status: "failed", error: "worker state lock failed" };
          },
          async complete() {
            completed = true;
          },
        },
      }),
    ).rejects.toThrow("worker state lock failed");

    expect(completed).toBe(false);
    expect(readFileSync(join(sessionsDir, sessionId, "state.json"), "utf8")).toBe(before);
    expect(index.lookupCached(sessionId)).toMatchObject({
      cwd: secondaryRoot.path,
      workspaceRoot: secondaryRoot.path,
      mainRootId: secondaryRoot.id,
    });

    await expect(
      projects.migrateSessionMainRoot(sessionId, project.primaryRootId, {
        owner: {
          async migrate() {
            throw new Error("worker RPC timed out");
          },
          async complete() {
            completed = true;
          },
        },
      }),
    ).rejects.toThrow("worker RPC timed out");
    expect(completed).toBe(false);
    expect(readFileSync(join(sessionsDir, sessionId, "state.json"), "utf8")).toBe(before);
  });

  test("rejects nonexistent, cross-project, and physically missing migration targets without partial state", async () => {
    const primary = dir("reject-primary");
    const secondary = dir("reject-secondary");
    const foreign = dir("reject-foreign");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;
    const foreignProject = await projects.createFromPath(foreign);
    const sessionId = "reject-migration-session";
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      workspaceRoot: secondaryRoot.path,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });
    const before = readFileSync(join(sessionsDir, sessionId, "state.json"), "utf8");

    await expect(projects.migrateSessionMainRoot(sessionId, "missing-root")).rejects.toThrow(
      /target.*not found/i,
    );
    await expect(
      projects.migrateSessionMainRoot(sessionId, foreignProject.primaryRootId),
    ).rejects.toThrow(/same project|target.*not found/i);
    rmSync(primary, { recursive: true, force: true });
    await expect(projects.migrateSessionMainRoot(sessionId, project.primaryRootId)).rejects.toThrow(
      /directory.*missing/i,
    );
    expect(readFileSync(join(sessionsDir, sessionId, "state.json"), "utf8")).toBe(before);
    expect(index.lookupCached(sessionId)).toMatchObject({
      cwd: secondaryRoot.path,
      mainRootId: secondaryRoot.id,
    });
  });

  test("repairs a Session whose bound root was externally removed from otherwise valid project data", async () => {
    const primary = dir("removed-repair-primary");
    const secondary = dir("removed-repair-secondary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.id !== project.primaryRootId)!;
    const sessionId = "removed-root-repair";
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });
    const registry = JSON.parse(readFileSync(projectsFile, "utf8"));
    registry.projects[0].roots = registry.projects[0].roots.filter(
      (root: { id: string }) => root.id !== secondaryRoot.id,
    );
    writeFileSync(projectsFile, JSON.stringify(registry, null, 2));

    await projects.migrateSessionMainRoot(sessionId, project.primaryRootId);

    expect(sessionManager.readSessionState(sessionId)).toMatchObject({
      cwd: realpathSync(primary),
      project: { projectId: project.id, mainRootId: project.primaryRootId },
      workspace: { root: realpathSync(primary), kind: "main" },
    });
  });

  test("allows root removal after the only bound Session is durably archived", async () => {
    const primary = dir("archive-primary");
    const secondary = dir("archive-secondary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const index = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    await index.ensureLoaded();
    const projects = store({ index, sessionManager });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;
    const sessionId = "archived-root-session";
    sessionManager.create(secondaryRoot.path, "m", "p", sessionId);
    sessionManager.updateSessionState(sessionId, {
      project: { projectId: project.id, mainRootId: secondaryRoot.id },
    });
    index.upsert(sessionId, {
      cwd: secondaryRoot.path,
      projectId: project.id,
      mainRootId: secondaryRoot.id,
    });

    await expect(projects.removeRoot(project.id, secondaryRoot.id)).rejects.toThrow(sessionId);
    sessionManager.setSessionArchived(sessionId, 1234);
    await expect(projects.removeRoot(project.id, secondaryRoot.id)).resolves.toMatchObject({
      id: project.id,
    });
  });

  test("resolves every root, no-repo, batch ownership, and confirmed legacy cwd", async () => {
    const primary = dir("primary");
    const secondary = dir("secondary");
    const legacy = dir("legacy");
    const noRepo = dir("no-repo");
    const sessionIndex = new SessionCwdIndex({
      sessionsRoot: join(fixtureRoot, "sessions"),
      fs: {
        async readdir() {
          return [];
        },
        async readFile() {
          throw new Error("missing");
        },
        async stat() {
          throw new Error("missing");
        },
      },
    });
    await sessionIndex.ensureLoaded();
    sessionIndex.upsert("legacy-session", { cwd: legacy });
    const projects = store({ index: sessionIndex, noRepoPath: noRepo });
    const project = await projects.createFromPath(primary);
    await projects.addRoot(project.id, secondary);

    const resolved = await projects.resolveProjectForCwdBatch(
      [primary, secondary, noRepo, legacy, dir("unknown")],
      "disk-rebuild",
    );
    expect(resolved[0]).toMatchObject({ projectId: project.id, rootId: project.roots[0]?.id });
    expect(resolved[1]).toMatchObject({ projectId: project.id });
    expect(resolved[2]).toEqual({ noRepo: true });
    expect(resolved[3]).toMatchObject({ created: true });
    expect(resolved[4]).toBeNull();
  });

  test("does not revive a tombstone from persisted Sessions unless a native picker restores it", async () => {
    const primary = dir("tombstone-primary");
    const sessionsDir = join(fixtureRoot, "sessions");
    const sessionManager = new SessionManager(sessionsDir);
    const projects = store({ sessionManager });
    const project = await projects.createFromPath(primary);
    sessionManager.create(primary, "model", "provider", "confirmed-session");
    sessionManager.create(primary, "model", "provider", "archived-session");
    sessionManager.setSessionArchived("archived-session", 2_000);
    await projects.remove(project.id);
    const tombstone = await projects.get(project.id);
    expect(tombstone).toMatchObject({
      deletedAt: expect.any(Number),
      revision: project.revision + 1,
    });

    const restartedIndex = new SessionCwdIndex({ sessionsRoot: sessionsDir });
    const restarted = store({ index: restartedIndex, sessionManager });
    await restarted.warm();
    expect(
      restartedIndex
        .confirmedEntries()
        .map((entry) => entry.sessionId)
        .sort(),
    ).toEqual(["archived-session", "confirmed-session"]);

    await expect(restarted.resolveProjectForCwdBatch([primary], "disk-rebuild")).resolves.toEqual([
      null,
    ]);
    await expect(restarted.resolveProjectForCwd(primary, "automation-import")).resolves.toBeNull();
    await expect(restarted.resolveProjectForCwd(primary)).resolves.toBeNull();
    expect(await restarted.get(project.id)).toEqual(tombstone);

    const restored = await restarted.createFromPath(primary);
    expect(restored).toMatchObject({
      id: project.id,
      primaryRootId: project.primaryRootId,
      revision: tombstone!.revision + 1,
    });
    expect(restored).not.toHaveProperty("deletedAt");
    expect((await restarted.list({ includeDeleted: true }))[0]).toEqual(restored);
    expect(JSON.parse(readFileSync(recentsFile, "utf8"))[0]).not.toHaveProperty("deletedAt");
  });

  test("quarantines every globally conflicting V2 project independent of registry order", async () => {
    const clean = registryProject("clean-project", [{ id: "clean-root", path: dir("clean") }]);
    const ancestor = dir("allowed-ancestor");
    const descendant = join(ancestor, "child");
    mkdirSync(descendant);
    const allowedParent = registryProject("allowed-parent", [
      { id: "allowed-parent-root", path: ancestor },
    ]);
    const allowedChild = registryProject("allowed-child", [
      { id: "allowed-child-root", path: descendant },
    ]);
    const duplicateProjectIdA = registryProject("duplicate-project", [
      { id: "duplicate-project-root-a", path: dir("duplicate-project-a") },
    ]);
    const duplicateProjectIdB = registryProject("duplicate-project", [
      { id: "duplicate-project-root-b", path: dir("duplicate-project-b") },
    ]);
    const duplicateWithinProject = registryProject("duplicate-within-project", [
      { id: "duplicate-within-root", path: dir("duplicate-within-a") },
      { id: "duplicate-within-root", path: dir("duplicate-within-b") },
    ]);
    const duplicateRootIdA = registryProject("duplicate-root-project-a", [
      { id: "duplicate-across-root", path: dir("duplicate-root-a") },
    ]);
    const duplicateRootIdB = registryProject("duplicate-root-project-b", [
      { id: "duplicate-across-root", path: dir("duplicate-root-b") },
    ]);
    const duplicatePath = dir("duplicate-canonical-path");
    const duplicatePathA = registryProject("duplicate-path-project-a", [
      { id: "duplicate-path-root-a", path: duplicatePath },
    ]);
    const duplicatePathB = registryProject("duplicate-path-project-b", [
      { id: "duplicate-path-root-b", path: `${duplicatePath}/.` },
    ]);
    const registryProjects = [
      duplicateProjectIdA,
      clean,
      duplicateRootIdA,
      allowedParent,
      duplicatePathA,
      duplicateWithinProject,
      duplicateProjectIdB,
      allowedChild,
      duplicateRootIdB,
      duplicatePathB,
    ];
    const expectedIds = ["allowed-child", "allowed-parent", "clean-project"];

    for (const projects of [registryProjects, [...registryProjects].reverse()]) {
      writeFileSync(projectsFile, JSON.stringify({ version: 2, projects }));
      const parsed = store();
      expect((await parsed.list()).map((project) => project.id).sort()).toEqual(expectedIds);
      expect(parsed.resolveExactRootSync(duplicatePath)).toBeUndefined();
      expect(parsed.resolveExactRootSync(ancestor)?.project.id).toBe("allowed-parent");
      expect(parsed.resolveExactRootSync(descendant)?.project.id).toBe("allowed-child");
    }
  });

  test("resolves stable project/root ids across make-primary and rejects stale bindings", async () => {
    const primary = dir("stable-primary");
    const secondary = dir("stable-secondary");
    const foreign = dir("stable-foreign");
    const projects = store();
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const primaryRoot = updated.roots.find((root) => root.id === updated.primaryRootId)!;
    const secondaryRoot = updated.roots.find((root) => root.id !== updated.primaryRootId)!;
    const foreignProject = await projects.createFromPath(foreign);

    expect(projects.resolveProjectRootByIdSync(project.id, secondaryRoot.id)).toMatchObject({
      cwd: realpathSync(secondary),
      mainRoot: { id: secondaryRoot.id },
    });
    await projects.setPrimary(project.id, secondaryRoot.id);
    expect(projects.resolveProjectRootByIdSync(project.id).mainRoot.id).toBe(secondaryRoot.id);
    expect(projects.resolveProjectRootByIdSync(project.id, primaryRoot.id).mainRoot.id).toBe(
      primaryRoot.id,
    );
    expect(() =>
      projects.resolveProjectRootByIdSync(project.id, foreignProject.primaryRootId),
    ).toThrow(/root not found/);

    await projects.removeRoot(project.id, primaryRoot.id);
    expect(() => projects.resolveProjectRootByIdSync(project.id, primaryRoot.id)).toThrow(
      /root not found/,
    );
    rmSync(secondary, { recursive: true, force: true });
    expect(() => projects.resolveProjectRootByIdSync(project.id, secondaryRoot.id)).toThrow(
      /directory is missing/,
    );
  });

  test("resolves explicit project runs from the caller-confirmed cold Session entry", async () => {
    const primary = dir("run-primary");
    const secondary = dir("run-secondary");
    const index = new SessionCwdIndex({
      sessionsRoot: join(fixtureRoot, "sessions"),
      fs: fakeEmptySessionFs(),
    });
    await index.ensureLoaded();
    const projects = store({ index });
    const project = await projects.createFromPath(primary);
    const updated = (await projects.addRoot(project.id, secondary)).project;
    const secondaryRoot = updated.roots.find((root) => root.path === realpathSync(secondary))!;

    const ordinaryFork = projects.resolveRunProjectSync(project.id, "ordinary-fork", {
      sessionId: "ordinary-fork",
      cwd: secondary,
      status: "confirmed",
    });
    expect(ordinaryFork.mainRoot.id).toBe(secondaryRoot.id);
    expect(ordinaryFork.cwd).toBe(secondary);

    const worktree = join(fixtureRoot, "external-worktree");
    const externalSession = projects.resolveRunProjectSync(project.id, "external-session", {
      sessionId: "external-session",
      cwd: primary,
      workspaceRoot: worktree,
      projectId: project.id,
      mainRootId: project.primaryRootId,
      status: "confirmed",
    });
    expect(externalSession.mainRoot.id).toBe(project.primaryRootId);
    expect(externalSession.cwd).toBe(worktree);

    expect(() =>
      projects.resolveRunProjectSync(project.id, "bound-elsewhere", {
        sessionId: "bound-elsewhere",
        cwd: primary,
        projectId: "another-project",
        mainRootId: project.primaryRootId,
        status: "confirmed",
      }),
    ).toThrow(/binding does not match/);
    expect(() =>
      projects.resolveRunProjectSync(project.id, "legacy-elsewhere", {
        sessionId: "legacy-elsewhere",
        cwd: join(fixtureRoot, "unmounted"),
        status: "confirmed",
      }),
    ).toThrow(/main root is not mounted/);

    rmSync(secondaryRoot.path, { recursive: true, force: true });
    expect(() =>
      projects.resolveRunProjectSync(project.id, "missing-dir", {
        sessionId: "missing-dir",
        cwd: secondaryRoot.path,
        projectId: project.id,
        mainRootId: secondaryRoot.id,
        status: "confirmed",
      }),
    ).toThrow(/dir_missing/);

    const registry = JSON.parse(readFileSync(projectsFile, "utf8"));
    registry.projects[0].roots = registry.projects[0].roots.filter(
      (root: { id: string }) => root.id !== secondaryRoot.id,
    );
    writeFileSync(projectsFile, JSON.stringify(registry, null, 2));
    expect(() =>
      projects.resolveRunProjectSync(project.id, "removed-root", {
        sessionId: "removed-root",
        cwd: secondaryRoot.path,
        projectId: project.id,
        mainRootId: secondaryRoot.id,
        status: "confirmed",
      }),
    ).toThrow(/root_removed/);
  });

  test("soft deletes projects while retaining tombstones and refuses unsafe registry roots", async () => {
    const primary = dir("primary");
    const projects = store();
    const project = await projects.createFromPath(primary);
    await projects.remove(project.id);
    expect(await projects.list()).toEqual([]);
    expect((await projects.list({ includeDeleted: true }))[0]?.deletedAt).toBeNumber();

    writeFileSync(projectsFile, "{bad json");
    await expect(projects.createFromPath(dir("new"))).rejects.toThrow(/JSON parse/);
    expect(readFileSync(projectsFile, "utf8")).toBe("{bad json");

    if (process.platform !== "win32") {
      rmSync(projectsFile);
      const outside = join(fixtureRoot, "outside.json");
      writeFileSync(outside, JSON.stringify({ version: 2, projects: [] }));
      symlinkSync(outside, projectsFile);
      await expect(projects.createFromPath(dir("unsafe"))).rejects.toThrow(/regular file/);
    }
  });

  test("requires same-path picker proof and closes the one-time migration permanently", async () => {
    const legacy = dir("legacy-local-storage");
    const another = dir("late-legacy");
    const projects = store();

    await expect(projects.authorizeLegacyMigration(legacy, another)).resolves.toBeNull();
    expect(await projects.list()).toEqual([]);
    await expect(projects.authorizeLegacyMigration(legacy, legacy)).resolves.toMatchObject({
      name: "legacy-local-storage",
    });
    await projects.completeLegacyMigration();
    await expect(projects.authorizeLegacyMigration(another, another)).rejects.toThrow(
      /migration.*complete/i,
    );

    const reopened = store();
    await expect(reopened.authorizeLegacyMigration(another, another)).rejects.toThrow(
      /migration.*complete/i,
    );
  });

  test("keeps recents as a rollback-only output projection when V2 already exists", async () => {
    const v2Root = dir("v2-authority");
    const staleRecent = dir("stale-recent");
    writeFileSync(
      projectsFile,
      JSON.stringify({
        version: 2,
        projects: [
          {
            id: "v2-project",
            name: "V2",
            roots: [{ id: "v2-root", path: v2Root, name: "V2", addedAt: 1 }],
            primaryRootId: "v2-root",
            createdAt: 1,
            updatedAt: 1,
            lastOpenedAt: 1,
            revision: 1,
          },
        ],
      }),
    );
    writeFileSync(
      recentsFile,
      JSON.stringify([{ path: staleRecent, name: "stale", lastOpenedAt: 2 }]),
    );

    const projects = store();
    expect((await projects.list()).map((project) => project.id)).toEqual(["v2-project"]);
    await projects.setPinned("v2-project", true);
    expect(JSON.parse(readFileSync(recentsFile, "utf8"))).toEqual([
      expect.objectContaining({ path: v2Root, name: "V2", pinned: true }),
    ]);
  });
});

function fakeEmptySessionFs(): SessionCwdIndexFs {
  return {
    async readdir() {
      return [];
    },
    async readFile() {
      throw new Error("missing");
    },
    async stat() {
      throw new Error("missing");
    },
  };
}
