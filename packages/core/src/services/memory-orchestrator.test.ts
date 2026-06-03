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
