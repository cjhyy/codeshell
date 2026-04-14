import { describe, it, expect } from "bun:test";
import { ToolRegistry } from "../src/tool/registry.js";
import { HookRegistry } from "../src/hooks/registry.js";
import { ToolExecutor } from "../src/tool/executor.js";
import { PermissionClassifier } from "../src/tool/permission.js";
import { ContextManager } from "../src/context/manager.js";
import { SettingsManager } from "../src/settings/manager.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("ToolRegistry", () => {
  it("registers all builtin tools", () => {
    const r = new ToolRegistry();
    const tools = r.listTools();
    expect(tools).toContain("Read");
    expect(tools).toContain("Write");
    expect(tools).toContain("Edit");
    expect(tools).toContain("Glob");
    expect(tools).toContain("Grep");
    expect(tools).toContain("Bash");
    expect(tools).toContain("WebSearch");
    expect(tools).toContain("WebFetch");
    expect(tools).toContain("AskUserQuestion");
    expect(tools).toContain("Agent");
    expect(tools).toContain("EnterPlanMode");
    expect(tools).toContain("ExitPlanMode");
    expect(tools).toContain("ToolSearch");
  });

  it("gets tool definitions", () => {
    const r = new ToolRegistry();
    const defs = r.getToolDefinitions();
    expect(defs.length).toBeGreaterThanOrEqual(13);
    for (const d of defs) {
      expect(d.name).toBeTruthy();
      expect(d.description).toBeTruthy();
      expect(d.inputSchema).toBeTruthy();
    }
  });

  it("executes a builtin tool", async () => {
    const r = new ToolRegistry();
    const result = await r.executeTool("Glob", { pattern: "package.json" });
    expect(result.result).toContain("package.json");
    expect(result.error).toBeUndefined();
  });

  it("throws on unknown tool", async () => {
    const r = new ToolRegistry();
    await expect(r.executeTool("NonexistentTool", {})).rejects.toThrow();
  });

  it("lists detailed tools", () => {
    const r = new ToolRegistry();
    const detailed = r.listToolsDetailed();
    expect(detailed.length).toBeGreaterThanOrEqual(13);
    expect(detailed[0].source).toBe("builtin");
    expect(detailed[0].permissionDefault).toBeTruthy();
  });
});

describe("HookRegistry", () => {
  it("registers and emits hooks", async () => {
    const hr = new HookRegistry();
    let called = false;
    hr.register("on_turn_start", () => {
      called = true;
      return {};
    });
    await hr.emit("on_turn_start", { turnNumber: 1 });
    expect(called).toBe(true);
  });

  it("respects priority ordering", async () => {
    const hr = new HookRegistry();
    const order: number[] = [];
    hr.register("on_turn_start", () => { order.push(1); return {}; }, 1);
    hr.register("on_turn_start", () => { order.push(2); return {}; }, 10);
    hr.register("on_turn_start", () => { order.push(3); return {}; }, 5);
    await hr.emit("on_turn_start");
    expect(order).toEqual([2, 3, 1]); // highest priority first
  });

  it("stops chain on stop signal", async () => {
    const hr = new HookRegistry();
    const order: number[] = [];
    hr.register("on_turn_start", () => { order.push(1); return { stop: true }; }, 10);
    hr.register("on_turn_start", () => { order.push(2); return {}; }, 1);
    const result = await hr.emit("on_turn_start");
    expect(order).toEqual([1]); // second hook not called
    expect(result.stop).toBe(true);
  });
});

describe("ContextManager", () => {
  it("manages messages without error", () => {
    const cm = new ContextManager({ maxTokens: 10_000 });
    const msgs = [
      { role: "user" as const, content: "hello" },
      { role: "assistant" as const, content: "hi" },
    ];
    const result = cm.manage(msgs);
    expect(result.length).toBeGreaterThan(0);
  });

  it("checks limits correctly", () => {
    const cm = new ContextManager({ maxTokens: 100 });
    const msgs = [
      { role: "user" as const, content: "a".repeat(400) }, // ~100 tokens
    ];
    const limits = cm.checkLimits(msgs);
    expect(limits.ratio).toBeGreaterThanOrEqual(0.9);
    expect(limits.needsEmergency).toBe(true);
  });

  it("deduplicates tool calls", () => {
    const cm = new ContextManager();
    const calls = [
      { toolName: "Read", args: { file_path: "/a" } },
      { toolName: "Read", args: { file_path: "/a" } },
    ];
    // First time: both execute
    cm.recordToolResult("Read", { file_path: "/a" }, "content1");
    cm.recordToolResult("Read", { file_path: "/a" }, "content2");
    const { toExecute, cached } = cm.deduplicateToolCalls(calls);
    expect(cached).toHaveLength(2);
    expect(toExecute).toHaveLength(0);
  });
});

describe("SettingsManager", () => {
  it("returns valid default settings", () => {
    let tmpDir: string;
    tmpDir = mkdtempSync(join(tmpdir(), "settings-test-"));
    try {
      const sm = new SettingsManager(tmpDir);
      const s = sm.get();
      expect(s.model.provider).toBeTruthy();
      expect(s.permissions.defaultMode).toBeTruthy();
      expect(s.context.maxTokens).toBeGreaterThan(0);
    } finally {
      rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});
