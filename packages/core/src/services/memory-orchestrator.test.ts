import { describe, it, expect, spyOn } from "bun:test";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { logger } from "../logging/logger.js";

function fakeMemoryManager() {
  return {
    loadAll: () => [],
    save: () => {},
    loadScope: () => [],
  } as any;
}

describe("MemoryOrchestrator extraction telemetry", () => {
  it("logs stage timings so elapsedMs spikes are diagnosable", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const orchestrator = new MemoryOrchestrator({
        memoryManager: fakeMemoryManager(),
        callLLM: async () =>
          JSON.stringify([
            {
              type: "project",
              name: "test-memory",
              description: "desc",
              content: "content",
            },
          ]),
      });

      await orchestrator.run([{ role: "user", content: "remember this" }], "s1");

      const extractionLog = info.mock.calls.find((call) => call[0] === "memory.extraction_done");
      expect(extractionLog).toBeDefined();
      const data = extractionLog?.[1] as Record<string, unknown>;
      expect(data.extracted).toBe(1);
      expect(data.elapsedMs).toBeNumber();
      expect(data.loadMs).toBeNumber();
      expect(data.promptMs).toBeNumber();
      expect(data.llmMs).toBeNumber();
      expect(data.parseMs).toBeNumber();
      expect(data.saveMs).toBeNumber();
      expect(data.existingCount).toBe(0);
      expect(data.transcriptMessages).toBe(1);
      expect(data.responseChars).toBeGreaterThan(0);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("MemoryOrchestrator autoExtract gate (settings.memories.autoExtract)", () => {
  it("autoExtract:false skips extraction — no save, no extraction LLM call", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      let saves = 0;
      const mm = {
        loadAll: () => [],
        save: () => {
          saves++;
        },
        loadScope: () => [],
      } as any;
      const systemPrompts: string[] = [];
      const orchestrator = new MemoryOrchestrator({
        memoryManager: mm,
        autoExtract: false,
        callLLM: async (sysPrompt) => {
          systemPrompts.push(sysPrompt);
          return "[]";
        },
      });

      const result = await orchestrator.run(
        [{ role: "user", content: "remember this" }],
        "s1",
      );

      expect(result.extracted).toBe(0);
      expect(saves).toBe(0);
      // The extraction call never happens; the session-summary step (step 2)
      // may still call the LLM — assert none of the calls were extraction.
      expect(
        systemPrompts.some((p) => p.includes("memory extraction assistant")),
      ).toBe(false);
      const skipped = info.mock.calls.find((c) => c[0] === "memory.extraction_skipped");
      expect(skipped).toBeDefined();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("absent autoExtract keeps extracting (default-on)", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      let saves = 0;
      const mm = {
        loadAll: () => [],
        save: () => {
          saves++;
        },
        loadScope: () => [],
      } as any;
      const orchestrator = new MemoryOrchestrator({
        memoryManager: mm,
        callLLM: async () =>
          JSON.stringify([
            { type: "project", name: "n", description: "d", content: "c" },
          ]),
      });

      const result = await orchestrator.run(
        [{ role: "user", content: "remember this" }],
        "s1",
      );
      expect(result.extracted).toBe(1);
      expect(saves).toBe(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
