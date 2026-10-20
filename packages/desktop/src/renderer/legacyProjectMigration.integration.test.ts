import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
} from "node:fs";
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

  test("concurrent empty Main migration tokens complete once and retain completion-only replay", async () => {
    let pickerCalls = 0;
    let writes = 0;
    const complete = store.completeLegacyMigration.bind(store);
    store.completeLegacyMigration = async () => {
      writes++;
      await complete();
    };
    const service = createLegacyProjectMigrationService({
      store,
      pickDirectory: async () => {
        pickerCalls++;
        return null;
      },
    });
    const [first, second] = await Promise.all([service.begin([]), service.begin([])]);
    expect(first.token).toBeString();
    expect(second.token).not.toBe(first.token);
    await expect(
      Promise.all([service.complete(first.token!), service.complete(second.token!)]),
    ).resolves.toEqual([undefined, undefined]);
    const marker = { bytes: readFileSync(markerFile), info: statSync(markerFile) };
    await service.complete(first.token!);
    await service.complete(second.token!);
    expect(readFileSync(markerFile)).toEqual(marker.bytes);
    expect(statSync(markerFile).ino).toBe(marker.info.ino);
    expect(statSync(markerFile).mtimeMs).toBe(marker.info.mtimeMs);
    expect(writes).toBe(1);
    expect(pickerCalls).toBe(0);
    await expect(service.complete("unissued-token")).rejects.toThrow(/invalid|expired/i);
    await expect(service.authorizePath(first.token!, legacyPath)).rejects.toThrow(/complete/i);
    expect(await store.list()).toEqual([]);
    const restartedService = createLegacyProjectMigrationService({
      store,
      pickDirectory: async () => legacyPath,
    });
    await expect(restartedService.begin([])).resolves.toEqual({ completed: true });
    await expect(restartedService.complete(first.token!)).rejects.toThrow(/invalid|expired/i);
  });

  test("parallel renderer startup and later repeated startup complete without migration errors", async () => {
    const service = createLegacyProjectMigrationService({
      store,
      pickDirectory: async () => {
        throw new Error("Empty startup must not request picker authorization");
      },
    });
    const completedTokens: string[] = [];
    const registry = {
      list: () => store.list(),
      beginLegacyMigration: (paths: string[]) => service.begin(paths),
      authorizeLegacyMigration: (token: string, path: string) => service.authorizePath(token, path),
      completeLegacyMigration: async (token: string) => {
        completedTokens.push(token);
        await service.complete(token);
      },
    };
    const startup = async () =>
      migrateLegacyProjects({
        diskProjects: await registry.list(),
        cachedProjects: readLegacyProjectsForMigration(),
        registry,
      });
    const results = await Promise.all([startup(), startup()]);
    expect(results).toEqual([
      { projects: [], projectIdRemap: {}, results: [], completed: true },
      { projects: [], projectIdRemap: {}, results: [], completed: true },
    ]);
    expect(new Set(completedTokens).size).toBe(2);
    const marker = { bytes: readFileSync(markerFile), info: statSync(markerFile) };
    __resetProjectSnapshotForTest();
    await expect(startup()).resolves.toEqual(results[0]);
    expect(completedTokens).toHaveLength(2);
    expect(readFileSync(markerFile)).toEqual(marker.bytes);
    expect(statSync(markerFile).ino).toBe(marker.info.ino);
    expect(statSync(markerFile).mtimeMs).toBe(marker.info.mtimeMs);
    expect(localStorage.getItem("codeshell.repos")).toBeNull();
  });

  test("completion still rejects unissued tokens and pending picker authorization", async () => {
    let releasePicker!: (path: string | null) => void;
    const service = createLegacyProjectMigrationService({
      store,
      pickDirectory: () => new Promise((resolve) => (releasePicker = resolve)),
    });
    const pending = await service.begin([legacyPath]);
    await expect(service.complete("unissued-token")).rejects.toThrow(/invalid|expired/i);
    await expect(service.complete(pending.token!)).rejects.toThrow(/picker authorization/i);
    const authorization = service.authorizePath(pending.token!, legacyPath);
    await expect(service.complete(pending.token!)).rejects.toThrow(/picker authorization/i);
    expect(existsSync(markerFile)).toBe(false);
    releasePicker(null);
    await expect(authorization).resolves.toMatchObject({ status: "reauthorization_required" });
    await expect(service.complete(pending.token!)).rejects.toThrow(/picker authorization/i);
    const empty = await service.begin([]);
    await service.complete(empty.token!);
    await expect(service.complete(pending.token!)).rejects.toThrow();
    await expect(service.authorizePath(pending.token!, legacyPath)).rejects.toThrow(/complete/i);
    expect(await store.list()).toEqual([]);
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
      authorizeLegacyMigration: (token: string, path: string) => service.authorizePath(token, path),
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
