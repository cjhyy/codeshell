import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { MemoryManager } from "../../session/memory.js";
import type { StreamEvent } from "../../types.js";
import type { ToolContext } from "../context.js";
import {
  memoryDeleteTool,
  memoryDeleteToolDef,
  memoryListTool,
  memoryListToolDef,
  memoryReadTool,
  memoryReadToolDef,
  memorySaveTool,
  memorySaveToolDef,
} from "./memory.js";

describe("memory tools profile location", () => {
  let root: string;
  let previousCodeShellHome: string | undefined;
  let projectDir: string;
  let profileMemoryDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "memory-profile-location-"));
    previousCodeShellHome = process.env.CODE_SHELL_HOME;
    process.env.CODE_SHELL_HOME = join(root, "home");
    projectDir = join(root, "workspace");
    profileMemoryDir = join(process.env.CODE_SHELL_HOME, "profiles", "researcher");
  });

  afterEach(() => {
    if (previousCodeShellHome === undefined) delete process.env.CODE_SHELL_HOME;
    else process.env.CODE_SHELL_HOME = previousCodeShellHome;
    rmSync(root, { recursive: true, force: true });
  });

  function ctx(
    overrides: Partial<Pick<ToolContext, "profileMemoryDir" | "streamCallback">> = {},
  ): ToolContext {
    return {
      cwd: projectDir,
      profileMemoryDir,
      ...overrides,
    } as unknown as ToolContext;
  }

  test("advertises profile alongside the existing global and project locations", () => {
    for (const definition of [
      memoryListToolDef,
      memoryReadToolDef,
      memorySaveToolDef,
      memoryDeleteToolDef,
    ]) {
      expect((definition.inputSchema.properties as Record<string, any>).location.enum).toEqual([
        "global",
        "project",
        "profile",
      ]);
    }
  });

  test("returns a clear error when the run has no portable profile memory", async () => {
    const withoutProfile = ctx({ profileMemoryDir: undefined });
    const calls = [
      memoryListTool({ scope: "user", location: "profile" }, withoutProfile),
      memoryReadTool({ scope: "user", location: "profile", name: "missing" }, withoutProfile),
      memorySaveTool(
        {
          scope: "user",
          location: "profile",
          name: "missing",
          description: "missing",
          type: "project",
          content: "missing",
        },
        withoutProfile,
      ),
      memoryDeleteTool({ scope: "user", location: "profile", name: "missing" }, withoutProfile),
    ];

    for (const result of await Promise.all(calls)) {
      expect(result).toContain("profile memory is unavailable for this run");
      expect(result).toContain("portableMemory");
    }
  });

  test("lists, reads, saves, recalls, and forgets profile-owned memory", async () => {
    const events: StreamEvent[] = [];
    const context = ctx({
      streamCallback: (event) => {
        events.push(event);
      },
    });

    expect(
      await memorySaveTool(
        {
          scope: "user",
          location: "profile",
          name: "research-method",
          description: "How this digital human researches",
          type: "feedback",
          content: "Triangulate primary sources before summarizing.",
        },
        context,
      ),
    ).toContain("profile/user/");
    expect(existsSync(join(profileMemoryDir, "memory", "user"))).toBe(true);

    const listed = await memoryListTool({ scope: "user", location: "profile" }, context);
    expect(listed).toContain("research-method");

    const read = await memoryReadTool(
      { scope: "user", location: "profile", name: "research-method" },
      context,
    );
    expect(read).toContain("Triangulate primary sources");
    expect(events).toContainEqual({
      type: "memory_recalled",
      name: "research-method",
      scope: "user",
      location: "profile",
    });
    expect(new MemoryManager({ baseDir: profileMemoryDir }).find("research-method")?.useCount).toBe(
      1,
    );

    expect(
      await memoryDeleteTool(
        { scope: "user", location: "profile", name: "research-method" },
        context,
      ),
    ).toContain("Deleted memory");
    expect(await memoryListTool({ scope: "user", location: "profile" }, context)).toContain(
      "(no memories",
    );
    expect(existsSync(join(profileMemoryDir, "memory-trash"))).toBe(true);
  });

  test("keeps omitted/project and global routing unchanged", async () => {
    const context = ctx();
    const entry = {
      scope: "user",
      name: "routing-check",
      description: "Routing compatibility",
      type: "project",
      content: "Stored in the expected existing layer.",
    };

    await memorySaveTool(entry, context);
    expect(new MemoryManager({ projectDir }).find("routing-check")).toBeDefined();
    expect(new MemoryManager().find("routing-check")).toBeUndefined();

    await memorySaveTool({ ...entry, location: "global", name: "global-routing-check" }, context);
    expect(new MemoryManager().find("global-routing-check")).toBeDefined();
    expect(new MemoryManager({ baseDir: profileMemoryDir }).loadAll()).toEqual([]);
  });
});
