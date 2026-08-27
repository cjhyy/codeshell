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

function store(options: { index?: SessionCwdIndex; noRepoPath?: string } = {}): ProjectStore {
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

  test("accepts legacy-path backfill only until the one-time V2 migration closes", async () => {
    const legacy = dir("legacy-local-storage");
    const another = dir("late-legacy");
    const index = new SessionCwdIndex({
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
    await index.ensureLoaded();
    index.upsert("legacy-session", { cwd: legacy });
    index.upsert("late-session", { cwd: another });
    const projects = store({ index });

    await expect(projects.migrateLegacyPath(legacy)).resolves.toMatchObject({
      name: "legacy-local-storage",
    });
    await projects.completeLegacyMigration();
    await expect(projects.migrateLegacyPath(another)).rejects.toThrow(/migration.*complete/i);

    const reopened = store({ index });
    await expect(reopened.migrateLegacyPath(another)).rejects.toThrow(/migration.*complete/i);
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
