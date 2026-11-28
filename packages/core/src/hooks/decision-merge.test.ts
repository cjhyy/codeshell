import { describe, it, expect } from "bun:test";
import { HookRegistry } from "./registry.js";

/**
 * B3: hook decision merge must take the STRICTEST decision across the chain,
 * not last-write-wins. The old code did `aggregated.decision = result.decision`
 * unconditionally, so a low-priority (later-running) handler could relax a
 * high-priority handler's `deny` to `allow`. Strictness order: deny > ask > allow.
 */
describe("HookRegistry decision merge", () => {
  it("a deny from any handler wins over an allow from another", async () => {
    const reg = new HookRegistry();
    // priority 100 runs first and says allow; priority 0 runs later and denies.
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 100, "first-allow");
    reg.register("pre_tool_use", () => ({ decision: "deny" }), 0, "later-deny");
    const result = await reg.emit("pre_tool_use", {});
    expect(result.decision).toBe("deny");
  });

  it("a later allow cannot relax an earlier deny", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", () => ({ decision: "deny" }), 100, "first-deny");
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 0, "later-allow");
    const result = await reg.emit("pre_tool_use", {});
    expect(result.decision).toBe("deny");
  });

  it("ask beats allow but loses to deny", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 50);
    reg.register("pre_tool_use", () => ({ decision: "ask" }), 40);
    expect((await reg.emit("pre_tool_use", {})).decision).toBe("ask");

    const reg2 = new HookRegistry();
    reg2.register("pre_tool_use", () => ({ decision: "ask" }), 50);
    reg2.register("pre_tool_use", () => ({ decision: "deny" }), 40);
    expect((await reg2.emit("pre_tool_use", {})).decision).toBe("deny");
  });

  it("a single decision still passes through", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", () => ({ decision: "allow" }), 0);
    expect((await reg.emit("pre_tool_use", {})).decision).toBe("allow");
  });
});

describe("HookRegistry rewrites across the chain", () => {
  it("a handler that ignores earlier rewrites still replaces them, as before", async () => {
    const reg = new HookRegistry();
    reg.register("pre_tool_use", (ctx) => ({
      updatedInput: { ...(ctx.data.args as object), redacted: true },
    }));
    reg.register("pre_tool_use", (ctx) => ({
      updatedInput: { ...(ctx.data.args as object), dryRun: true },
    }));
    const result = await reg.emit("pre_tool_use", { args: { command: "deploy" } });
    expect(result.updatedInput).toEqual({ command: "deploy", dryRun: true });
  });

  it("a handler can build on what earlier handlers produced", async () => {
    const reg = new HookRegistry();
    const seen: unknown[] = [];
    reg.register("pre_tool_use", (ctx) => {
      seen.push(ctx.pending?.updatedInput);
      return { decision: "ask", updatedInput: { ...(ctx.data.args as object), redacted: true } };
    });
    reg.register("pre_tool_use", (ctx) => {
      seen.push(ctx.pending?.updatedInput);
      expect(ctx.pending?.decision).toBe("ask");
      // The original is still in data; the earlier rewrite is in pending.
      expect(ctx.data.args).toEqual({ command: "deploy" });
      return {
        updatedInput: { ...(ctx.pending?.updatedInput ?? (ctx.data.args as object)), dryRun: true },
      };
    });
    const result = await reg.emit("pre_tool_use", { args: { command: "deploy" } });
    expect(seen).toEqual([undefined, { command: "deploy", redacted: true }]);
    expect(result.updatedInput).toEqual({ command: "deploy", redacted: true, dryRun: true });
  });

  it("each emit starts with nothing pending", async () => {
    const reg = new HookRegistry();
    const seen: unknown[] = [];
    reg.register("user_prompt_submit", (ctx) => {
      seen.push(ctx.pending?.updatedPrompt);
      return { updatedPrompt: "rewritten" };
    });
    await reg.emit("user_prompt_submit", { prompt: "a" });
    await reg.emit("user_prompt_submit", { prompt: "b" });
    expect(seen).toEqual([undefined, undefined]);
  });
});
