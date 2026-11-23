import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, symlinkSync, renameSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript } from "./transcript.js";

function messageLine(i: number, extra: Record<string, unknown> = {}, turnNumber = 1): string {
  return JSON.stringify({
    id: `e${i}`,
    type: "message",
    timestamp: i,
    turnNumber,
    data: { role: "user", content: "x".repeat(900), ...extra },
  });
}

describe("Transcript.loadTailForAppend", () => {
  test.skipIf(process.platform === "win32")(
    "scoped appends hold the original regular file and cannot outlive their callback",
    () => {
      const dir = mkdtempSync(join(tmpdir(), "transcript-receipt-"));
      try {
        const file = join(dir, "transcript.jsonl"),
          original = join(dir, "original.jsonl");
        let append: (() => void) | undefined;
        Transcript.withTailForAppend(file, (t) => {
          renameSync(file, original);
          symlinkSync(original, file);
          append = () => {
            t.appendMessage("assistant", "fixture", {
              clientMessageId: "receipt",
              displayOnly: true,
            });
          };
          append();
        });
        expect(() => append!()).toThrow("closed");
        expect(() => Transcript.withTailForAppend(file, () => {})).toThrow();
        expect(readFileSync(original, "utf8").trim().split("\n")).toHaveLength(1);
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  );

  test("dedupes recent client ids and appends without parsing the whole file", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-tail-"));
    try {
      const file = join(dir, "transcript.jsonl");
      const lines = Array.from({ length: 6000 }, (_, i) =>
        messageLine(i, i === 0 ? { clientMessageId: "early" } : {}),
      );
      writeFileSync(file, `${lines.join("\n")}\n`);
      expect(Transcript.loadFromFile(file).hasClientMessageId("early")).toBe(true);
      const first = Transcript.loadTailForAppend(file, 64 * 1024);
      expect(first.hasClientMessageId("early")).toBe(false); // outside the tail window
      first.appendMessage("user", "hello", { clientMessageId: "recent-1" });
      const second = Transcript.loadTailForAppend(file, 64 * 1024);
      expect(second.hasClientMessageId("recent-1")).toBe(true);
      expect(readFileSync(file, "utf8").split("\n").filter(Boolean).length).toBe(6001);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("keeps the turn number from the tail when no turn boundary is in the window", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-tail-"));
    try {
      const file = join(dir, "transcript.jsonl");
      const lines = Array.from({ length: 500 }, (_, i) => messageLine(i, {}, 7));
      writeFileSync(file, `${lines.join("\n")}\n`);
      const tail = Transcript.loadTailForAppend(file, 64 * 1024);
      const event = tail.appendMessage("assistant", "receipt", { clientMessageId: "r" });
      expect(event.turnNumber).toBe(7);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("falls back to the full loader for small files", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-tail-"));
    try {
      const file = join(dir, "transcript.jsonl");
      writeFileSync(file, `${messageLine(0, { clientMessageId: "early" })}\n`);
      expect(Transcript.loadTailForAppend(file).hasClientMessageId("early")).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("display-only messages", () => {
  test("persist for readers but never enter a model projection", () => {
    const dir = mkdtempSync(join(tmpdir(), "transcript-display-only-"));
    try {
      const file = join(dir, "transcript.jsonl");
      const live = new Transcript(file);
      live.appendMessage("user", "hi", { clientMessageId: "u1" });
      live.appendMessage("assistant", [
        { type: "tool_use", id: "call-1", name: "Reply", input: { text: "hello" } },
      ]);
      live.appendToolUse("Reply", "call-1", { text: "hello" });
      // Another process records what it displayed, before the tool result lands.
      const host = Transcript.loadTailForAppend(file);
      host.appendMessage("assistant", "hello", { clientMessageId: "receipt-1", displayOnly: true });
      live.appendToolResult("call-1", "Reply", "accepted");
      const liveMessages = JSON.stringify(live.toMessages());

      const reloaded = Transcript.loadFromFile(file);
      expect(reloaded.hasClientMessageId("receipt-1")).toBe(true);
      expect(
        reloaded.getEvents("message").find((e) => e.data.clientMessageId === "receipt-1")?.data
          .displayOnly,
      ).toBe(true);
      expect(JSON.stringify(reloaded.toMessages())).toBe(liveMessages);
      expect(reloaded.toMessagesWithIndex().liveIndexByClientMessageId.has("receipt-1")).toBe(
        false,
      );
      const events = reloaded.getEvents();
      expect(JSON.stringify(Transcript.eventsToMessages(events))).not.toContain("receipt");
      const range = Transcript.selectContextRange(events, {
        fromEventId: events[0]!.id,
        toEventId: events.at(-1)!.id,
      });
      expect(range.events.some((e) => e.data.displayOnly === true)).toBe(false);
      expect(range.messages).toHaveLength(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
