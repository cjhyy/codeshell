import { describe, expect, test } from "bun:test";
import { buildExtractionPrompt } from "./extract-memories.js";
import { buildSessionMemoryPrompt } from "./session-memory.js";
import { formatMemoryTranscript } from "./memory-transcript.js";

describe("bounded memory transcript", () => {
  test("keeps a small conversation verbatim and in order", () => {
    expect(
      formatMemoryTranscript(
        [
          { role: "user", content: "original request" },
          { role: "assistant", content: "completed result" },
        ],
        2000,
      ),
    ).toBe("[user]: original request\n\n[assistant]: completed result");
    expect(formatMemoryTranscript([], 2000)).toBe("");
  });

  test.each([2000, 3000])(
    "keeps initial intent and recent corrections within the total budget (%i per message)",
    (maxMessageChars) => {
      const messages = [
        { role: "user", content: "INITIAL_INTENT" },
        ...Array.from({ length: 40 }, (_, index) => ({
          role: index % 2 ? "user" : "assistant",
          content: `OLD_${index} ${"x".repeat(maxMessageChars - 100)}`,
        })),
        { role: "user", content: "LATEST_CORRECTION: do not publish" },
        { role: "assistant", content: "LATEST_OUTCOME: merged locally, not published" },
      ];
      const text = formatMemoryTranscript(messages, maxMessageChars);

      expect(text.length).toBeLessThanOrEqual(30_000);
      expect(text).toStartWith("[user]: INITIAL_INTENT");
      expect(text).toContain("[... earlier conversation omitted ...]");
      expect(text).not.toContain("OLD_0 ");
      expect(text).toContain("[user]: LATEST_CORRECTION: do not publish");
      expect(text).toEndWith("[assistant]: LATEST_OUTCOME: merged locally, not published");
      expect(text.indexOf("LATEST_CORRECTION")).toBeLessThan(text.indexOf("LATEST_OUTCOME"));
    },
  );

  test.each([2000, 3000])(
    "keeps the tail of an oversized final message (%i per message)",
    (maxMessageChars) => {
      const text = formatMemoryTranscript(
        [{ role: "assistant", content: `START ${"x".repeat(40_000)} FINAL_DECISION` }],
        maxMessageChars,
      );

      expect(text.length).toBeLessThanOrEqual(maxMessageChars + "[assistant]: ".length);
      expect(text).toStartWith("[assistant]: START ");
      expect(text).toContain("[... middle of message omitted ...]");
      expect(text).toEndWith(" FINAL_DECISION");
    },
  );

  test("appended corrections change both prompts after the old-prefix boundary", () => {
    const messages = Array.from({ length: 30 }, (_, index) => ({
      role: index % 2 ? "assistant" : "user",
      content: `${index} ${"x".repeat(1900)}`,
    }));
    const updated = [...messages, { role: "user", content: "LATEST_CORRECTION" }];

    expect(buildSessionMemoryPrompt(updated)).not.toBe(buildSessionMemoryPrompt(messages));
    expect(buildSessionMemoryPrompt(updated)).toContain("[user]: LATEST_CORRECTION");
    expect(buildExtractionPrompt(updated, [])).not.toBe(buildExtractionPrompt(messages, []));
    expect(buildExtractionPrompt(updated, [])).toContain("[user]: LATEST_CORRECTION");
  });
});
