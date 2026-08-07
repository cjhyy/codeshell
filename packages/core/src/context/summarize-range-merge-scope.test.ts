import { describe, it, expect } from "bun:test";
import { ContextManager } from "./manager.js";
import type { Message } from "../types.js";

// summarizeRange's rolling-merge must only feed a PRIOR anchored summary back
// to the LLM when that summary sits inside the window currently being
// replaced. A summary outside the window belongs to a different, untouched
// span; merging it in anyway means every later range archive folds in the
// text of every earlier one (N archived spans -> N copies of the same
// growing text), defeating the point of range-scoped archival.
describe("ContextManager.summarizeRange prior-summary scoping", () => {
  it("does not feed an out-of-window anchored summary into the next range's prompt", async () => {
    const prompts: string[] = [];
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    let call = 0;
    mgr.setSummarizeFn(async (prompt) => {
      prompts.push(prompt);
      call += 1;
      return `SUMMARY ${call}: `.padEnd(60, "x");
    });

    const messages: Message[] = [
      { role: "user", content: "old topic message" },
      { role: "assistant", content: "old topic reply" },
      { role: "user", content: "new topic message" },
      { role: "assistant", content: "new topic reply" },
    ];

    // First archive: collapse [0, 2) into an anchored summary at index 0.
    const afterFirst = await mgr.summarizeRange(messages, { start: 0, end: 2 });
    expect(afterFirst).not.toBe(messages);
    const firstSummaryText = prompts[0]!;
    // Sanity: nothing to merge yet, so no "Prior summary" section.
    expect(firstSummaryText).not.toContain("Prior summary");

    // afterFirst is now: [summaryMessage(idx0), "new topic message"(idx1), "new topic reply"(idx2)].
    // Second archive: collapse ONLY the new-topic window [1, 3) — the first
    // summary sits at index 0, OUTSIDE this window.
    const afterSecond = await mgr.summarizeRange(afterFirst, { start: 1, end: 3 });
    expect(afterSecond).not.toBe(afterFirst);

    const secondPrompt = prompts[1]!;
    // The out-of-window first summary must NOT have been merged into the
    // second call's prompt.
    expect(secondPrompt).not.toContain("Prior summary");
    expect(secondPrompt).not.toContain(prompts[0]!.split("\n=== Prior summary ===")[0]);
  });

  it("merges an in-window anchored summary so its content is preserved, not dropped", async () => {
    const prompts: string[] = [];
    const mgr = new ContextManager({ maxTokens: 1_000_000 });
    let call = 0;
    mgr.setSummarizeFn(async (prompt) => {
      prompts.push(prompt);
      call += 1;
      return `SUMMARY ${call}: `.padEnd(60, "x");
    });

    const messages: Message[] = [
      { role: "user", content: "old topic message" },
      { role: "assistant", content: "old topic reply" },
      { role: "user", content: "new topic message" },
      { role: "assistant", content: "new topic reply" },
    ];

    const afterFirst = await mgr.summarizeRange(messages, { start: 0, end: 2 });
    // afterFirst: [summaryMessage(idx0), "new topic message"(idx1), "new topic reply"(idx2)].

    // Second archive: window [0, 3) INCLUDES the first summary message at
    // index 0 — it must be merged in so its content survives.
    await mgr.summarizeRange(afterFirst, { start: 0, end: 3 });

    const secondPrompt = prompts[1]!;
    expect(secondPrompt).toContain("Prior summary");
  });
});
