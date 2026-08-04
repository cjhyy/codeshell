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
        return "FOLLOW_UP: want me to also add tests?";
      },
      store,
    });

    const result = await service.summarize("session-a", 1_000);
    expect(result).toEqual({ text: "want me to also add tests?" });
    expect(generateCalls).toBe(1);
    expect(store.get("session-a")).toEqual({
      terminalAt: 1_000,
      text: "want me to also add tests?",
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

  test("rejects explanatory prose and overlong output instead of creating false follow-ups", async () => {
    for (const raw of [
      "工作已完成，没有待跟进的追问。",
      "NONE。",
      "FOLLOW_UP: 要不要我再补测试？\n这是额外解释。",
      "```\nFOLLOW_UP: 要不要我再补测试？\n```",
      `FOLLOW_UP: ${"很".repeat(81)}`,
    ]) {
      const store = fakeStore();
      const service = createPetSummaryService({
        sessionsRootDir: "/root",
        readClosureInput: async () => "closure",
        generate: async () => raw,
        store,
      });
      expect(await service.summarize("session-a", 1_000)).toBeNull();
      expect(store.get("session-a")?.text).toBe("");
    }
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
        return "FOLLOW_UP: new summary";
      },
      store,
    });

    const result = await service.summarize("session-a", 2_000);
    expect(result).toEqual({ text: "new summary" });
    expect(generateCalls).toBe(1);
    expect(store.get("session-a")).toEqual({ terminalAt: 2_000, text: "new summary" });
  });

  test("dedups concurrent summarize calls for the same (sessionId, terminalAt)", async () => {
    const store = fakeStore();
    let generateCalls = 0;
    let releaseGenerate: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      releaseGenerate = resolve;
    });
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "closure",
      generate: async () => {
        generateCalls += 1;
        await gate;
        return "FOLLOW_UP: shared summary";
      },
      store,
    });

    const first = service.summarize("session-a", 1_000);
    const second = service.summarize("session-a", 1_000);
    releaseGenerate!();
    const [a, b] = await Promise.all([first, second]);

    expect(generateCalls).toBe(1);
    expect(a).toEqual({ text: "shared summary" });
    expect(b).toEqual({ text: "shared summary" });

    // After settling, a fresh call is served from the store, still no re-generate.
    expect(await service.summarize("session-a", 1_000)).toEqual({ text: "shared summary" });
    expect(generateCalls).toBe(1);
  });

  test("a different terminalAt is not deduped against an in-flight older one", async () => {
    const store = fakeStore();
    const closuresByCall: string[] = [];
    let calls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => `closure-${calls}`,
      generate: async (closureText) => {
        calls += 1;
        closuresByCall.push(closureText);
        return `FOLLOW_UP: summary-${calls}`;
      },
      store,
    });

    await Promise.all([
      service.summarize("session-a", 1_000),
      service.summarize("session-a", 2_000),
    ]);
    // Distinct terminalAt keys → two independent generations.
    expect(calls).toBe(2);
  });

  test("a slower old generation cannot overwrite a newer completion", async () => {
    const store = fakeStore();
    let releaseOld: (() => void) | undefined;
    const oldGate = new Promise<void>((resolve) => {
      releaseOld = resolve;
    });
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async (_dir) => "closure",
      generate: async () => {
        if (!store.get("session-a")) await oldGate;
        return store.get("session-a") ? "FOLLOW_UP: old result" : "FOLLOW_UP: newer result";
      },
      store,
    });

    const old = service.summarize("session-a", 1_000);
    // Let the newer completion finish while the old generation is held.
    const newerService = createPetSummaryService({
      sessionsRootDir: "/root",
      readClosureInput: async () => "new closure",
      generate: async () => "FOLLOW_UP: newer result",
      store,
    });
    expect(await newerService.summarize("session-a", 2_000)).toEqual({ text: "newer result" });
    releaseOld!();
    await old;

    expect(store.get("session-a")).toEqual({ terminalAt: 2_000, text: "newer result" });
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
      generate: async () => "FOLLOW_UP: summary",
      store,
    });
    await service.summarize("session-a", 1_000);
    expect(seenDirs).toEqual(["/root/sessions/session-a"]);
  });
});
