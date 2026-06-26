/**
 * Tests for archiveAllSessions — deleting a project must ARCHIVE its sessions
 * (visible + restorable under 设置→高级), not orphan them in localStorage.
 *
 * Before: handleRemoveRepo dropped the project's sessionIndices entry from
 * state; the localStorage index survived but became invisible (no UI path).
 * After: every session is flagged archived in one write, and the project's
 * display label is stamped (deletedProjectLabel) so the archived view can still
 * name a project that's no longer in `repos[]`.
 */
import { describe, it, expect, beforeEach } from "bun:test";
import {
  archiveAllSessions,
  loadDeletedArchivedIndices,
  loadSessionIndex,
  saveSessionIndex,
  type SessionIndex,
} from "./transcripts";

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
  get length(): number {
    return this.data.size;
  }
  key(i: number): string | null {
    return [...this.data.keys()][i] ?? null;
  }
}

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    value: new MemoryStorage(),
    configurable: true,
  });
});

function seed(repoId: string, idx: SessionIndex): void {
  saveSessionIndex(repoId, idx);
}

describe("archiveAllSessions (delete project → archive its sessions)", () => {
  it("flags every session archived and stamps the project label", () => {
    seed("r-1", {
      sessions: [
        { id: "s1", title: "a", createdAt: 1, updatedAt: 2 },
        { id: "s2", title: "b", createdAt: 1, updatedAt: 3 },
      ],
      activeSessionId: "s2",
    });
    const next = archiveAllSessions("r-1", "My Project");
    expect(next.sessions.every((s) => s.archived === true)).toBe(true);
    expect(next.activeSessionId).toBeNull();
    expect(next.deletedProjectLabel).toBe("My Project");
  });

  it("persists across a reload (label + archived flags survive)", () => {
    seed("r-2", {
      sessions: [{ id: "s1", title: "a", createdAt: 1, updatedAt: 2 }],
      activeSessionId: "s1",
    });
    archiveAllSessions("r-2", "Proj 2");
    // A refresh = a brand-new load with no in-memory state.
    const restored = loadSessionIndex("r-2");
    expect(restored.sessions[0]?.archived).toBe(true);
    expect(restored.deletedProjectLabel).toBe("Proj 2");
    expect(restored.activeSessionId).toBeNull();
  });

  it("is idempotent — re-archiving an already-archived index is a no-op on flags", () => {
    seed("r-3", {
      sessions: [{ id: "s1", title: "a", createdAt: 1, updatedAt: 2, archived: true }],
      activeSessionId: null,
    });
    const next = archiveAllSessions("r-3", "Proj 3");
    expect(next.sessions[0]?.archived).toBe(true);
    expect(next.deletedProjectLabel).toBe("Proj 3");
  });

  it("handles an empty index without throwing", () => {
    const next = archiveAllSessions("r-empty", "Empty");
    expect(next.sessions).toEqual([]);
    expect(next.deletedProjectLabel).toBe("Empty");
  });

  it("does NOT stamp deletedProjectLabel on a normal index that was never deleted", () => {
    // Live indices loaded fresh have no label — confirms the field is opt-in.
    seed("r-live", {
      sessions: [{ id: "s1", title: "a", createdAt: 1, updatedAt: 2 }],
      activeSessionId: "s1",
    });
    expect(loadSessionIndex("r-live").deletedProjectLabel).toBeUndefined();
  });
});

describe("loadDeletedArchivedIndices (re-surface deleted projects after restart)", () => {
  it("returns deleted-project indices not in the live repo set", () => {
    // A deleted project (archived + labeled) and a live one.
    seed("r-deleted", {
      sessions: [{ id: "d1", title: "x", createdAt: 1, updatedAt: 2 }],
      activeSessionId: "d1",
    });
    archiveAllSessions("r-deleted", "Gone Project");
    saveSessionIndex("r-live", {
      sessions: [{ id: "s1", title: "x", createdAt: 1, updatedAt: 2 }],
      activeSessionId: "s1",
    });
    // r-empty was deleted but had zero sessions — must NOT resurface.
    archiveAllSessions("r-empty", "Empty");

    const found = loadDeletedArchivedIndices(new Set(["r-live"]));
    expect(Object.keys(found)).toEqual(["r-deleted"]);
    expect(found["r-deleted"]?.deletedProjectLabel).toBe("Gone Project");
  });

  it("ignores live repos and the no-repo bucket", () => {
    saveSessionIndex(null, {
      sessions: [{ id: "n1", title: "n", createdAt: 1, updatedAt: 2 }],
      activeSessionId: "n1",
    });
    seed("r-deleted", {
      sessions: [{ id: "d1", title: "x", createdAt: 1, updatedAt: 2 }],
      activeSessionId: "d1",
    });
    archiveAllSessions("r-deleted", "Gone");
    // r-deleted IS live this time → excluded; no-repo always excluded.
    const found = loadDeletedArchivedIndices(new Set(["r-deleted"]));
    expect(found).toEqual({});
  });

  it("ignores stale indices that were never delete-stamped", () => {
    // An orphaned index with no deletedProjectLabel must not be resurrected.
    saveSessionIndex("r-stale", {
      sessions: [{ id: "s1", title: "x", createdAt: 1, updatedAt: 2, archived: true }],
      activeSessionId: null,
    });
    expect(loadDeletedArchivedIndices(new Set())).toEqual({});
  });
});
