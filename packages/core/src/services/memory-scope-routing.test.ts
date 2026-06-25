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

describe("MemoryOrchestrator scope routing (global vs project store)", () => {
  it("routes scope:global to the global PENDING store (审批门) and scope:project to the per-project store", async () => {
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
            { type: "feedback", scope: "global", name: "global-lesson", description: "d", content: "c" },
            { type: "project", scope: "project", name: "project-fact", description: "d", content: "c" },
          ]);
        },
      });

      const result = await orchestrator.run([{ role: "user", content: "x" }], "s1");
      expect(result.extracted).toBe(2);

      // 审批门: global-lesson must land in PENDING (NOT auto-injected global user store).
      const pendingNames = new MemoryManager({ baseDir: base, scope: "pending" })
        .loadAll().map((e) => e.name);
      expect(pendingNames).toContain("global-lesson");

      // It must NOT be in the global user store yet (awaiting approval).
      const globalUserNames = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll().map((e) => e.name);
      expect(globalUserNames).not.toContain("global-lesson");

      // Approving moves it into the global user store.
      const pendingMgr = new MemoryManager({ baseDir: base, scope: "pending" });
      expect(pendingMgr.approvePending("global-lesson")).toBeTruthy();
      const afterApprove = new MemoryManager({ baseDir: base, scope: "user" })
        .loadAll().map((e) => e.name);
      expect(afterApprove).toContain("global-lesson");

      // project-fact must land in the PROJECT store (auto, no gate)
      const projectNames = new MemoryManager({ baseDir: base, projectDir, scope: "user" })
        .loadAll().map((e) => e.name);
      expect(projectNames).toContain("project-fact");
      expect(projectNames).not.toContain("global-lesson");

      // telemetry split
      const ext = info.mock.calls.find((c) => c[0] === "memory.extraction_done")?.[1] as Record<string, unknown>;
      expect(ext?.pendingGlobalCount).toBe(1);
      expect(ext?.projectCount).toBe(1);
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
        .loadAll().map((e) => e.name);
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
