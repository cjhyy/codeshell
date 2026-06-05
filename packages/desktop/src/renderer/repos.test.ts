import { beforeEach, describe, expect, it } from "bun:test";
import {
  isRepoPathRemoved,
  loadRemovedRepoPaths,
  markRepoPathRemoved,
  saveRemovedRepoPaths,
  unmarkRepoPathRemoved,
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
