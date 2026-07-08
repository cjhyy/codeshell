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
  it("labels no-anchor checkLimits estimates as heuristic low confidence", () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    const messages = textConversation(2);

    const checked = mgr.checkLimits(messages);

    expect(checked.tokens).toBe(estimateTokens(messages));
    expect(checked.promptTokensSource).toBe("heuristic_estimate");
    expect(checked.promptTokensConfidence).toBe("low");
  });

  it("labels post-anchor appended messages as anchor-delta medium confidence", () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    const anchored = textConversation(2);
    const next: Message = { role: "user", content: "next message" };
    const actualAnchorTokens = estimateTokens(anchored) * 2;

    mgr.recordActualUsage(actualAnchorTokens, anchored.length, anchored);

    const checked = mgr.checkLimits([...anchored, next]);
    expect(checked.tokens).toBe(actualAnchorTokens + estimateTokens([next]));
    expect(checked.promptTokensSource).toBe("anchor_delta");
    expect(checked.promptTokensConfidence).toBe("medium");
  });

  it("rescales the actual usage anchor after compaction shrinks the message array", () => {
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    const anchored = textConversation(20);
    const compacted = [anchored[0]!, ...anchored.slice(-8)];
    const anchorHeuristic = estimateTokens(anchored);
    const compactedHeuristic = estimateTokens(compacted);
    const actualAnchorTokens = anchorHeuristic * 2.5;
    const expected = actualAnchorTokens * (compactedHeuristic / anchorHeuristic);

    mgr.recordActualUsage(actualAnchorTokens, anchored.length, anchored);

    const checked = mgr.checkLimits(compacted);
    const { tokens } = checked;

    expect(tokens).toBeCloseTo(expected, 0);
    expect(tokens).toBeGreaterThan(compactedHeuristic * 2);
    expect(checked.promptTokensSource).toBe("anchor_rescale");
    expect(checked.promptTokensConfidence).toBe("medium");
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

    const checked = mgr.checkLimits(compacted);
    const { tokens } = checked;

    expect(tokens).toBeCloseTo(expected, 0);
    expect(checked.promptTokensSource).toBe("anchor_rescale");
    expect(checked.promptTokensConfidence).toBe("medium");
    expect(mgr.getActualUsageAnchor()).toMatchObject({
      promptTokens: actualAnchorTokens,
      messageCount: anchored.length,
      estimateAtAnchor: anchorHeuristic,
    });
  });
});
