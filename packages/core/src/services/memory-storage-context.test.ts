import { expect, spyOn, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../session/memory.js";
import { MemoryOrchestrator } from "./memory-orchestrator.js";
import { runDreamConsolidation } from "./dream-consolidation.js";
import { sessionsSinceLastDream } from "./auto-dream.js";
import { loadSessionMemory } from "./session-memory.js";
import { ToolRegistry } from "../tool-system/registry.js";
import type { ToolContext } from "../tool-system/context.js";
import type { ToolCall } from "../types.js";
import { logger } from "../logging/logger.js";
import * as settings from "../settings/manager.js";

const candidate = {
  type: "project",
  scope: "project",
  name: "custom routing",
  description: "isolated storage experiment",
  content: "custom payload",
} as const;

async function isolated(
  run: (roots: {
    custom: string;
    ambient: string;
    projectDir: string;
    home: string;
  }) => Promise<void>,
) {
  const root = mkdtempSync(join(tmpdir(), "cs-memory-context-"));
  const roots = {
    custom: join(root, "custom"),
    ambient: join(root, "ambient"),
    projectDir: join(root, "workspace"),
    home: join(root, "home"),
  };
  const previous = process.env.CODE_SHELL_HOME;
  process.env.CODE_SHELL_HOME = roots.ambient;
  const home = spyOn(settings, "userHome").mockReturnValue(roots.home);
  const info = spyOn(logger, "info").mockImplementation(() => {});
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    await run(roots);
  } finally {
    home.mockRestore();
    info.mockRestore();
    warn.mockRestore();
    if (previous === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previous;
    rmSync(root, { recursive: true, force: true });
  }
}

function manager(
  baseDir: string,
  projectDir?: string,
  scope: "user" | "dream" | "pending" = "user",
) {
  return new MemoryManager({ baseDir, projectDir, scope });
}

test("injected storage owns extraction reads, ADD and global pending evidence", async () =>
  isolated(async ({ custom, ambient, projectDir }) => {
    const injected = manager(custom, projectDir);
    injected.save({
      ...candidate,
      id: "custom-user",
      name: "local seed",
      description: "local unique context",
    });
    manager(ambient, projectDir, "dream").save({
      ...candidate,
      id: "foreign-auto",
      origin: "auto",
    });
    let prompt = "";
    await new MemoryOrchestrator({
      memoryManager: injected,
      callLLM: async (_system, text) => {
        prompt ||= text;
        return JSON.stringify([
          candidate,
          {
            ...candidate,
            type: "feedback",
            scope: "global",
            name: "response language",
            description: "preferred language",
            content: "Use Chinese",
          },
        ]);
      },
    }).run([{ role: "user", content: "Remember useful information" }], "isolated-add");
    expect(prompt).toContain("custom-user");
    expect(prompt).not.toContain("foreign-auto");
    expect(
      manager(custom, projectDir, "dream")
        .loadAll()
        .map((m) => m.name)
        .sort(),
    ).toEqual(["custom routing", "response language"]);
    expect(manager(custom, undefined, "pending").loadAll()).toHaveLength(1);
    expect(manager(ambient, undefined, "pending").loadAll()).toHaveLength(0);
    expect(manager(ambient, projectDir, "dream").findById("foreign-auto")?.content).toBe(
      candidate.content,
    );
  }));

test("UPDATE and DELETE only touch IDs in the injected root", async () =>
  isolated(async ({ custom, ambient, projectDir }) => {
    for (const baseDir of [custom, ambient]) {
      const store = manager(baseDir, projectDir, "dream");
      store.save({
        ...candidate,
        id: "update-owned",
        name: "runtime choice",
        description: "runtime choice",
        content: "original",
        origin: "auto",
      });
      store.save({
        ...candidate,
        id: "delete-owned",
        name: "obsolete route",
        description: "obsolete route",
        content: "original",
        origin: "dream",
      });
    }
    await new MemoryOrchestrator({
      projectDir,
      memoryManager: manager(custom, projectDir),
      callLLM: async (system, prompt) => {
        if (system.includes("write decision")) {
          const name = JSON.parse(prompt.split("Candidate:\n")[1]!.split("\n\nRelated")[0]!).name;
          return JSON.stringify({
            action: name === "runtime choice" ? "UPDATE" : "DELETE",
            target: {
              id: name === "runtime choice" ? "update-owned" : "delete-owned",
              location: "project",
              scope: "dream",
            },
          });
        }
        return JSON.stringify([
          { ...candidate, name: "runtime choice", description: "runtime choice" },
          { ...candidate, name: "obsolete route", description: "obsolete route" },
        ]);
      },
    }).run([{ role: "user", content: "Remember useful information" }], "isolated-update");
    expect(manager(custom, projectDir, "dream").findById("update-owned")?.content).toBe(
      candidate.content,
    );
    expect(manager(custom, projectDir, "dream").findById("delete-owned")).toBeUndefined();
    expect(manager(ambient, projectDir, "dream").findById("update-owned")?.content).toBe(
      "original",
    );
    expect(manager(ambient, projectDir, "dream").findById("delete-owned")?.content).toBe(
      "original",
    );
  }));

test("summary, dream cadence, callback and TTL share explicit storage", async () =>
  isolated(async ({ custom, ambient, projectDir, home }) => {
    for (const baseDir of [custom, ambient]) {
      for (const project of [projectDir, undefined]) {
        manager(baseDir, project).save({
          ...candidate,
          id: "old-project",
          lastUsedAt: "2000-01-01T00:00:00.000Z",
        });
      }
      writeFileSync(
        join(baseDir, "auto-dream-state.json"),
        JSON.stringify({ lastDreamAt: null, sessionsSinceLastDream: baseDir === custom ? 4 : 99 }),
      );
    }
    let dreamInput: any;
    await new MemoryOrchestrator({
      memoryManager: manager(custom, projectDir),
      autoExtract: false,
      recallTtlDays: 30,
      callLLM: async () =>
        JSON.stringify({ summary: "isolated summary", keyTopics: [], decisions: [] }),
      runDream: async (input) => {
        dreamInput = input;
        return true;
      },
    }).run(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "isolated-summary",
    );
    expect(dreamInput).toMatchObject({ baseDir: custom, projectDir });
    expect(loadSessionMemory("isolated-summary", custom)?.summary).toBe("isolated summary");
    expect(existsSync(join(home, ".code-shell", "session-memories", "isolated-summary.json"))).toBe(
      false,
    );
    expect(sessionsSinceLastDream(custom)).toBe(0);
    expect(sessionsSinceLastDream(ambient)).toBe(99);
    for (const project of [projectDir, undefined]) {
      expect(manager(custom, project).findById("old-project")).toBeUndefined();
      expect(manager(ambient, project).findById("old-project")).toBeDefined();
    }
  }));

test("explicit baseDir works without a manager and conflicts are rejected before side effects", async () =>
  isolated(async ({ custom, ambient, projectDir }) => {
    await new MemoryOrchestrator({
      baseDir: custom,
      projectDir,
      callLLM: async () => JSON.stringify([candidate]),
    }).run([{ role: "user", content: "a" }], "explicit-root");
    expect(manager(custom, projectDir, "dream").loadAll()).toHaveLength(1);
    expect(existsSync(join(ambient, "auto-dream-state.json"))).toBe(false);
    const options = {
      baseDir: ambient,
      projectDir,
      memoryManager: manager(custom, projectDir),
      callLLM: async () => "[]",
    };
    expect(() => new MemoryOrchestrator(options)).toThrow(/storage|baseDir/i);
    expect(
      () =>
        new MemoryOrchestrator({ ...options, baseDir: custom, projectDir: `${projectDir}-other` }),
    ).toThrow(/projectDir/i);
  }));

test("equivalent path options retain the injected manager's project storage key", async () =>
  isolated(async ({ custom, projectDir }) => {
    const injected = manager(custom, projectDir);
    injected.save(candidate);
    writeFileSync(
      join(custom, "auto-dream-state.json"),
      JSON.stringify({ lastDreamAt: null, sessionsSinceLastDream: 4 }),
    );
    let restoredProject: string | undefined;
    await new MemoryOrchestrator({
      memoryManager: injected,
      projectDir: `${projectDir}/`,
      autoExtract: false,
      callLLM: async () => "[]",
      runDream: async ({ projectDir: project }) => {
        restoredProject = project;
        return true;
      },
    }).run([{ role: "user", content: "a" }], "same-project-key");
    expect(restoredProject).toBe(projectDir);
  }));

test("tool context isolates project/global roots while keeping portable profile storage separate", async () =>
  isolated(async ({ custom, ambient, projectDir }) => {
    const registry = new ToolRegistry({
      builtinTools: ["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"],
    });
    const profile = join(projectDir, "portable-profile");
    const ctx = {
      cwd: projectDir,
      memoryBaseDir: custom,
      profileMemoryDir: profile,
      toolRegistry: registry,
      planMode: false,
    } as ToolContext;
    for (const location of ["project", "global", "profile"]) {
      const result = await registry.executeTool(
        "MemorySave",
        { ...candidate, scope: "user", location, name: `${location} fact` },
        { ctx },
      );
      expect(result.isError).not.toBe(true);
    }
    expect(
      manager(custom, projectDir)
        .loadAll()
        .map((m) => m.name),
    ).toEqual(["project fact"]);
    expect(
      manager(custom)
        .loadAll()
        .map((m) => m.name),
    ).toEqual(["global fact"]);
    expect(
      manager(profile)
        .loadAll()
        .map((m) => m.name),
    ).toEqual(["profile fact"]);
    expect(manager(ambient, projectDir).loadAll()).toHaveLength(0);
    expect(manager(ambient).loadAll()).toHaveLength(0);
  }));

test("default routing retains env memories/cadence and HOME session summaries", async () =>
  isolated(async ({ ambient, projectDir, home }) => {
    await new MemoryOrchestrator({
      projectDir,
      callLLM: async (system) =>
        system.includes("summariser")
          ? JSON.stringify({ summary: "default summary", keyTopics: [], decisions: [] })
          : JSON.stringify([candidate]),
    }).run(
      [
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
        { role: "user", content: "c" },
      ],
      "default-summary",
    );
    expect(manager(ambient, projectDir, "dream").loadAll()).toHaveLength(1);
    expect(existsSync(join(ambient, "auto-dream-state.json"))).toBe(true);
    expect(loadSessionMemory("default-summary", join(home, ".code-shell"))?.summary).toBe(
      "default summary",
    );
    expect(loadSessionMemory("default-summary", ambient)).toBeNull();
  }));

test("dream prompt, ownership guard and actual tools use the same explicit root", async () =>
  isolated(async ({ custom, ambient, projectDir }) => {
    for (const baseDir of [custom, ambient]) {
      const store = manager(baseDir, projectDir, "dream");
      store.save({ ...candidate, id: "owned", name: "owned target", origin: "auto" });
      store.save({
        ...candidate,
        id: "manual",
        name: "manual target",
        origin: baseDir === custom ? "manual" : "auto",
      });
      store.save({
        ...candidate,
        id: "remove",
        name: "old target",
        origin: "auto",
        createdAt: "2000-01-01T00:00:00.000Z",
      });
    }
    const registry = new ToolRegistry({
      builtinTools: ["MemoryList", "MemoryRead", "MemorySave", "MemoryDelete"],
    });
    const calls: ToolCall[] = [
      { id: "list", toolName: "MemoryList", args: { scope: "dream", location: "project" } },
      {
        id: "read",
        toolName: "MemoryRead",
        args: { scope: "dream", location: "project", name: "owned target" },
      },
      {
        id: "save",
        toolName: "MemorySave",
        args: {
          ...candidate,
          id: "owned",
          name: "owned target",
          scope: "dream",
          location: "project",
          content: "dream update",
        },
      },
      {
        id: "protected",
        toolName: "MemorySave",
        args: {
          ...candidate,
          id: "manual",
          name: "manual target",
          scope: "dream",
          location: "project",
          content: "must not change",
        },
      },
      {
        id: "remove",
        toolName: "MemoryDelete",
        args: { scope: "dream", location: "project", name: "old target" },
      },
      {
        id: "global",
        toolName: "MemorySave",
        args: { ...candidate, name: "global result", scope: "dream", location: "global" },
      },
      {
        id: "profile",
        toolName: "MemorySave",
        args: { ...candidate, name: "profile result", scope: "dream", location: "profile" },
      },
    ];
    let firstPrompt = "",
      invocation = 0;
    const profile = join(custom, "profile");
    await runDreamConsolidation({
      baseDir: custom,
      projectDir,
      toolRegistry: registry,
      toolContext: {
        cwd: projectDir,
        profileMemoryDir: profile,
        toolRegistry: registry,
        planMode: false,
      } as ToolContext,
      llmClient: {
        createMessage: async (request: any) => {
          firstPrompt ||= request.messages[0].content;
          return ++invocation === 1
            ? { text: "", toolCalls: calls }
            : { text: "done", toolCalls: [] };
        },
      } as any,
    });
    expect(firstPrompt).toContain("manual target");
    const local = manager(custom, projectDir, "dream"),
      other = manager(ambient, projectDir, "dream");
    expect(local.findById("owned")?.content).toBe("dream update");
    expect(local.findById("owned")?.useCount).toBe(1);
    expect(local.findById("manual")?.content).toBe(candidate.content);
    expect(local.findById("remove")).toBeUndefined();
    expect(other.findById("owned")?.content).toBe(candidate.content);
    expect(other.findById("manual")?.content).toBe(candidate.content);
    expect(other.findById("remove")).toBeDefined();
    expect(
      manager(custom, undefined, "dream")
        .loadAll()
        .map((m) => m.name),
    ).toEqual(["global result"]);
    expect(manager(ambient, undefined, "dream").loadAll()).toHaveLength(0);
    expect(existsSync(profile)).toBe(false);
  }));
