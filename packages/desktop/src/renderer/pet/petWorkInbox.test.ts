import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  loadDismissedPetWorkItemIds,
  newerPetWorkInboxSnapshot,
  normalizePetWorkInboxSnapshot,
  updateDismissedPetWorkItemIds,
} from "./petWorkInbox";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null {
    return this.values.get(key) ?? null;
  }

  setItem(key: string, value: string): void {
    this.values.set(key, value);
  }

  removeItem(key: string): void {
    this.values.delete(key);
  }
}

const originalStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

beforeEach(() => {
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: new MemoryStorage(),
  });
});

afterEach(() => {
  if (originalStorage) Object.defineProperty(globalThis, "localStorage", originalStorage);
  else delete (globalThis as Record<string, unknown>).localStorage;
});

describe("Mimi work inbox dismissal persistence", () => {
  test("migrates legacy localStorage ids into the main-process snapshot once", async () => {
    localStorage.setItem(
      "codeshell.pet.work-inbox.dismissed.v1",
      JSON.stringify(["completed:session-a", "follow-up:session-b"]),
    );
    const updates: unknown[] = [];
    const persistence = {
      getDismissedWorkItemIds: async () => ({
        revision: 2,
        dismissedIds: ["other:session-c"],
      }),
      updateDismissedWorkItemIds: async (update: unknown) => {
        updates.push(update);
        return {
          revision: 3,
          dismissedIds: ["other:session-c", "completed:session-a", "follow-up:session-b"],
        };
      },
    };

    expect(await loadDismissedPetWorkItemIds(persistence)).toEqual({
      revision: 3,
      dismissedIds: ["other:session-c", "completed:session-a", "follow-up:session-b"],
    });
    expect(updates).toEqual([
      {
        action: "add",
        ids: ["completed:session-a", "follow-up:session-b"],
      },
    ]);
    expect(localStorage.getItem("codeshell.pet.work-inbox.dismissed.v1")).toBeNull();
  });

  test("falls back to the legacy value when main IPC is unavailable", async () => {
    localStorage.setItem(
      "codeshell.pet.work-inbox.dismissed.v1",
      JSON.stringify(["completed:session-a", "unscoped", "other:line\nbreak"]),
    );

    expect(
      await loadDismissedPetWorkItemIds({
        getDismissedWorkItemIds: async () => {
          throw new Error("ipc unavailable");
        },
        updateDismissedWorkItemIds: async () => {
          throw new Error("ipc unavailable");
        },
      }),
    ).toEqual({ revision: 0, dismissedIds: ["completed:session-a"] });
  });

  test("uses the authoritative revision and writes only a failure fallback locally", async () => {
    localStorage.setItem(
      "codeshell.pet.work-inbox.dismissed.v1",
      JSON.stringify(["completed:legacy"]),
    );
    expect(
      await updateDismissedPetWorkItemIds(
        {
          getDismissedWorkItemIds: async () => ({ revision: 0, dismissedIds: [] }),
          updateDismissedWorkItemIds: async () => ({
            revision: 7,
            dismissedIds: ["other:session-b"],
          }),
        },
        { action: "add", ids: ["other:session-b"] },
        new Set(["other:session-b"]),
      ),
    ).toEqual({ revision: 7, dismissedIds: ["other:session-b"] });
    expect(localStorage.getItem("codeshell.pet.work-inbox.dismissed.v1")).toBeNull();

    expect(
      await updateDismissedPetWorkItemIds(
        {
          getDismissedWorkItemIds: async () => ({ revision: 0, dismissedIds: [] }),
          updateDismissedWorkItemIds: async () => {
            throw new Error("write failed");
          },
        },
        { action: "add", ids: ["unfinished:session-c"] },
        new Set(["unfinished:session-c"]),
      ),
    ).toBeNull();
    expect(
      JSON.parse(localStorage.getItem("codeshell.pet.work-inbox.dismissed.v1") ?? "[]"),
    ).toEqual(["unfinished:session-c"]);
  });

  test("filters malformed ids and rejects malformed snapshots at the renderer boundary", () => {
    expect(
      normalizePetWorkInboxSnapshot({
        revision: 2,
        dismissedIds: ["completed:session-a", "unscoped"],
      }),
    ).toEqual({ revision: 2, dismissedIds: ["completed:session-a"] });
    expect(normalizePetWorkInboxSnapshot({ revision: -1, dismissedIds: [] })).toBeNull();
    expect(normalizePetWorkInboxSnapshot({ revision: 1, dismissedIds: "bad" })).toBeNull();
  });

  test("never lets an equal-revision old event roll back newer local state", () => {
    expect(
      newerPetWorkInboxSnapshot({ revision: 4, dismissedIds: ["completed:old-session"] }, 4),
    ).toBeNull();
    expect(
      newerPetWorkInboxSnapshot({ revision: 5, dismissedIds: ["completed:new-session"] }, 4),
    ).toEqual({ revision: 5, dismissedIds: ["completed:new-session"] });
  });
});
