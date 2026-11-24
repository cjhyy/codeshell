import { describe, it, expect, spyOn } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { recordSession, sessionsSinceLastDream } from "./auto-dream.js";
import { logger } from "../logging/logger.js";
import { MemoryManager } from "../session/memory.js";

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

describe("MemoryOrchestrator malformed extraction isolation", () => {
  it("keeps valid memories when another candidate has a non-string description", async () => {
    await withCodeShellHome(async (base) => {
      const projectDir = "/tmp/orchestrator-malformed-description";
      const orchestrator = new MemoryOrchestrator({
        projectDir,
        callLLM: async () =>
          JSON.stringify([
            { type: "project", name: "invalid", description: 42, content: "Discard this" },
            {
              type: "project",
              name: "valid",
              description: "Valid memory",
              content: "Keep this useful fact",
            },
          ]),
      });

      await orchestrator.run([{ role: "user", content: "Remember the useful fact" }], "s-valid");

      const saved = new MemoryManager({ baseDir: base, projectDir, scope: "dream" }).loadAll();
      expect(saved).toHaveLength(1);
      expect(saved[0]).toMatchObject({
        name: "valid",
        description: "Valid memory",
        content: "Keep this useful fact",
      });
    });
  });
});

describe("MemoryOrchestrator exact batch duplicates", () => {
  it("persists one copy and lets the next distinct fact use the remaining slot", async () => {
    await withCodeShellHome(async (base) => {
      const projectDir = "/tmp/orchestrator-exact-duplicates";
      const candidate = {
        type: "project",
        scope: "project",
        name: "runtime-choice",
        description: "Project runtime choice",
        content: "Use Bun for this project.",
      };
      const distinct = {
        ...candidate,
        name: "artifact-location",
        description: "Release artifact location",
        content: "Keep release artifacts outside the repository.",
      };
      const orchestrator = new MemoryOrchestrator({
        projectDir,
        callLLM: async () => JSON.stringify([candidate, { ...candidate }, distinct]),
      });
      await orchestrator.run([{ role: "user", content: "Remember these facts" }], "s-duplicates");

      const saved = new MemoryManager({ baseDir: base, projectDir, scope: "dream" }).loadAll();
      expect(saved).toHaveLength(2);
      expect(saved.map((memory) => memory.name).sort()).toEqual([
        "artifact-location",
        "runtime-choice",
      ]);
      expect(saved.filter((memory) => memory.content === candidate.content)).toHaveLength(1);
      expect(saved.every((memory) => memory.origin === "auto")).toBe(true);
    });
  });
});

describe("MemoryOrchestrator makes no session-summary request", () => {
  it("asks the model once for a run that extracts nothing and writes no summary file", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const prompts: string[] = [];
        const orchestrator = new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          callLLM: async (_system, prompt) => {
            prompts.push(prompt);
            return "[]";
          },
        });
        const result = await orchestrator.run(
          [
            { role: "user", content: "a" },
            { role: "assistant", content: "b" },
            { role: "user", content: "c" },
          ],
          "s-no-summary",
        );
        expect(prompts).toHaveLength(1);
        expect(prompts[0]).toContain("memory extraction assistant");
        expect(result.changed).toBe(false);
        expect(existsSync(join(base, "session-memories"))).toBe(false);
      });
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
      await withCodeShellHome(async (base) => {
        const mm = new MemoryManager({ baseDir: base });
        const prompts: string[] = [];
        const orchestrator = new MemoryOrchestrator({
          memoryManager: mm,
          autoExtract: false,
          callLLM: async (_system, prompt) => {
            prompts.push(prompt);
            return "[]";
          },
        });
        const result = await orchestrator.run([{ role: "user", content: "remember this" }], "s1");
        expect(result.extracted).toBe(0);
        expect(mm.loadScope("user")).toHaveLength(0);
        expect(mm.loadScope("dream")).toHaveLength(0);
        expect(prompts.some((p) => p.includes("memory extraction assistant"))).toBe(false);
        const skipped = info.mock.calls.find((c) => c[0] === "memory.extraction_skipped");
        expect(skipped).toBeDefined();
      });
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
  it("honors an explicit same-topic UPDATE by id instead of creating a date variant", async () => {
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
          callLLM: async (system) =>
            system.includes("write decision")
              ? JSON.stringify({
                  action: "UPDATE",
                  target: { id: seeded.id, location: "project", scope: "dream" },
                })
              : JSON.stringify([
                  {
                    type: "project",
                    scope: "project",
                    name: "memory-p0-2026-07-09",
                    description: "memory redesign origin guard",
                    content:
                      "Dream entries must not touch manual memories and should update by id.",
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

describe("MemoryOrchestrator auto-dream cadence counts only runs that changed the store", () => {
  const conversation = [
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ];
  const quiet = async <T>(fn: () => Promise<T>): Promise<T> => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      return await fn();
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  };

  it("leaves the counter alone when extraction yields nothing", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        const result = await new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          callLLM: async () => "[]",
        }).run(conversation, "s-empty");
        expect(result.changed).toBe(false);
        expect(sessionsSinceLastDream(base)).toBe(0);
      }),
    ));

  it("counts a run that added a memory", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        const result = await new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          callLLM: async () =>
            JSON.stringify([{ type: "project", name: "n", description: "d", content: "c" }]),
        }).run(conversation, "s-added");
        expect(result.changed).toBe(true);
        expect(sessionsSinceLastDream(base)).toBe(1);
      }),
    ));

  it("does not count a run with extraction turned off", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        let calls = 0;
        await new MemoryOrchestrator({
          memoryManager: new MemoryManager({ baseDir: base }),
          autoExtract: false,
          callLLM: async () => {
            calls++;
            return "[]";
          },
        }).run(conversation, "s-off");
        expect(calls).toBe(0);
        expect(sessionsSinceLastDream(base)).toBe(0);
      }),
    ));

  it("still runs a consolidation that was already due", () =>
    quiet(() =>
      withCodeShellHome(async (base) => {
        const manager = new MemoryManager({ baseDir: base });
        manager.save({ type: "project", name: "kept", description: "d", content: "c" });
        for (let index = 0; index < 5; index++) recordSession(base);
        let dreams = 0;
        const result = await new MemoryOrchestrator({
          memoryManager: manager,
          callLLM: async () => "[]",
          runDream: async () => {
            dreams++;
            return true;
          },
        }).run(conversation, "s-due");
        expect(dreams).toBe(1);
        expect(result.dreamTriggered).toBe(true);
        expect(sessionsSinceLastDream(base)).toBe(0);
      }),
    ));
});
