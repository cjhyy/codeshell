import { beforeEach, describe, expect, it } from "bun:test";
import {
  isRepoPathRemoved,
  loadRemovedRepoPaths,
  makeCreateRepoForCwd,
  markRepoPathRemoved,
  reconcileReposFromDiskWithRemap,
  saveRemovedRepoPaths,
  unmarkRepoPathRemoved,
  type Repo,
} from "./repos";
import {
  loadActiveProjectId,
  loadProjects,
  loadRemovedProjectPaths,
  makeCreateProjectForCwd,
  reconcileProjectsFromDiskWithRemap,
  saveActiveProjectId,
  saveProjects,
  saveRemovedProjectPaths,
  type TrackedProject,
} from "./projects";

class MemoryStorage {
  private data = new Map<string, string>();

  getItem(key: string): string | null {
    return this.data.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.data.set(key, value);
  }

  removeItem(key: string): void {
    this.data.delete(key);
  }

  clear(): void {
    this.data.clear();
  }
}

describe("canonical project persistence compatibility", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
  });

  it("reads every project field from the legacy storage contracts", () => {
    const projects: TrackedProject[] = [
      {
        id: "stable-project-id",
        name: "code-shell",
        path: "/work/code-shell",
        addedAt: 123,
        displayName: "CodeShell",
        pinned: true,
      },
    ];
    localStorage.setItem("codeshell.repos", JSON.stringify(projects));
    localStorage.setItem("codeshell.activeRepoId", "stable-project-id");
    localStorage.setItem("codeshell.removedRepoPaths", JSON.stringify(["/work/removed/"]));

    expect(loadProjects()).toEqual(projects);
    expect(loadActiveProjectId()).toBe("stable-project-id");
    expect(loadRemovedProjectPaths()).toEqual(["/work/removed"]);
  });

  it("writes only legacy keys with the unchanged JSON shape", () => {
    const projects: TrackedProject[] = [
      {
        id: "stable-project-id",
        name: "code-shell",
        path: "/work/code-shell",
        addedAt: 123,
        displayName: "CodeShell",
        pinned: true,
      },
    ];

    saveProjects(projects);
    saveActiveProjectId("stable-project-id");
    saveRemovedProjectPaths(["/work/removed/"]);

    expect(localStorage.getItem("codeshell.repos")).toBe(JSON.stringify(projects));
    expect(localStorage.getItem("codeshell.activeRepoId")).toBe("stable-project-id");
    expect(localStorage.getItem("codeshell.removedRepoPaths")).toBe(
      JSON.stringify(["/work/removed"]),
    );
    expect(localStorage.getItem("codeshell.projects")).toBeNull();
    expect(localStorage.getItem("codeshell.activeProjectId")).toBeNull();
    expect(localStorage.getItem("codeshell.removedProjectPaths")).toBeNull();
  });

  it("removes the legacy active-project key when the canonical API receives null", () => {
    localStorage.setItem("codeshell.activeRepoId", "stable-project-id");

    saveActiveProjectId(null);

    expect(localStorage.getItem("codeshell.activeRepoId")).toBeNull();
  });

  it("adapts nested helper shapes so canonical callers never need repo names", () => {
    const projects: TrackedProject[] = [];
    const factory = makeCreateProjectForCwd(projects);

    const projectId = factory.createProjectForCwd("/work/new-project");
    expect(projectId).toBeTruthy();
    expect(projects[0]).toMatchObject({ id: projectId, path: "/work/new-project" });
    expect("createRepoForCwd" in factory).toBe(false);

    const reconciled = reconcileProjectsFromDiskWithRemap(
      [{ path: "/work/new-project", name: "new-project" }],
      projects,
    );
    expect(reconciled.projects).toHaveLength(1);
    expect(reconciled.projectIdRemap).toEqual({});
    expect("repos" in reconciled).toBe(false);
    expect("repoIdRemap" in reconciled).toBe(false);
  });
});

describe("removed repo paths", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
  });

  it("marks, normalizes, deduplicates, and unmarks paths", () => {
    markRepoPathRemoved("/repo/app/");
    markRepoPathRemoved("/repo/app");

    expect(loadRemovedRepoPaths()).toEqual(["/repo/app"]);
    expect(isRepoPathRemoved("/repo/app/")).toBe(true);

    unmarkRepoPathRemoved("/repo/app");
    expect(loadRemovedRepoPaths()).toEqual([]);
  });

  it("ignores invalid persisted values", () => {
    localStorage.setItem("codeshell.removedRepoPaths", JSON.stringify(["/ok", 1, "", "/ok/"]));
    expect(loadRemovedRepoPaths()).toEqual(["/ok"]);
  });

  it("saves a normalized unique list", () => {
    saveRemovedRepoPaths(["/a/", "/a", " /b/ "]);
    expect(loadRemovedRepoPaths()).toEqual(["/a", "/b"]);
  });
});

// TODO §9.1 — makeCreateRepoForCwd factory (collapses 5 inline App.tsx
// closures; snapshots the removed-path denylist once instead of re-parsing
// per session).
describe("makeCreateRepoForCwd", () => {
  beforeEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: new MemoryStorage(),
      configurable: true,
    });
  });

  it("creates a repo (pushed into the list, persisted) and reports changed()", () => {
    const list: Repo[] = [];
    const f = makeCreateRepoForCwd(list);
    expect(f.changed()).toBe(false);
    const id = f.createRepoForCwd("/proj/cool-app");
    expect(id).toBeTruthy();
    expect(list).toHaveLength(1);
    expect(list[0].path).toBe("/proj/cool-app");
    expect(list[0].name).toBe("cool-app"); // basename
    expect(f.changed()).toBe(true);
  });

  it("returns null and does NOT create for a removed path", () => {
    markRepoPathRemoved("/proj/gone");
    const list: Repo[] = [];
    const f = makeCreateRepoForCwd(list);
    expect(f.createRepoForCwd("/proj/gone")).toBeNull();
    expect(list).toHaveLength(0);
    expect(f.changed()).toBe(false);
  });

  it("snapshots the denylist at construction (hoisted, not per-call)", () => {
    const list: Repo[] = [];
    const f = makeCreateRepoForCwd(list);
    // Removing the path AFTER the factory was built must not retroactively
    // block it — the snapshot was taken at construction.
    markRepoPathRemoved("/proj/late");
    expect(f.createRepoForCwd("/proj/late")).toBeTruthy();
    expect(list).toHaveLength(1);
  });
});

describe("reconcileReposFromDiskWithRemap", () => {
  it("returns an old repo id to surviving repo id remap for normalized duplicate paths", () => {
    const cached: Repo[] = [
      { id: "old-subdir", name: "desktop", path: "/repo/root", addedAt: 1 },
      { id: "root", name: "root", path: "/repo/root", addedAt: 2 },
    ];

    const plan = reconcileReposFromDiskWithRemap(
      [{ path: "/repo/root", name: "root", pinned: true, addedAt: 3 }],
      cached,
    );

    expect(plan.repos).toEqual([
      { id: "root", name: "root", path: "/repo/root", addedAt: 3, pinned: true },
    ]);
    expect(plan.repoIdRemap).toEqual({ "old-subdir": "root" });
  });
});
