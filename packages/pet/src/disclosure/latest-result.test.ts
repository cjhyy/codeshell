import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLatestAssistantText } from "./latest-result.js";

interface RawEvent {
  role: string;
  content: unknown;
}

function makeSessionDir(events: RawEvent[]): string {
  const dir = mkdtempSync(join(tmpdir(), "pet-disclosure-"));
  const lines = events.map((event, index) =>
    JSON.stringify({
      id: `e${index}`,
      type: "message",
      timestamp: 1000 + index,
      turnNumber: 0,
      data: { role: event.role, content: event.content },
    }),
  );
  writeFileSync(join(dir, "transcript.jsonl"), lines.join("\n") + "\n", "utf-8");
  return dir;
}

describe("readLatestAssistantText", () => {
  test("returns the newest assistant text, skipping a trailing user message", async () => {
    const dir = makeSessionDir([
      { role: "user", content: "first question" },
      { role: "assistant", content: [{ type: "text", text: "the answer" }] },
      { role: "user", content: "thanks, one more thing" },
    ]);

    const result = await readLatestAssistantText(dir, { maxChars: 5000 });

    expect(result).not.toBeNull();
    expect(result?.text).toBe("the answer");
    expect(result?.truncated).toBe(false);
  });

  test("truncates to maxChars and sets truncated: true", async () => {
    const longText = "x".repeat(5000);
    const dir = makeSessionDir([{ role: "assistant", content: longText }]);

    const result = await readLatestAssistantText(dir, { maxChars: 100 });

    expect(result).not.toBeNull();
    expect(result?.text.length).toBe(100);
    expect(result?.truncated).toBe(true);
  });

  test("returns null when there is no assistant message", async () => {
    const dir = makeSessionDir([{ role: "user", content: "hello" }]);

    const result = await readLatestAssistantText(dir, { maxChars: 5000 });

    expect(result).toBeNull();
  });

  test("returns null for a nonexistent directory", async () => {
    const dir = join(tmpdir(), "pet-disclosure-does-not-exist-" + Date.now());

    const result = await readLatestAssistantText(dir, { maxChars: 5000 });

    expect(result).toBeNull();
  });

  test("skips malformed lines and supports plain-string content", async () => {
    const dir = makeSessionDir([{ role: "assistant", content: "plain string answer" }]);
    appendFileSync(join(dir, "transcript.jsonl"), "not-json\n");

    const result = await readLatestAssistantText(dir, { maxChars: 5000 });

    expect(result).not.toBeNull();
    expect(result?.text).toBe("plain string answer");
    expect(result?.truncated).toBe(false);
  });
});
