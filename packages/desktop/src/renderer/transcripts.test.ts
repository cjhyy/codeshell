import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { INITIAL_STATE } from "./types";
import { loadTranscript, NO_REPO_KEY, saveTranscript } from "./transcripts";

type StorageLike = Pick<Storage, "getItem" | "setItem" | "removeItem" | "clear">;

function createStorage(): StorageLike {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => {
      items.set(key, value);
    },
    removeItem: (key) => {
      items.delete(key);
    },
    clear: () => {
      items.clear();
    },
  };
}

describe("transcript snapshot cursor persistence", () => {
  const originalLocalStorage = globalThis.localStorage;
  let storage: StorageLike;

  beforeEach(() => {
    storage = createStorage();
    Object.defineProperty(globalThis, "localStorage", {
      value: storage,
      configurable: true,
    });
  });

  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", {
      value: originalLocalStorage,
      configurable: true,
    });
  });

  it("round-trips snapshotSeq through saveTranscript/loadTranscript", () => {
    saveTranscript(null, "s1", {
      ...INITIAL_STATE,
      snapshotSeq: 42,
      messages: [{ kind: "assistant", id: "a1", text: "hi", done: true }],
    });

    expect(loadTranscript(null, "s1").snapshotSeq).toBe(42);
  });

  it("defaults legacy saved transcripts without snapshotSeq to 0", () => {
    storage.setItem(`codeshell.transcript.${NO_REPO_KEY}.legacy`, JSON.stringify({ messages: [] }));

    expect(loadTranscript(null, "legacy").snapshotSeq).toBe(0);
  });
});
