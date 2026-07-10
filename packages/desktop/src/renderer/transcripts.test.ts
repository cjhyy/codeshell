import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { INITIAL_STATE } from "./types";
import {
  bucketKey,
  loadSessionIndex,
  loadTranscript,
  NO_REPO_KEY,
  repoKeyOf,
  saveSessionIndex,
  saveTranscript,
} from "./transcripts";

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

  it("keeps no-project and conversation bucket strings byte-identical", () => {
    expect(NO_REPO_KEY).toBe("__no_repo__");
    expect(repoKeyOf(null)).toBe("__no_repo__");
    expect(repoKeyOf("stable-project-id")).toBe("stable-project-id");
    expect(bucketKey(null, null)).toBe("__no_repo__::_none_");
    expect(bucketKey(null, "session-1")).toBe("__no_repo__::session-1");
    expect(bucketKey("stable-project-id", "session-1")).toBe("stable-project-id::session-1");
  });

  it("continues to read and write the legacy session-index and transcript keys", () => {
    const index = {
      sessions: [],
      activeSessionId: null,
    };
    storage.setItem("codeshell.sessionIndex.__no_repo__", JSON.stringify(index));

    expect(loadSessionIndex(null)).toEqual(index);

    saveSessionIndex("stable-project-id", index);
    saveTranscript("stable-project-id", "session-1", {
      ...INITIAL_STATE,
      messages: [],
    });

    expect(storage.getItem("codeshell.sessionIndex.stable-project-id")).toBe(JSON.stringify(index));
    expect(storage.getItem("codeshell.transcript.stable-project-id.session-1")).not.toBeNull();
    expect(storage.getItem("codeshell.projectSessionIndex.stable-project-id")).toBeNull();
    expect(storage.getItem("codeshell.projectTranscript.stable-project-id.session-1")).toBeNull();
  });
});
