import { describe, it, expect } from "bun:test";
import { estimateTokens } from "./compaction.js";
import { ContextManager } from "./manager.js";
import type { Message } from "../types.js";

function textConversation(rounds: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < rounds; i++) {
    messages.push({
      role: "user",
      content: `question ${i} ` + "alpha beta gamma ".repeat(80),
    });
    messages.push({
      role: "assistant",
      content: `answer ${i} ` + "delta epsilon zeta ".repeat(80),
    });
  }
  return messages;
}

describe("ContextManager hybrid token estimation", () => {
  it("rescales the actual usage anchor after compaction shrinks the message array", () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    const anchored = textConversation(20);
    const compacted = [anchored[0]!, ...anchored.slice(-8)];
    const anchorHeuristic = estimateTokens(anchored);
    const compactedHeuristic = estimateTokens(compacted);
    const actualAnchorTokens = anchorHeuristic * 2.5;
    const expected = actualAnchorTokens * (compactedHeuristic / anchorHeuristic);

    mgr.recordActualUsage(actualAnchorTokens, anchored.length, anchored);

    const { tokens } = mgr.checkLimits(compacted);

    expect(tokens).toBeCloseTo(expected, 0);
    expect(tokens).toBeGreaterThan(compactedHeuristic * 2);
  });

  it("seeds a persisted actual usage anchor for resumed sessions", () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    const anchored = textConversation(20);
    const compacted = [anchored[0]!, ...anchored.slice(-8)];
    const anchorHeuristic = estimateTokens(anchored);
    const compactedHeuristic = estimateTokens(compacted);
    const actualAnchorTokens = anchorHeuristic * 2.5;
    const expected = actualAnchorTokens * (compactedHeuristic / anchorHeuristic);

    mgr.seedActualUsage({
      promptTokens: actualAnchorTokens,
      messageCount: anchored.length,
      estimateAtAnchor: anchorHeuristic,
      recordedAt: Date.now(),
    });

    const { tokens } = mgr.checkLimits(compacted);

    expect(tokens).toBeCloseTo(expected, 0);
    expect(mgr.getActualUsageAnchor()).toMatchObject({
      promptTokens: actualAnchorTokens,
      messageCount: anchored.length,
      estimateAtAnchor: anchorHeuristic,
    });
  });
});
