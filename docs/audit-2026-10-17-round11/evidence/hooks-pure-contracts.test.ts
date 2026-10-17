import { describe, expect, test, spyOn } from "bun:test";
import { HookRegistry } from "../../../packages/core/src/hooks/registry.js";
import { validateHookResult } from "../../../packages/core/src/hooks/hook-output.js";

describe("R11 hooks: pure JSON output and chain composition", () => {
  test("accepts the JSON-produced ordinary rewrite/message shape unchanged", () => {
    const value = JSON.parse(JSON.stringify({
      stop: false, continueSession: false, data: { trace: ["one"] },
      messages: ["ready", ""], updatedInput: { path: "alpha.txt" },
      additionalContext: "summary", updatedPrompt: "",
    }));
    expect(validateHookResult(value)).toEqual(value);
    expect(validateHookResult({ updatedInput: {}, data: {}, messages: [] })).not.toBeNull();
  });

  test("rejects malformed JSON-produced output without invoking a runner", () => {
    for (const value of [null, [], "text", 3, { messages: ["ok", 7] },
      { messages: "text" }, { stop: 1 }, { data: [] }, { updatedInput: null },
      { updatedPrompt: 7 }, { additionalContext: false }, { typo: "text" }]) {
      expect(validateHookResult(value)).toBeNull();
    }
    expect(validateHookResult({})).toEqual({});
  });

  test("a data result feeds the next handler and preserves unrelated input fields", async () => {
    const registry = new HookRegistry();
    const seen: unknown[] = [];
    registry.register("user_prompt_submit", (ctx) => {
      seen.push({ ...ctx.data });
      return { data: { stage: "first", a: 1 }, messages: ["first"] };
    }, 10);
    registry.register("user_prompt_submit", (ctx) => {
      seen.push({ ...ctx.data });
      return { data: { stage: "second", b: 2 }, messages: ["second"] };
    }, 0);
    const input = { prompt: "hello", stage: "initial" };
    const result = await registry.emit("user_prompt_submit", input);
    expect(seen).toEqual([{ prompt: "hello", stage: "initial" },
      { prompt: "hello", stage: "first", a: 1 }]);
    expect(result.data).toEqual({ stage: "second", a: 1, b: 2 });
    expect(result.messages).toEqual(["first", "second"]);
    expect(input).toEqual({ prompt: "hello", stage: "initial" });
  });

  test("empty rewrites survive while ordinary context strings append", async () => {
    const registry = new HookRegistry();
    registry.register("user_prompt_submit", () => ({ updatedPrompt: "first",
      updatedInput: { a: 1 }, additionalContext: "first" }), 10);
    registry.register("user_prompt_submit", () => ({ updatedPrompt: "",
      updatedInput: {}, additionalContext: "second" }), 0);
    const result = await registry.emit("user_prompt_submit", { prompt: "hello" });
    expect(result.updatedPrompt).toBe("");
    expect(result.updatedInput).toEqual({});
    expect(result.additionalContext).toBe("first\n\nsecond");
  });

  test("a handler error does not discard earlier ordinary messages or the remaining chain", async () => {
    const registry = new HookRegistry();
    const errorLog = spyOn(console, "error").mockImplementation(() => {});
    try {
      registry.register("user_prompt_submit", () => ({ messages: ["before"] }), 20);
      registry.register("user_prompt_submit", () => { throw new Error("synthetic hook failure"); }, 10);
      registry.register("user_prompt_submit", () => ({ messages: ["after"] }), 0);
      expect((await registry.emit("user_prompt_submit")).messages).toEqual(["before", "after"]);
      expect(errorLog).toHaveBeenCalledTimes(1);
    } finally { errorLog.mockRestore(); }
  });
});

describe("R11 observed candidate: register during a suspended emit", () => {
  test("adding a higher-priority hook re-executes an existing handler and omits the new one", async () => {
    const registry = new HookRegistry();
    let enter!: () => void;
    let release!: () => void;
    const entered = new Promise<void>((resolve) => { enter = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    registry.register("user_prompt_submit", async () => {
      calls.push("existing-high"); enter(); await paused;
      return { messages: ["existing-high"] };
    }, 10);
    registry.register("user_prompt_submit", () => {
      calls.push("existing-low"); return { messages: ["existing-low"] };
    }, 0);
    const pending = registry.emit("user_prompt_submit", { prompt: "hello" });
    await entered;
    registry.register("user_prompt_submit", () => {
      calls.push("new-high"); return { messages: ["new-high"] };
    }, 20);
    release();
    const result = await pending;
    // Characterization only: these assertions preserve the observed behavior.
    expect(calls).toEqual(["existing-high", "existing-high", "existing-low"]);
    expect(result.messages).toEqual(["existing-high", "existing-high", "existing-low"]);
    expect(registry.countHandlers("user_prompt_submit")).toBe(3);
  });

  test("registering all handlers before emit executes each once in descending priority", async () => {
    const registry = new HookRegistry();
    const calls: string[] = [];
    for (const [label, priority] of [["existing-high", 10], ["existing-low", 0],
      ["new-high", 20]] as const) {
      registry.register("user_prompt_submit", () => { calls.push(label); return {}; }, priority);
    }
    await registry.emit("user_prompt_submit");
    expect(calls).toEqual(["new-high", "existing-high", "existing-low"]);
    expect(registry.countHandlers("user_prompt_submit")).toBe(3);
  });

  test("without mid-emit registration the suspended handler executes once", async () => {
    const registry = new HookRegistry();
    let release!: () => void;
    const paused = new Promise<void>((resolve) => { release = resolve; });
    const calls: string[] = [];
    registry.register("user_prompt_submit", async () => {
      calls.push("existing-high"); await paused; return {};
    }, 10);
    registry.register("user_prompt_submit", () => { calls.push("existing-low"); return {}; }, 0);
    const pending = registry.emit("user_prompt_submit");
    release(); await pending;
    expect(calls).toEqual(["existing-high", "existing-low"]);
  });
});
