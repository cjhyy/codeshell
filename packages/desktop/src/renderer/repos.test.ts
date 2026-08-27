import { beforeEach, describe, expect, it } from "bun:test";
import {
  __resetProjectSnapshotForTest,
  adaptLegacyRepo,
  loadActiveProjectId,
  loadProjects,
  readLegacyProjectsForMigration,
  reconcileProjectsFromDiskWithRemap,
  saveActiveProjectId,
  saveProjects,
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

describe("renderer project authority", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
    __resetProjectSnapshotForTest();
  });

  it("uses the V2 snapshot as the live collection and reads codeshell.repos once for migration", () => {
    localStorage.setItem(
      "codeshell.repos",
      JSON.stringify([
        {
          id: "legacy-id",
          name: "legacy",
          path: "/work/legacy",
          addedAt: 123,
          displayName: "Legacy",
          pinned: true,
        },
      ]),
    );

    expect(loadProjects()).toEqual([]);
    expect(readLegacyProjectsForMigration()).toEqual([
      adaptLegacyRepo({
        id: "legacy-id",
        name: "legacy",
        path: "/work/legacy",
        addedAt: 123,
        displayName: "Legacy",
        pinned: true,
      }),
    ]);

    localStorage.setItem(
      "codeshell.repos",
      JSON.stringify([{ id: "late", name: "late", path: "/late", addedAt: 1 }]),
    );
    expect(readLegacyProjectsForMigration().map((project) => project.id)).toEqual(["legacy-id"]);
  });

  it("updates only the in-memory snapshot and never rewrites codeshell.repos", () => {
    const project: TrackedProject = {
      id: "v2-project",
      name: "CodeShell",
      path: "/work/code-shell",
      roots: [
        {
          id: "v2-root",
          path: "/work/code-shell",
          name: "code-shell",
          addedAt: 123,
        },
      ],
      primaryRootId: "v2-root",
      addedAt: 123,
      pinned: true,
    };

    saveProjects([project]);
    expect(loadProjects()).toEqual([project]);
    expect(localStorage.getItem("codeshell.repos")).toBeNull();
  });

  it("takes project ids, roots, names, and pin state from the V2 snapshot", () => {
    const reconciled = reconcileProjectsFromDiskWithRemap(
      [
        {
          id: "v2-project",
          name: "V2 Name",
          displayName: "V2 Display",
          roots: [
            { id: "primary", path: "/v2", name: "v2", addedAt: 10 },
            { id: "secondary", path: "/shared", name: "shared", addedAt: 11 },
          ],
          primaryRootId: "primary",
          createdAt: 10,
          pinned: true,
        },
      ],
      [
        adaptLegacyRepo({
          id: "legacy-id",
          name: "Legacy",
          path: "/v2",
          addedAt: 1,
          displayName: "Legacy Display",
        }),
      ],
    );

    expect(reconciled.projects).toEqual([
      expect.objectContaining({
        id: "v2-project",
        name: "V2 Name",
        displayName: "V2 Display",
        primaryRootId: "primary",
        pinned: true,
        roots: expect.arrayContaining([expect.objectContaining({ id: "secondary" })]),
      }),
    ]);
    expect(reconciled.projectIdRemap).toEqual({ "legacy-id": "v2-project" });
  });

  it("persists only active selection as UI state", () => {
    saveActiveProjectId("v2-project");
    expect(loadActiveProjectId()).toBe("v2-project");
    saveActiveProjectId(null);
    expect(loadActiveProjectId()).toBeNull();
  });
});
