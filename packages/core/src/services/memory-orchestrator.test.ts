import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { homedir, tmpdir } from "node:os";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { logger } from "../logging/logger.js";
import { MemoryManager } from "../session/memory.js";

function fakeMemoryManager() {
  return {
    loadAll: () => [],
    save: () => {},
    loadScope: () => [],
  } as any;
}

async function withCodeShellHome<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), "cs-mem-orch-"));
  const prevHome = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = base;
  try {
    return await fn(base);
  } finally {
    if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = prevHome;
    rmSync(base, { recursive: true, force: true });
  }
}

describe("MemoryOrchestrator extraction telemetry", () => {
  it("logs stage timings so elapsedMs spikes are diagnosable", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async () => {
        const orchestrator = new MemoryOrchestrator({
          projectDir: "/tmp/orchestrator-telemetry",
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
      });

      const extractionLog = info.mock.calls.find((call) => call[0] === "memory.extraction_done");
      expect(extractionLog).toBeDefined();
      const data = extractionLog?.[1] as Record<string, unknown>;
      expect(data.extracted).toBe(1);
      expect(data.projectDreamCount).toBe(1);
      expect(data.globalDreamCount).toBe(0);
      expect(data.addCount).toBe(1);
      expect(data.updateCount).toBe(0);
      expect(data.noopCount).toBe(0);
      expect(data.deleteCount).toBe(0);
      expect(data.guardedManualCount).toBe(0);
      expect(data.pendingGlobalCount).toBe(0);
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

describe("MemoryOrchestrator redacts secrets before persisting an auto-extracted memory", () => {
  // The extraction prompt TELLS the model not to include secrets, but a prompt
  // is not a guarantee — an auto-extracted memory is written to disk with no
  // user review (origin:auto). Defense-in-depth: run description/content through
  // the same redactSecrets the logging path uses, so a leaked key never persists.
  it("strips a Bearer token / URL credential the model wrongly put in a memory", async () => {
    const saved: Array<{ description: string; content: string }> = [];
    await withCodeShellHome(async (base) => {
      const projectDir = "/tmp/orchestrator-secret";
      const orchestrator = new MemoryOrchestrator({
        projectDir,
        callLLM: async () =>
          JSON.stringify([
            {
              type: "reference",
              name: "api-access",
              description: "Fetch via https://api.acme.com/v1/data?api_key=SUPERSECRETVALUE123",
              content: "Authorization: Bearer sk-proj-ABCDEF1234567890ABCDEF1234567890",
            },
          ]),
      });

      await orchestrator.run([{ role: "user", content: "save my access" }], "s-secret");
      saved.push(...new MemoryManager({ baseDir: base, projectDir, scope: "dream" }).loadAll());
    });

    expect(saved).toHaveLength(1);
    const all = saved[0]!.description + " " + saved[0]!.content;
    // Bearer tokens and URL credential query params are scrubbed before persist
    // (same redactSecrets the logging path uses). NOTE: a bare key sitting in
    // free prose is NOT pattern-matched — that residual still relies on the
    // extraction prompt's "never include secrets" instruction.
    expect(all).not.toContain("sk-proj-ABCDEF1234567890ABCDEF1234567890");
    expect(all).not.toContain("SUPERSECRETVALUE123");
  });
});

describe("MemoryOrchestrator session-summary JSON robustness", () => {
  // The session-summary step (step 2) used to do a naive
  // `smResponse.match(/\{[\s\S]*\}/)` + bare JSON.parse, so any LLM reply with a
  // markdown fence / trailing comma / surrounding prose blew up into a
  // `memory.session_memory_failed` warn and the summary was silently lost
  // (observed in session s-mqhh533p). These cases must now parse cleanly.
  const FRAGILE_RESPONSES: Record<string, string> = {
    "markdown fence":
      '```json\n{"summary":"did stuff","keyTopics":["a","b"],"decisions":["x"]}\n```',
    "trailing comma": '{"summary":"did stuff","keyTopics":["a","b",],"decisions":["x",]}',
    "prose around object":
      'Here is the summary:\n{"summary":"did stuff","keyTopics":["a"],"decisions":[]}\nHope that helps!',
  };

  for (const [name, reply] of Object.entries(FRAGILE_RESPONSES)) {
    it(`parses a ${name} reply without logging session_memory_failed`, async () => {
      const info = spyOn(logger, "info").mockImplementation(() => {});
      const warn = spyOn(logger, "warn").mockImplementation(() => {});
      try {
        // Extraction step gets valid []; only the summary step sees the fragile
        // reply. Distinguish by the system prompt (summariser vs extractor).
        const orchestrator = new MemoryOrchestrator({
          memoryManager: fakeMemoryManager(),
          callLLM: async (sysPrompt) => (sysPrompt.includes("session summariser") ? reply : "[]"),
        });
        // ≥3 non-system messages so the summary step actually runs.
        await orchestrator.run(
          [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
          ],
          "s-fragile",
        );
        const failed = warn.mock.calls.find((c) => c[0] === "memory.session_memory_failed");
        expect(failed).toBeUndefined();
      } finally {
        info.mockRestore();
        warn.mockRestore();
        // saveSessionMemory writes ~/.code-shell/session-memories/<id>.json on a
        // successful parse — clean up so the test doesn't pollute real disk.
        try {
          rmSync(join(homedir(), ".code-shell", "session-memories", "s-fragile.json"), {
            force: true,
          });
        } catch {
          /* best-effort */
        }
      }
    });
  }
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

      const result = await orchestrator.run([{ role: "user", content: "remember this" }], "s1");

      expect(result.extracted).toBe(0);
      expect(saves).toBe(0);
      // The extraction call never happens; the session-summary step (step 2)
      // may still call the LLM — assert none of the calls were extraction.
      expect(systemPrompts.some((p) => p.includes("memory extraction assistant"))).toBe(false);
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
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/orchestrator-default";
        const orchestrator = new MemoryOrchestrator({
          projectDir,
          callLLM: async () =>
            JSON.stringify([{ type: "project", name: "n", description: "d", content: "c" }]),
        });

        const result = await orchestrator.run([{ role: "user", content: "remember this" }], "s1");
        expect(result.extracted).toBe(1);
        expect(
          new MemoryManager({ baseDir: base, projectDir, scope: "dream" }).loadAll(),
        ).toHaveLength(1);
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});

describe("MemoryOrchestrator write decisions", () => {
  it("updates an existing same-topic auto dream memory by id instead of creating a date variant", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/orchestrator-update";
        const dream = new MemoryManager({ baseDir: base, projectDir, scope: "dream" });
        dream.save({
          name: "memory-p0-2026-07-08",
          description: "memory redesign origin guard",
          type: "project",
          content: "Dream entries must not touch manual memories.",
          origin: "auto",
        });
        const seeded = dream.loadAll()[0]!;

        const orchestrator = new MemoryOrchestrator({
          projectDir,
          callLLM: async () =>
            JSON.stringify([
              {
                type: "project",
                scope: "project",
                name: "memory-p0-2026-07-09",
                description: "memory redesign origin guard",
                content: "Dream entries must not touch manual memories and should update by id.",
              },
            ]),
        });

        await orchestrator.run([{ role: "user", content: "same topic" }], "s-update");

        const entries = dream.loadAll();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.id).toBe(seeded.id);
        expect(entries[0]!.name).toBe("memory-p0-2026-07-09");
        expect(entries[0]!.updateCount).toBe(1);
      });

      const ext = info.mock.calls.find((c) => c[0] === "memory.extraction_done")?.[1] as Record<
        string,
        unknown
      >;
      expect(ext?.addCount).toBe(0);
      expect(ext?.updateCount).toBe(1);
      expect(ext?.noopCount).toBe(0);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("noops when an automatic candidate duplicates a manual user memory", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/orchestrator-manual-noop";
        const user = new MemoryManager({ baseDir: base, projectDir, scope: "user" });
        user.save({
          name: "memory-origin-guard",
          description: "dream must not change manual memory",
          type: "project",
          content: "Manual entry stays curated.",
          origin: "manual",
        });

        const orchestrator = new MemoryOrchestrator({
          projectDir,
          callLLM: async () =>
            JSON.stringify([
              {
                type: "project",
                scope: "project",
                name: "memory-origin-guard-2026-07-09",
                description: "dream must not change manual memory",
                content: "Manual entry stays curated with extra words.",
              },
            ]),
        });

        await orchestrator.run([{ role: "user", content: "same manual topic" }], "s-noop");

        expect(user.loadAll()).toHaveLength(1);
        expect(user.loadAll()[0]!.content).toBe("Manual entry stays curated.");
        expect(
          new MemoryManager({ baseDir: base, projectDir, scope: "dream" }).loadAll(),
        ).toHaveLength(0);
      });

      const ext = info.mock.calls.find((c) => c[0] === "memory.extraction_done")?.[1] as Record<
        string,
        unknown
      >;
      expect(ext?.addCount).toBe(0);
      expect(ext?.updateCount).toBe(0);
      expect(ext?.noopCount).toBe(1);
      expect(ext?.guardedManualCount).toBe(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
