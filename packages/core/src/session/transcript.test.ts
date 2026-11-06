import { describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
