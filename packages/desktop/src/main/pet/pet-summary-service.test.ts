import { describe, expect, test } from "bun:test";
import { createPetSummaryService } from "./pet-summary-service.js";
import type { PetSummaryEntry, PetSummaryStore } from "./pet-summary-store.js";

function fakeStore(): PetSummaryStore & { entries: Map<string, PetSummaryEntry>; writes: number } {
  const entries = new Map<string, PetSummaryEntry>();
  let writes = 0;
  return {
    entries,
    get writes() {
      return writes;
    },
    load: async () => {},
    get: (id) => entries.get(id),
    set: (id, terminalAt, text) => {
      writes += 1;
      entries.set(id, { terminalAt, text });
    },
    flush: async () => {},
  };
}

describe("createPetSummaryService", () => {
  test("disabled generation reads no transcript, calls no model and leaves no marker for re-enable", async () => {
    const store = fakeStore();
    let allowed = false;
    let reads = 0;
    let generations = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      allowGenerate: () => allowed,
      readClosureInput: async () => {
        reads += 1;
        return "Should the owner publish?";
      },
      generate: async () => {
        generations += 1;
        return "FOLLOW_UP: Decide whether to publish";
      },
      store,
    });
    expect(await service.summarize("session-a", 1_000)).toBeNull();
    expect(await service.summarize("session-a", 1_000)).toBeNull();
    expect({ reads, generations, writes: store.writes, entries: store.entries.size }).toEqual({
      reads: 0,
      generations: 0,
      writes: 0,
      entries: 0,
    });
    allowed = true;
    expect(await service.summarize("session-a", 1_000)).toEqual({
      text: "Decide whether to publish",
    });
    expect({ reads, generations, writes: store.writes }).toEqual({
      reads: 1,
      generations: 1,
      writes: 1,
    });
  });

  test("disabled generation does not overwrite a stale cached result", async () => {
    const store = fakeStore();
    store.set("session-a", 1_000, "Previously generated reminder");
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      store,
      allowGenerate: () => false,
      readClosureInput: async () => {
        throw new Error("Disabled generation must not read source");
      },
      generate: async () => {
        throw new Error("Disabled generation must not call model");
      },
    });
    expect(await service.summarize("session-a", 2_000)).toBeNull();
    expect(store.get("session-a")).toEqual({
      terminalAt: 1_000,
      text: "Previously generated reminder",
    });
    expect(store.writes).toBe(1);
  });

  test("cached text and empty markers remain readable when the generation policy fails", async () => {
    const store = fakeStore();
    store.set("cached", 1_000, "Existing reminder");
    store.set("empty", 1_000, "");
    let policyCalls = 0;
    const service = createPetSummaryService({
      sessionsRootDir: "/root",
      store,
      allowGenerate: () => {
        policyCalls += 1;
        throw new Error("Settings unavailable");
      },
      readClosureInput: async () => {
        throw new Error("Failed policy must not read source");
      },
      generate: async () => {
        throw new Error("Failed policy must not call model");
      },
    });
    expect(await service.summarize("cached", 1_000)).toEqual({ text: "Existing reminder" });
    expect(await service.summarize("empty", 1_000)).toBeNull();
    expect(policyCalls).toBe(0);
    expect(await service.summarize("uncached", 1_000)).toBeNull();
    expect(policyCalls).toBe(1);
    expect(store.writes).toBe(2);
    expect(store.get("uncached")).toBeUndefined();
  });

  test.each([null, "Closure that would require a model"])(
    "policy changes during input read prevent inference and marker writes: %s",
    async (closure) => {
      const store = fakeStore();
      let allowed = true;
      let generations = 0;
      let release!: (text: string | null) => void;
      const input = new Promise<string | null>((resolve) => {
        release = resolve;
      });
      const service = createPetSummaryService({
        sessionsRootDir: "/root",
        store,
        allowGenerate: () => allowed,
        readClosureInput: () => input,
        generate: async () => {
          generations += 1;
          return "FOLLOW_UP: New reminder";
        },
      });
      const pending = service.summarize("session-a", 1_000);
      allowed = false;
      release(closure);
      expect(await pending).toBeNull();
      expect(generations).toBe(0);
      expect(store.writes).toBe(0);
      expect(store.get("session-a")).toBeUndefined();
    },
  );

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
