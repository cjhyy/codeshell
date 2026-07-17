import { describe, expect, test } from "bun:test";
import {
  DIGITAL_HUMAN_SELECTION_STORAGE_KEY,
  digitalHumanSelectionsEqual,
  loadDigitalHumanSelection,
  parseDigitalHumanSelection,
  parseStoredDigitalHumanSelection,
  saveDigitalHumanSelection,
  type SelectionStorage,
} from "./selectionStorage";

function createStorage(initial?: string): SelectionStorage & { value: string | null } {
  return {
    value: initial ?? null,
    getItem(key) {
      return key === DIGITAL_HUMAN_SELECTION_STORAGE_KEY ? this.value : null;
    },
    setItem(key, value) {
      if (key === DIGITAL_HUMAN_SELECTION_STORAGE_KEY) this.value = value;
    },
    removeItem(key) {
      if (key === DIGITAL_HUMAN_SELECTION_STORAGE_KEY) this.value = null;
    },
  };
}

describe("digital-human selection persistence", () => {
  test("round-trips a single profile and a bounded team", () => {
    const storage = createStorage();
    saveDigitalHumanSelection({ kind: "single", id: "researcher", label: "Researcher" }, storage);
    expect(loadDigitalHumanSelection(storage)).toEqual({
      kind: "single",
      id: "researcher",
      label: "Researcher",
    });

    saveDigitalHumanSelection(
      {
        kind: "team",
        id: "delivery",
        label: "Delivery",
        members: ["researcher", "developer"],
        mode: "divide",
      },
      storage,
    );
    expect(loadDigitalHumanSelection(storage)).toMatchObject({
      kind: "team",
      id: "delivery",
      members: ["researcher", "developer"],
      mode: "divide",
    });
  });

  test("compares canonical selections without depending on object identity", () => {
    expect(
      digitalHumanSelectionsEqual(
        { kind: "single", id: "researcher", label: "Researcher" },
        { kind: "single", id: "researcher", label: "Researcher" },
      ),
    ).toBe(true);
    expect(
      digitalHumanSelectionsEqual(
        {
          kind: "team",
          id: "delivery",
          label: "Delivery",
          members: ["one", "two"],
          mode: "divide",
        },
        {
          kind: "team",
          id: "delivery",
          label: "Delivery",
          members: ["two", "one"],
          mode: "divide",
        },
      ),
    ).toBe(false);
  });

  test("rejects malformed, oversized, duplicate, and control-character state", () => {
    expect(parseStoredDigitalHumanSelection("{broken")).toBeNull();
    expect(
      parseDigitalHumanSelection({ kind: "single", id: "../escape", label: "Escape" }),
    ).toBeNull();
    expect(
      parseDigitalHumanSelection({ kind: "single", id: "safe", label: "bad\nlabel" }),
    ).toBeNull();
    expect(
      parseDigitalHumanSelection({
        kind: "team",
        id: "team",
        label: "Team",
        members: ["one", "one"],
        mode: "auto",
      }),
    ).toBeNull();
    expect(
      parseDigitalHumanSelection({
        kind: "team",
        id: "team",
        label: "Team",
        members: Array.from({ length: 9 }, (_, index) => `member-${index}`),
        mode: "compare",
      }),
    ).toBeNull();
  });

  test("clears persisted state for null or an invalid programmatic value", () => {
    const storage = createStorage("old");
    saveDigitalHumanSelection(null, storage);
    expect(storage.value).toBeNull();

    storage.value = "old";
    saveDigitalHumanSelection({ kind: "single", id: "../escape", label: "Escape" }, storage);
    expect(storage.value).toBeNull();
  });

  test("fails open when browser storage is unavailable", () => {
    const storage: SelectionStorage = {
      getItem() {
        throw new Error("blocked");
      },
      setItem() {
        throw new Error("blocked");
      },
      removeItem() {
        throw new Error("blocked");
      },
    };
    expect(loadDigitalHumanSelection(storage)).toBeNull();
    expect(() =>
      saveDigitalHumanSelection({ kind: "single", id: "safe", label: "Safe" }, storage),
    ).not.toThrow();
  });
});
