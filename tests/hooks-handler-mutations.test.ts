import { describe, it, expect } from "bun:test";
import { HookRegistry } from "../src/hooks/registry.js";
import { ToolRegistry } from "../src/tool-system/registry.js";
import { ToolExecutor } from "../src/tool-system/executor.js";
import { PermissionClassifier } from "../src/tool-system/permission.js";

// ─── updatedInput (pre_tool_use sanitizer) ────────────────────────
describe("HookResult.updatedInput", () => {
  it("aggregates with last-write-wins semantics", async () => {
    const hooks = new HookRegistry();
    hooks.register("pre_tool_use", () => ({ updatedInput: { x: 1 } }), 10);
    hooks.register("pre_tool_use", () => ({ updatedInput: { x: 2, y: 3 } }), 5);
    const result = await hooks.emit("pre_tool_use", { toolName: "X", args: {} });
    expect(result.updatedInput).toEqual({ x: 2, y: 3 });
  });

  it("executor passes rewritten args to the tool", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    let receivedArgs: Record<string, unknown> | undefined;
    registry.registerTool(
      { name: "Read", description: "x", inputSchema: { type: "object" } },
      async (args) => {
        // Strip the executor-injected __signal so the assertion is stable.
        // eslint-disable-next-line @typescript-eslint/no-unused-vars
        const { __signal, ...rest } = args;
        receivedArgs = rest;
        return "ran";
      },
    );
    const hooks = new HookRegistry();
    const exec = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "Read", decision: "allow" }]),
      hooks,
    );
    hooks.register("pre_tool_use", () => ({
      updatedInput: { file_path: "/rewritten/x" },
    }));

    await exec.executeSingle({
      id: "c1",
      toolName: "Read",
      args: { file_path: "/original/x" },
    });
    expect(receivedArgs).toEqual({ file_path: "/rewritten/x" });
  });

  it("re-validates rewritten args against the schema", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    let toolRan = false;
    registry.registerTool(
      {
        name: "Read",
        description: "x",
        inputSchema: {
          type: "object",
          properties: { file_path: { type: "string" } },
          required: ["file_path"],
        },
      },
      async () => {
        toolRan = true;
        return "ran";
      },
    );
    const hooks = new HookRegistry();
    const exec = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "Read", decision: "allow" }]),
      hooks,
    );
    // Handler rewrites file_path to a non-string → revalidation fails.
    hooks.register("pre_tool_use", () => ({
      updatedInput: { file_path: 42 } as Record<string, unknown>,
    }));

    const result = await exec.executeSingle({
      id: "c2",
      toolName: "Read",
      args: { file_path: "/x" },
    });
    expect(toolRan).toBe(false);
    expect(result.isError).toBe(true);
    expect(result.error).toContain("after pre_tool_use rewrite");
  });
});

// ─── additionalContext (post_tool_use observer) ──────────────────
describe("HookResult.additionalContext", () => {
  it("aggregates multiple handlers' contributions with blank-line separators", async () => {
    const hooks = new HookRegistry();
    hooks.register("post_tool_use", () => ({ additionalContext: "lint: clean" }), 10);
    hooks.register("post_tool_use", () => ({ additionalContext: "tsc: 0 errors" }), 5);
    const result = await hooks.emit("post_tool_use", { toolName: "X" });
    expect(result.additionalContext).toBe("lint: clean\n\ntsc: 0 errors");
  });

  it("executor appends additionalContext onto successful tool result", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    registry.registerTool(
      { name: "Read", description: "x", inputSchema: { type: "object" } },
      async () => "file contents",
    );
    const hooks = new HookRegistry();
    const exec = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "Read", decision: "allow" }]),
      hooks,
    );
    hooks.register("post_tool_use", () => ({
      additionalContext: "checksum: 0xabcd",
    }));

    const result = await exec.executeSingle({
      id: "c3",
      toolName: "Read",
      args: { file_path: "/x" },
    });
    expect(result.result).toContain("file contents");
    expect(result.result).toContain("--- additional context from post_tool_use hook ---");
    expect(result.result).toContain("checksum: 0xabcd");
  });

  it("executor skips additionalContext on tool errors", async () => {
    const registry = new ToolRegistry({ builtinTools: ["Read"] });
    registry.registerTool(
      { name: "Read", description: "x", inputSchema: { type: "object" } },
      async () => {
        throw new Error("ENOENT");
      },
    );
    const hooks = new HookRegistry();
    const exec = new ToolExecutor(
      registry,
      new PermissionClassifier([{ tool: "Read", decision: "allow" }]),
      hooks,
    );
    hooks.register("post_tool_use", () => ({
      additionalContext: "should be skipped on error",
    }));

    const result = await exec.executeSingle({
      id: "c4",
      toolName: "Read",
      args: { file_path: "/x" },
    });
    expect(result.error).toContain("ENOENT");
    // Tagging string must not appear when tool failed.
    expect(result.result ?? "").not.toContain("additional context");
  });
});

// ─── updatedPrompt (user_prompt_submit rewrite) ──────────────────
describe("HookResult.updatedPrompt", () => {
  it("aggregates with last-write-wins", async () => {
    const hooks = new HookRegistry();
    hooks.register("user_prompt_submit", () => ({ updatedPrompt: "v1" }), 10);
    hooks.register("user_prompt_submit", () => ({ updatedPrompt: "v2" }), 5);
    const result = await hooks.emit("user_prompt_submit", { prompt: "orig" });
    expect(result.updatedPrompt).toBe("v2");
  });

  it("empty string is honored (handler can blank a prompt deliberately)", async () => {
    const hooks = new HookRegistry();
    hooks.register("user_prompt_submit", () => ({ updatedPrompt: "" }));
    const result = await hooks.emit("user_prompt_submit", { prompt: "orig" });
    expect(result.updatedPrompt).toBe("");
  });

  it("handler returning no updatedPrompt leaves result.updatedPrompt undefined", async () => {
    const hooks = new HookRegistry();
    hooks.register("user_prompt_submit", () => ({ messages: ["reminder"] }));
    const result = await hooks.emit("user_prompt_submit", { prompt: "orig" });
    expect(result.updatedPrompt).toBeUndefined();
    expect(result.messages).toEqual(["reminder"]);
  });
});
