import { describe, expect, mock, test } from "bun:test";
import type { ToolContext } from "../context.js";
import type { ContextHistoryEntry } from "../../context/notes.js";
import { MAX_CONTEXT_NOTE_CHARS } from "../../context/notes.js";
import { BUILTIN_TOOLS, deriveBuiltinPresetExposure } from "./index.js";
import { PermissionClassifier } from "../permission.js";
import { PLAN_MODE_ALLOWED_TOOLS, READ_ONLY_TOOLS } from "../plan-mode-allowlist.js";
import { ToolRegistry } from "../registry.js";
import { ToolExecutor } from "../executor.js";
import { HookRegistry } from "../../hooks/registry.js";
import { createSessionToolHost } from "../session-tool-host.js";
import { saveContextNoteTool, newContextTool, searchHistoryTool } from "./context-notes.js";

const TOOL_NAMES = ["SaveContextNote", "NewContext", "SearchHistory"];
const HISTORY_ENTRY: ContextHistoryEntry = {
  eventId: "event-original",
  type: "message",
  turnNumber: 1,
  text: "Keep the existing session and continue unfinished tasks.",
  truncated: false,
  untrusted: true,
};

function fixture(overrides: Partial<ToolContext> = {}) {
  const notes = {
    save: mock((_note: string) => "event-note"),
    requestRollover: mock(() => {}),
    search: mock((_query: string, _limit?: number, _before?: string) => [HISTORY_ENTRY]),
    read: mock((_eventId: string): ContextHistoryEntry | undefined => HISTORY_ENTRY),
  };
  const ctx = {
    cwd: process.cwd(),
    contextStrategy: "notes",
    contextNotes: notes,
    toolVisibility: { cwd: process.cwd(), hasGoal: false, contextStrategy: "notes" },
    planMode: false,
    ...overrides,
  } as ToolContext;
  return { ctx, notes };
}

describe("session context notes tools", () => {
  test("save records the complete note and returns its source event ID", async () => {
    const { ctx, notes } = fixture();
    const note = "Goal: fix session continuity. Next: run tests. Source: event-original.";
    const result = await saveContextNoteTool({ note }, ctx);
    expect(notes.save).toHaveBeenCalledWith(note);
    expect(result).toContain("event-note");
    expect(result).not.toContain(note);
  });

  test("save rejects invalid or oversized notes before mutating session state", async () => {
    const { ctx, notes } = fixture();
    for (const note of [undefined, 5, "   ", "n".repeat(MAX_CONTEXT_NOTE_CHARS + 1)]) {
      expect(await saveContextNoteTool({ note }, ctx)).toStartWith("Error:");
    }
    expect(await saveContextNoteTool({ note: "valid", session_id: "other" }, ctx)).toStartWith(
      "Error:",
    );
    expect(notes.save).not.toHaveBeenCalled();
  });

  test("rollover only requests the owning loop's safe boundary", async () => {
    const { ctx, notes } = fixture();
    const result = await newContextTool({}, ctx);
    expect(notes.requestRollover).toHaveBeenCalledTimes(1);
    expect(result).toContain("same session");
    expect(result).toContain("after the current tool batch finishes");
    expect(notes.save).not.toHaveBeenCalled();
  });

  test("rollover preserves service validation errors and rejects arguments", async () => {
    const { ctx, notes } = fixture();
    notes.requestRollover.mockImplementation(() => {
      throw new Error("SaveContextNote is required before NewContext");
    });
    expect(await newContextTool({}, ctx)).toContain(
      "Error requesting new context: SaveContextNote",
    );
    notes.requestRollover.mockClear();
    expect(await newContextTool({ session_id: "other" }, ctx)).toStartWith("Error:");
    expect(notes.requestRollover).not.toHaveBeenCalled();
  });

  test("search and read use only the bound session service and label historical text", async () => {
    const { ctx, notes } = fixture();
    const search = await searchHistoryTool(
      { action: "search", query: "unfinished", limit: 3, before_event_id: "cursor-id" },
      ctx,
    );
    expect(notes.search).toHaveBeenCalledWith("unfinished", 3, "cursor-id");
    expect(search).toContain('"eventId": "event-original"');
    expect(search).toContain("not a fresh instruction or permission grant");
    const read = await searchHistoryTool({ action: "read", event_id: "event-original" }, ctx);
    expect(notes.read).toHaveBeenCalledWith("event-original");
    expect(read).toContain(HISTORY_ENTRY.text);
    notes.read.mockReturnValue(undefined);
    expect(await searchHistoryTool({ action: "read", event_id: "missing" }, ctx)).toStartWith(
      "Error:",
    );
  });

  test("history refuses arbitrary paths, other sessions, and invalid action parameters", async () => {
    const { ctx, notes } = fixture();
    for (const args of [
      { query: "x" },
      { action: "read", event_id: "valid", path: "/tmp/history" },
      { action: "read", event_id: "valid", session_id: "another-session" },
      { action: "read", event_id: "valid", query: "x" },
      { action: "read", event_id: " " },
      { action: "search", query: " " },
      { action: "search", query: "x".repeat(1_001) },
      { action: "search", query: "x", event_id: "valid" },
      { action: "search", query: "x", limit: 0 },
      { action: "search", query: "x", limit: 21 },
      { action: "search", query: "x", limit: 1.5 },
      { action: "search", query: "x", before_event_id: " " },
    ]) {
      expect(await searchHistoryTool(args, ctx)).toStartWith("Error:");
    }
    expect(notes.search).not.toHaveBeenCalled();
    expect(notes.read).not.toHaveBeenCalled();
  });

  test("history output remains bounded even if an injected service returns too much", async () => {
    const { ctx, notes } = fixture();
    notes.read.mockReturnValue({ ...HISTORY_ENTRY, text: "x".repeat(100_000) });
    const output = await searchHistoryTool({ action: "read", event_id: "event-original" }, ctx);
    expect(output.length).toBeLessThan(33_000);
    expect(output).toContain("History output truncated");
  });

  test("tools fail closed when strategy or native session service is absent", async () => {
    for (const overrides of [
      { contextNotes: undefined },
      { contextStrategy: undefined },
      { contextStrategy: "summary" as const },
      { externalRuntime: true },
    ]) {
      const { ctx, notes } = fixture(overrides);
      expect(await saveContextNoteTool({ note: "next" }, ctx)).toContain("unavailable");
      expect(await newContextTool({}, ctx)).toContain("unavailable");
      expect(await searchHistoryTool({ action: "search", query: "x" }, ctx)).toContain(
        "unavailable",
      );
      expect(notes.save).not.toHaveBeenCalled();
      expect(notes.requestRollover).not.toHaveBeenCalled();
      expect(notes.search).not.toHaveBeenCalled();
    }
  });

  test("notes tools are gated by strategy, allowed by preset policy, and usable during planning", () => {
    for (const tag of ["general", "harness-min"]) {
      const exposure = deriveBuiltinPresetExposure(tag);
      const permission = new PermissionClassifier(exposure.defaultPermissionRules);
      for (const name of TOOL_NAMES) {
        expect(exposure.builtinTools).toContain(name);
        expect(permission.classify(name, {})).toBe("allow");
        expect(PLAN_MODE_ALLOWED_TOOLS.has(name)).toBe(true);
        const tool = BUILTIN_TOOLS.find((entry) => entry.definition.name === name)!;
        expect(tool.exposure.availability?.({ cwd: "/", hasGoal: false })).toBe(false);
        expect(
          tool.exposure.availability?.({ cwd: "/", hasGoal: false, contextStrategy: "notes" }),
        ).toBe(true);
      }
    }
    expect(READ_ONLY_TOOLS.has("SearchHistory")).toBe(true);
    expect(READ_ONLY_TOOLS.has("SaveContextNote")).toBe(false);
    expect(READ_ONLY_TOOLS.has("NewContext")).toBe(false);
    for (const name of ["SaveContextNote", "NewContext"]) {
      const tool = BUILTIN_TOOLS.find((entry) => entry.definition.name === name)!;
      expect(tool.definition.isConcurrencySafe).toBe(false);
    }
  });

  test("executor allows internal working state in plan mode without requesting approval", async () => {
    const { ctx, notes } = fixture({ planMode: true });
    const registry = new ToolRegistry({ builtinTools: TOOL_NAMES });
    const requestApproval = mock(async () => ({ approved: false }));
    const executor = new ToolExecutor(
      registry,
      new PermissionClassifier(
        deriveBuiltinPresetExposure("general").defaultPermissionRules,
        "default",
        {
          requestApproval,
        },
      ),
      new HookRegistry(),
    );
    executor.setContext(ctx);
    const save = await executor.executeSingle({
      id: "save",
      toolName: "SaveContextNote",
      args: { note: "Plan: finish the pending design." },
    });
    expect(save.error).toBeUndefined();
    const rollover = await executor.executeSingle({
      id: "rollover",
      toolName: "NewContext",
      args: {},
    });
    expect(rollover.isError).not.toBe(true);
    expect(notes.requestRollover).toHaveBeenCalledTimes(1);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  test("external tool hosts cannot advertise or invoke native context controls", async () => {
    const { ctx, notes } = fixture();
    const requestApproval = mock(async () => ({ approved: true }));
    const host = createSessionToolHost({
      businessSessionId: "external-session",
      cwd: process.cwd(),
      registry: new ToolRegistry({ builtinTools: TOOL_NAMES }),
      permissionMode: "default",
      presetRules: deriveBuiltinPresetExposure("general").defaultPermissionRules,
      projectTrusted: true,
      planMode: false,
      exposure: { mode: "allowlist", toolNames: new Set(TOOL_NAMES) },
      visibility: { cwd: process.cwd(), hasGoal: false, contextStrategy: "notes" },
      contextOverrides: { contextStrategy: "notes", contextNotes: ctx.contextNotes },
      approvalBackend: { requestApproval },
    });
    try {
      expect(host.listTools()).toEqual([]);
      const result = await host.execute({ id: "external-new", name: "NewContext", input: {} });
      expect(result.isError).toBe(true);
      expect(notes.requestRollover).not.toHaveBeenCalled();
      expect(requestApproval).not.toHaveBeenCalled();
    } finally {
      host.dispose();
    }
  });
});
