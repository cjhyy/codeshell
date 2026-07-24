import { describe, expect, test } from "bun:test";
import { createPetSummaryService } from "./pet-summary-service.js";
import type { PetSummaryEntry, PetSummaryStore } from "./pet-summary-store.js";

function fakeStore(): PetSummaryStore & { entries: Map<string, PetSummaryEntry> } {
  const entries = new Map<string, PetSummaryEntry>();
  return {
    entries,
    load: async () => {},
    get: (id) => entries.get(id),
    set: (id, terminalAt, text) => {
      entries.set(id, { terminalAt, text });
    },
    flush: async () => {},
  };
}

describe("createPetSummaryService", () => {
  test("value path: generates, stores, and returns the summary", async () => {
    const store = fakeStore();
    let generateCalls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "final assistant message",
      generate: async () => {
        generateCalls += 1;
        return "shipped the fix; want me to also add tests?";
      },
      store,
    });

    const result = await service.summarize("session-a", 1_000);
    expect(result).toEqual({ text: "shipped the fix; want me to also add tests?" });
    expect(generateCalls).toBe(1);
    expect(store.get("session-a")).toEqual({
      terminalAt: 1_000,
      text: "shipped the fix; want me to also add tests?",
    });
  });

  test("cache hit returns stored text without calling generate", async () => {
    const store = fakeStore();
    store.set("session-a", 1_000, "cached summary");
    let generateCalls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "closure",
      generate: async () => {
        generateCalls += 1;
        return "fresh";
      },
      store,
    });

    const result = await service.summarize("session-a", 1_000);
    expect(result).toEqual({ text: "cached summary" });
    expect(generateCalls).toBe(0);
  });

  test("blank generate result stores an empty-marker, returns null, no re-generate", async () => {
    const store = fakeStore();
    let generateCalls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "closure",
      generate: async () => {
        generateCalls += 1;
        return "   ";
      },
      store,
    });

    expect(await service.summarize("session-a", 1_000)).toBeNull();
    expect(store.get("session-a")).toEqual({ terminalAt: 1_000, text: "" });
    expect(generateCalls).toBe(1);

    // Second call sees the empty-marker cache hit and does not re-generate.
    expect(await service.summarize("session-a", 1_000)).toBeNull();
    expect(generateCalls).toBe(1);
  });

  test("NONE sentinel maps to an empty-marker (no value)", async () => {
    const store = fakeStore();
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "closure",
      generate: async () => "NONE",
      store,
    });
    expect(await service.summarize("session-a", 1_000)).toBeNull();
    expect(store.get("session-a")).toEqual({ terminalAt: 1_000, text: "" });
  });

  test("null closure input stores an empty-marker and never calls generate", async () => {
    const store = fakeStore();
    let generateCalls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => null,
      generate: async () => {
        generateCalls += 1;
        return "unused";
      },
      store,
    });

    expect(await service.summarize("session-a", 1_000)).toBeNull();
    expect(generateCalls).toBe(0);
    expect(store.get("session-a")).toEqual({ terminalAt: 1_000, text: "" });
  });

  test("a newer terminalAt re-generates over a stale cached entry", async () => {
    const store = fakeStore();
    store.set("session-a", 1_000, "old summary");
    let generateCalls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "new closure",
      generate: async () => {
        generateCalls += 1;
        return "new summary";
      },
      store,
    });

    const result = await service.summarize("session-a", 2_000);
    expect(result).toEqual({ text: "new summary" });
    expect(generateCalls).toBe(1);
    expect(store.get("session-a")).toEqual({ terminalAt: 2_000, text: "new summary" });
  });

  test("passes the resolved session dir to readClosureInput", async () => {
    const store = fakeStore();
    const seenDirs: string[] = [];
    const service = createPetSummaryService({
      sessionsRootDir: "/root/sessions",
      readClosureInput: async (dir) => {
        seenDirs.push(dir);
        return "closure";
      },
      generate: async () => "summary",
      store,
    });
    await service.summarize("session-a", 1_000);
    expect(seenDirs).toEqual(["/root/sessions/session-a"]);
  });
});
