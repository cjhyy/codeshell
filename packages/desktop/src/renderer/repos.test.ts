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
