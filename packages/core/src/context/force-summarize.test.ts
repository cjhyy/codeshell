import { describe, it, expect } from "bun:test";
import { ContextManager } from "./manager.js";
import type { Message } from "../types.js";

// A long, text-only conversation (no tool_results) that sits BELOW the
// compact ratio for a huge (1M) window. This is the /compact bug: manage()
// only runs micro (which is a no-op with no tool_results to clear) and the
// snip/summary tiers never fire because tokens < compactAtRatio * maxTokens.
function bigTextConversation(rounds: number): Message[] {
  const msgs: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    msgs.push({ role: "user", content: `question ${i} ` + "lorem ipsum ".repeat(500) });
    msgs.push({ role: "assistant", content: `answer ${i} ` + "dolor sit amet ".repeat(500) });
  }
  return msgs;
}

describe("ContextManager.forceSummarize", () => {
  it("compacts a below-threshold text-only conversation via LLM summary", async () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    let summarizeCalled = false;
    mgr.setSummarizeFn(async () => {
      summarizeCalled = true;
      return "SUMMARY: the user and assistant discussed lorem ipsum across many rounds.";
    });

    const messages = bigTextConversation(40);
    const { estimateTokens } = await import("./compaction.js");
    const before = estimateTokens(messages);

    // Sanity: we are BELOW the 0.85 compact gate for a 1M window, so the
    // normal manage()/manageAsync() ladder would NOT compact.
    expect(before).toBeLessThan(1_000_000 * 0.85);

    const result = await mgr.forceSummarize(messages);
    const after = estimateTokens(result);

    expect(summarizeCalled).toBe(true);
    expect(after).toBeLessThan(before);
  });

  it("falls back to snip when no summarizeFn is available", async () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    const messages = bigTextConversation(40);
    const { estimateTokens } = await import("./compaction.js");
    const before = estimateTokens(messages);

    const result = await mgr.forceSummarize(messages);
    const after = estimateTokens(result);

    expect(after).toBeLessThan(before);
  });
});
