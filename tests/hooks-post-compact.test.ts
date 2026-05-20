import { describe, it, expect } from "bun:test";
import { HookRegistry } from "../src/hooks/registry.js";
import { wrapHookMessages } from "../src/hooks/inject.js";

// post_compact runs inside TurnLoop after ContextManager.manageAsync,
// gated by a non-micro strategy. The TurnLoop side reads
// `consumePendingCompactInfo` (a Engine-side buffer fed by setOnCompact)
// and emits `post_compact` with strategy/beforeTokens/afterTokens. These
// tests pin the contract handlers will register against; the full
// turn-loop wiring is exercised end-to-end via the existing turn-loop
// tests once that integration lands.
describe("post_compact hook contract", () => {
  it("aggregates messages from multiple post_compact handlers", async () => {
    const hooks = new HookRegistry();
    hooks.register(
      "post_compact",
      (ctx) => ({
        messages: [
          `[trace handler] ctx was compacted via ${String(ctx.data.strategy)}: ${String(ctx.data.beforeTokens)} → ${String(ctx.data.afterTokens)} tokens. Recall any decisions made earlier in this session from the transcript.`,
        ],
      }),
      50,
      "trace",
    );

    const result = await hooks.emit("post_compact", {
      strategy: "summary",
      beforeTokens: 180_000,
      afterTokens: 90_000,
    });

    const wrapped = wrapHookMessages(result.messages);
    expect(wrapped).not.toBeNull();
    expect(wrapped!.content).toContain("compacted via summary");
    expect(wrapped!.content).toContain("180000 → 90000");
  });

  it("handler can return {} to opt out (e.g. only react to summary)", async () => {
    const hooks = new HookRegistry();
    hooks.register("post_compact", (ctx) => {
      if (ctx.data.strategy !== "summary") return {};
      return { messages: ["heavy compaction occurred"] };
    });

    const snipResult = await hooks.emit("post_compact", { strategy: "snip" });
    expect(snipResult.messages).toBeUndefined();

    const summaryResult = await hooks.emit("post_compact", {
      strategy: "summary",
    });
    expect(summaryResult.messages).toEqual(["heavy compaction occurred"]);
  });

  it("isSubAgent in ctx.data allows handlers to skip noisy injections", async () => {
    const hooks = new HookRegistry();
    hooks.register("post_compact", (ctx) => {
      if (ctx.data.isSubAgent === true) return {};
      return { messages: ["only parent agent reminder"] };
    });

    const child = await hooks.emit("post_compact", {
      strategy: "summary",
      isSubAgent: true,
    });
    const parent = await hooks.emit("post_compact", {
      strategy: "summary",
      isSubAgent: false,
    });

    expect(child.messages).toBeUndefined();
    expect(parent.messages).toEqual(["only parent agent reminder"]);
  });
});
