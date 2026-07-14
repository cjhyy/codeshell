import { describe, expect, it, spyOn } from "bun:test";
import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../session/memory.js";
import { logger } from "../logging/logger.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import type { ToolCall } from "../types.js";
import { runDreamConsolidation } from "./dream-consolidation.js";

async function withCodeShellHome<T>(fn: (base: string) => Promise<T>): Promise<T> {
  const base = mkdtempSync(join(tmpdir(), "cs-dream-guard-"));
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

function fakeClient(toolCalls: ToolCall[]) {
  let calls = 0;
  return {
    createMessage: async () => {
      calls++;
      return calls === 1 ? { text: "", toolCalls } : { text: "done", toolCalls: [] };
    },
  } as any;
}

function memoryRegistry(): ToolRegistry {
  return new ToolRegistry({
    builtinTools: ["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"],
  });
}

function toolContext(projectDir: string, registry: ToolRegistry): ToolContext {
  return {
    cwd: projectDir,
    llmConfig: { provider: "test", model: "test" },
    toolRegistry: registry,
    planMode: false,
    engine: {
      planMode: false,
      setPlanMode: () => {},
    },
  } as ToolContext;
}

async function runGuardedDream(projectDir: string, toolCalls: ToolCall[]): Promise<void> {
  const registry = memoryRegistry();
  await runDreamConsolidation({
    llmClient: fakeClient(toolCalls),
    toolRegistry: registry,
    toolContext: toolContext(projectDir, registry),
    projectDir,
    sessionId: "s-dream-guard",
  });
}

describe("dream consolidation origin guard", () => {
  it("does not let dream update or delete origin:manual user memories", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/dream-guard-user-manual";
        const user = new MemoryManager({ baseDir: base, projectDir, scope: "user" });
        user.save({
          id: "mem_manual_user",
          name: "manual-user",
          description: "manual description",
          type: "project",
          content: "manual content",
          origin: "manual",
        });

        await runGuardedDream(projectDir, [
          {
            id: "tc_save",
            toolName: "MemorySave",
            args: {
              scope: "user",
              location: "project",
              id: "mem_manual_user",
              name: "manual-user-renamed",
              description: "changed",
              type: "project",
              content: "changed content",
            },
          },
          {
            id: "tc_delete",
            toolName: "MemoryDelete",
            args: { scope: "user", location: "project", name: "manual-user" },
          },
        ]);

        const entries = user.loadAll();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.id).toBe("mem_manual_user");
        expect(entries[0]!.name).toBe("manual-user");
        expect(entries[0]!.content).toBe("manual content");
        expect(entries[0]!.updateCount).toBe(0);
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("does not let dream update or delete origin:manual dream memories", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/dream-guard-dream-manual";
        const dream = new MemoryManager({ baseDir: base, projectDir, scope: "dream" });
        dream.save({
          id: "mem_manual_dream",
          name: "manual-dream",
          description: "manual dream description",
          type: "project",
          content: "manual dream content",
          origin: "manual",
        });

        await runGuardedDream(projectDir, [
          {
            id: "tc_save",
            toolName: "MemorySave",
            args: {
              scope: "dream",
              location: "project",
              id: "mem_manual_dream",
              name: "manual-dream-renamed",
              description: "changed",
              type: "project",
              content: "changed content",
            },
          },
          {
            id: "tc_delete",
            toolName: "MemoryDelete",
            args: { scope: "dream", location: "project", name: "manual-dream" },
          },
        ]);

        const entries = dream.loadAll();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.id).toBe("mem_manual_dream");
        expect(entries[0]!.name).toBe("manual-dream");
        expect(entries[0]!.content).toBe("manual dream content");
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("lets dream create origin:dream user memories", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/dream-guard-user-create";

        await runGuardedDream(projectDir, [
          {
            id: "tc_save",
            toolName: "MemorySave",
            args: {
              scope: "user",
              location: "project",
              name: "durable-lesson",
              description: "durable lesson",
              type: "feedback",
              content: "Keep the durable lesson.",
            },
          },
        ]);

        const entries = new MemoryManager({ baseDir: base, projectDir, scope: "user" }).loadAll();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.origin).toBe("dream");
        expect(entries[0]!.updateCount).toBe(0);
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("does not let dream save a new user memory with the same name as origin:manual", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/dream-guard-user-name-shadow";
        const user = new MemoryManager({ baseDir: base, projectDir, scope: "user" });
        user.save({
          id: "mem_manual_same_name",
          name: "manual-same-name",
          description: "manual description",
          type: "project",
          content: "manual content",
          origin: "manual",
        });

        await runGuardedDream(projectDir, [
          {
            id: "tc_save",
            toolName: "MemorySave",
            args: {
              scope: "user",
              location: "project",
              id: "mem_bogus_missing",
              name: "manual-same-name",
              description: "shadow",
              type: "project",
              content: "shadow content",
            },
          },
        ]);

        const entries = user.loadAll();
        expect(entries).toHaveLength(1);
        expect(entries[0]!.id).toBe("mem_manual_same_name");
        expect(entries[0]!.origin).toBe("manual");
        expect(entries[0]!.content).toBe("manual content");
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });

  it("lets dream update origin:dream user memories by id and rename without adding a file", async () => {
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const warn = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await withCodeShellHome(async (base) => {
        const projectDir = "/tmp/dream-guard-user-update";
        const user = new MemoryManager({ baseDir: base, projectDir, scope: "user" });
        const fileName = user.save({
          id: "mem_dream_user",
          name: "old-lesson",
          description: "old",
          type: "feedback",
          content: "old content",
          origin: "dream",
        });

        await runGuardedDream(projectDir, [
          {
            id: "tc_save",
            toolName: "MemorySave",
            args: {
              scope: "user",
              location: "project",
              id: "mem_dream_user",
              name: "renamed-lesson",
              description: "new",
              type: "feedback",
              content: "new content",
            },
          },
        ]);

        const entries = user.loadAll();
        const markdownFiles = readdirSync(
          join(base, "projects", "tmp-dream-guard-user-update", "memory", "user"),
        ).filter((f) => f.endsWith(".md") && f !== "MEMORY.md");
        expect(markdownFiles).toEqual([fileName]);
        expect(entries).toHaveLength(1);
        expect(entries[0]!.id).toBe("mem_dream_user");
        expect(entries[0]!.name).toBe("renamed-lesson");
        expect(entries[0]!.origin).toBe("dream");
        expect(entries[0]!.updateCount).toBe(1);
      });
    } finally {
      info.mockRestore();
      warn.mockRestore();
    }
  });
});
