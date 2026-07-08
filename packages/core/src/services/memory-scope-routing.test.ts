import { describe, it, expect, spyOn } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseExtractionResponse } from "./extract-memories.js";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { MemoryManager } from "../session/memory.js";
import { logger } from "../logging/logger.js";

describe("parseExtractionResponse scope", () => {
  it("keeps scope:global; defaults missing/invalid scope to project", () => {
    const json = JSON.stringify([
      { type: "feedback", scope: "global", name: "g", description: "d", content: "c" },
      { type: "project", scope: "project", name: "p", description: "d", content: "c" },
      { type: "project", name: "no-scope", description: "d", content: "c" }, // missing
      { type: "project", scope: "weird", name: "bad-scope", description: "d", content: "c" }, // invalid
    ]);
    const out = parseExtractionResponse(json, 10);
    const byName = new Map(out.map((m) => [m.name, m.scope]));
    expect(byName.get("g")).toBe("global");
    expect(byName.get("p")).toBe("project");
    expect(byName.get("no-scope")).toBe("project");
    expect(byName.get("bad-scope")).toBe("project");
  });
});

describe("MemoryOrchestrator scope routing (global vs project dream store)", () => {
  it("keeps automatic global candidates in project dream evidence and adds a pending approval item", async () => {
    const base = mkdtempSync(join(tmpdir(), "cs-mem-route-"));
    const prevHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = base; // isolate all MemoryManager writes
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const projectDir = "/tmp/routing-project";
      const orchestrator = new MemoryOrchestrator({
        projectDir,
        // recallTtlDays omitted → no sweep interferes
        callLLM: async (sysPrompt) => {
          if (sysPrompt.includes("session summariser")) return "[]";
          return JSON.stringify([
            {
              type: "feedback",
              scope: "global",
              name: "global-lesson",
              description: "d",
              content: "c",
            },
            {
              type: "project",
              scope: "project",
              name: "project-fact",
              description: "d",
              content: "c",
            },
          ]);
        },
      });

      const result = await orchestrator.run([{ role: "user", content: "x" }], "s1");
      expect(result.extracted).toBe(2);

      // Automatic global extraction lands in project dream and waits for approval
      // before it can become an injected global dream memory.
      const pendingNames = new MemoryManager({ baseDir: base, scope: "pending" })
        .loadAll()
        .map((e) => e.name);
      expect(pendingNames).toContain("global-lesson");

      const globalUserNames = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(globalUserNames).not.toContain("global-lesson");

      const globalDream = new MemoryManager({ baseDir: base, scope: "dream" }).loadAll();
      expect(globalDream.map((e) => e.name)).not.toContain("global-lesson");

      const projectNames = new MemoryManager({ baseDir: base, projectDir, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(projectNames).not.toContain("project-fact");
      expect(projectNames).not.toContain("global-lesson");

      const projectDream = new MemoryManager({
        baseDir: base,
        projectDir,
        scope: "dream",
      }).loadAll();
      expect(projectDream.map((e) => e.name)).toContain("global-lesson");
      expect(projectDream.find((e) => e.name === "global-lesson")?.origin).toBe("auto");
      expect(projectDream.find((e) => e.name === "global-lesson")?.promotionStatus).toBe("pending");
      expect(projectDream.map((e) => e.name)).toContain("project-fact");
      expect(projectDream.find((e) => e.name === "project-fact")?.origin).toBe("auto");

      // telemetry split
      const ext = info.mock.calls.find((c) => c[0] === "memory.extraction_done")?.[1] as Record<
        string,
        unknown
      >;
      expect(ext?.globalDreamCount).toBe(0);
      expect(ext?.projectDreamCount).toBe(2);
      expect(ext?.pendingGlobalCount).toBe(1);
    } finally {
      info.mockRestore();
      warn.mockRestore();
      if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prevHome;
      rmSync(base, { recursive: true, force: true });
    }
  });

  it("recallTtlDays prunes a stale project memory at end of run", async () => {
    const base = mkdtempSync(join(tmpdir(), "cs-mem-route-ttl-"));
    const prevHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = base;
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      const projectDir = "/tmp/routing-ttl-project";
      // seed a stale project memory directly
      const seed = new MemoryManager({ baseDir: base, projectDir, scope: "user" });
      seed.save({
        name: "ancient",
        description: "d",
        type: "project",
        content: "c",
        lastUsed: "2000-01-01T00:00:00.000Z",
      });

      const orchestrator = new MemoryOrchestrator({
        projectDir,
        recallTtlDays: 30,
        callLLM: async () => "[]", // no new extractions
      });
      const result = await orchestrator.run([{ role: "user", content: "x" }], "s1");
      expect(result.pruned).toContain("ancient");
      const left = new MemoryManager({ baseDir: base, projectDir, scope: "user" })
        .loadAll()
        .map((e) => e.name);
      expect(left).not.toContain("ancient");
    } finally {
      info.mockRestore();
      warn.mockRestore();
      if (prevHome === undefined) delete process.env.CODE_SHELL_HOME;
      else process.env.CODE_SHELL_HOME = prevHome;
      rmSync(base, { recursive: true, force: true });
    }
  });
});
