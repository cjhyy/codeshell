import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCwdIndex } from "../main/session-cwd-index";
import { ProjectStore } from "../main/project-store";
import { createLegacyProjectMigrationService } from "../main/legacy-project-migration";
import { adaptLegacyRepo, migrateLegacyProjects, type TrackedProject } from "./projects";

describe("localStorage-only project migration", () => {
  let root: string;
  let legacyPath: string;
  let otherPath: string;
  let markerFile: string;
  let pickedPath: string | null;
  let store: ProjectStore;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "codeshell-legacy-project-migration-"));
    legacyPath = join(root, "local-storage-only");
    otherPath = join(root, "other");
    mkdirSync(legacyPath);
    mkdirSync(otherPath);
    markerFile = join(root, "desktop", "projects-v2-migration.json");
    const sessionsRoot = join(root, "sessions");
    mkdirSync(sessionsRoot);
    const sessionIndex = new SessionCwdIndex({ sessionsRoot });
    store = new ProjectStore({
      file: join(root, "desktop", "projects.json"),
      recentsFile: join(root, "desktop", "recents.json"),
      migrationMarkerFile: markerFile,
      sessionIndex,
      noRepoPath: join(root, "no-repo"),
      randomUUID: (() => {
        let id = 0;
        return () => `migration-id-${++id}`;
      })(),
      now: () => 123,
      resolveProjectRoot: (path) => path,
    });
    pickedPath = null;
  });

  afterEach(() => {
    rmSync(root, { recursive: true, force: true });
  });

  test("keeps an unprovable localStorage path pending, retries, and completes only after same-path picker authorization", async () => {
    const cached: TrackedProject[] = [
      adaptLegacyRepo({
        id: "legacy-renderer-id",
        name: "local-storage-only",
        path: legacyPath,
        addedAt: 1,
      }),
    ];
    const service = createLegacyProjectMigrationService({
      store,
      sessionRoot: join(root, "sessions"),
      noRepoPath: join(root, "no-repo"),
      pickDirectory: async () => pickedPath,
    });
    const registry = {
      list: () => store.list(),
      migrateLegacyPaths: (paths: string[]) => service.migratePaths(paths),
      reauthorizeLegacyPath: (path: string) => service.reauthorizePath(path),
    };

    const first = await migrateLegacyProjects({
      diskProjects: [],
      cachedProjects: cached,
      registry,
    });

    expect(first.completed).toBe(false);
    expect(first.results).toEqual([
      expect.objectContaining({ path: legacyPath, status: "reauthorization_required" }),
    ]);
    expect(first.projects).toEqual([
      expect.objectContaining({
        id: "legacy-renderer-id",
        path: legacyPath,
        migrationStatus: "reauthorization_required",
      }),
    ]);
    expect(await store.list()).toEqual([]);
    expect(existsSync(markerFile)).toBe(false);

    pickedPath = otherPath;
    const mismatch = await migrateLegacyProjects({
      diskProjects: await store.list(),
      cachedProjects: first.projects,
      registry,
    });
    expect(mismatch.completed).toBe(false);
    expect(mismatch.results).toEqual([
      expect.objectContaining({ path: legacyPath, status: "reauthorization_required" }),
    ]);
    expect(await store.list()).toEqual([]);
    expect(existsSync(markerFile)).toBe(false);

    pickedPath = legacyPath;
    const green = await migrateLegacyProjects({
      diskProjects: await store.list(),
      cachedProjects: mismatch.projects,
      registry,
    });

    expect(green.completed).toBe(true);
    expect(green.results).toEqual([
      expect.objectContaining({ path: legacyPath, status: "migrated" }),
    ]);
    expect(green.projects).toHaveLength(1);
    expect(green.projects[0]).toMatchObject({ path: realpathSync(legacyPath) });
    expect(green.projects[0]?.migrationStatus).toBeUndefined();
    expect(green.projectIdRemap["legacy-renderer-id"]).toBe(green.projects[0]!.id);
    expect(await store.list()).toHaveLength(1);
    expect(existsSync(markerFile)).toBe(true);
  });
});
