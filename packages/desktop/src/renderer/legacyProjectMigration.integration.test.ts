import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionCwdIndex } from "../main/session-cwd-index";
import { ProjectStore } from "../main/project-store";
import { createLegacyProjectMigrationService } from "../main/legacy-project-migration";
import {
  __resetProjectSnapshotForTest,
  adaptLegacyRepo,
  migrateLegacyProjects,
  readLegacyProjectsForMigration,
  type TrackedProject,
} from "./projects";

class MemoryStorage {
  private readonly data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }
}

describe("localStorage-only project migration", () => {
  let root: string;
  let legacyPath: string;
  let otherPath: string;
  let markerFile: string;
  let pickedPath: string | null;
  let store: ProjectStore;

  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
    __resetProjectSnapshotForTest();
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
    const legacyRecord = {
      id: "legacy-renderer-id",
      name: "local-storage-only",
      path: legacyPath,
      addedAt: 1,
    };
    localStorage.setItem("codeshell.repos", JSON.stringify([legacyRecord]));
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
      pickDirectory: async () => pickedPath,
      makeToken: () => "migration-token",
    });
    const registry = {
      list: () => store.list(),
      beginLegacyMigration: (paths: string[]) => service.begin(paths),
      authorizeLegacyMigration: (token: string, path: string) =>
        service.authorizePath(token, path),
      completeLegacyMigration: (token: string) => service.complete(token),
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
    expect(first.projects).toEqual([]);
    expect(await store.list()).toEqual([]);
    expect(existsSync(markerFile)).toBe(false);
    expect(localStorage.getItem("codeshell.repos")).toBe(JSON.stringify([legacyRecord]));

    pickedPath = otherPath;
    const mismatch = await migrateLegacyProjects({
      diskProjects: await store.list(),
      cachedProjects: cached,
      registry,
    });
    expect(mismatch.completed).toBe(false);
    expect(mismatch.results).toEqual([
      expect.objectContaining({ path: legacyPath, status: "reauthorization_required" }),
    ]);
    expect(await store.list()).toEqual([]);
    expect(existsSync(markerFile)).toBe(false);
    expect(localStorage.getItem("codeshell.repos")).toBe(JSON.stringify([legacyRecord]));

    pickedPath = legacyPath;
    const green = await migrateLegacyProjects({
      diskProjects: await store.list(),
      cachedProjects: cached,
      registry,
    });

    expect(green.completed).toBe(true);
    expect(green.results).toEqual([
      expect.objectContaining({ path: legacyPath, status: "migrated" }),
    ]);
    expect(green.projects).toHaveLength(1);
    expect(green.projects[0]).toMatchObject({ path: realpathSync(legacyPath) });
    expect(green.projects[0]).not.toHaveProperty("migrationStatus");
    expect(green.projectIdRemap).toEqual({
      "legacy-renderer-id": green.projects[0]!.id,
    });
    expect(await store.list()).toHaveLength(1);
    expect(existsSync(markerFile)).toBe(true);
    expect(localStorage.getItem("codeshell.repos")).toBeNull();
    await expect(service.authorizePath("migration-token", otherPath)).rejects.toThrow(
      /migration.*complete/i,
    );
  });

  test("reads the legacy collection once without making it the live snapshot", () => {
    localStorage.setItem(
      "codeshell.repos",
      JSON.stringify([{ id: "first", name: "first", path: legacyPath, addedAt: 1 }]),
    );
    expect(readLegacyProjectsForMigration().map((project) => project.id)).toEqual(["first"]);

    localStorage.setItem(
      "codeshell.repos",
      JSON.stringify([{ id: "second", name: "second", path: otherPath, addedAt: 2 }]),
    );
    expect(readLegacyProjectsForMigration().map((project) => project.id)).toEqual(["first"]);
  });
});
