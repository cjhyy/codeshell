import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { loadDismissedPetWorkItemIds, saveDismissedPetWorkItemIds } from "./petWorkInbox";

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
  test("round-trips hidden work item ids", () => {
    saveDismissedPetWorkItemIds(new Set(["completed:one", "follow-up:two"]));
    expect([...loadDismissedPetWorkItemIds()]).toEqual(["completed:one", "follow-up:two"]);
  });

  test("ignores malformed storage and removes an empty preference", () => {
    localStorage.setItem("codeshell.pet.work-inbox.dismissed.v1", "not-json");
    expect(loadDismissedPetWorkItemIds()).toEqual(new Set());

    saveDismissedPetWorkItemIds(new Set(["completed:one"]));
    saveDismissedPetWorkItemIds(new Set());
    expect(localStorage.getItem("codeshell.pet.work-inbox.dismissed.v1")).toBeNull();
  });
});
