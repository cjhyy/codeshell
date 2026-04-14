import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Transcript } from "../src/session/transcript.js";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

describe("Transcript", () => {
  let tmpDir: string;
  let filePath: string;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "transcript-test-"));
    filePath = join(tmpDir, "transcript.jsonl");
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  it("creates and appends events", () => {
    const t = new Transcript(filePath);
    t.appendMessage("user", "hello");
    t.appendMessage("assistant", "hi");
    expect(t.eventCount).toBe(2);
  });

  it("converts to messages correctly", () => {
    const t = new Transcript(filePath);
    t.appendMessage("user", "hello");
    t.appendMessage("assistant", "world");
    const msgs = t.toMessages();
    expect(msgs).toHaveLength(2);
    expect(msgs[0].role).toBe("user");
    expect(msgs[0].content).toBe("hello");
    expect(msgs[1].role).toBe("assistant");
  });

  it("handles tool_result pairing in toMessages", () => {
    const t = new Transcript(filePath);
    t.appendMessage("user", "do something");
    t.appendMessage("assistant", [
      { type: "tool_use", id: "tc1", name: "Read", input: { file_path: "/a" } },
    ]);
    t.appendToolResult("tc1", "Read", "file content");
    const msgs = t.toMessages();
    const lastMsg = msgs[msgs.length - 1];
    expect(lastMsg.role).toBe("user");
    expect(Array.isArray(lastMsg.content)).toBe(true);
    expect((lastMsg.content as any)[0].type).toBe("tool_result");
  });

  it("persists and loads from file", () => {
    const t1 = new Transcript(filePath);
    t1.appendMessage("user", "hello");
    t1.appendTurnBoundary();
    t1.appendMessage("assistant", "world");

    const t2 = Transcript.loadFromFile(filePath);
    expect(t2.eventCount).toBe(3);
    expect(t2.turnNumber).toBe(1);
  });

  it("repairs orphaned tool results on load", () => {
    const t1 = new Transcript(filePath);
    t1.appendMessage("user", "test");
    // tool_use without matching result
    t1.appendToolUse("Bash", "tc_orphan", { command: "ls" });
    // tool_result without matching use
    t1.appendToolResult("tc_ghost", "Read", "data");

    const t2 = Transcript.loadFromFile(filePath);
    const events = t2.getEvents();
    // orphan should get a synthetic result
    const results = events.filter((e) => e.type === "tool_result");
    const hasOrphanResult = results.some(
      (e) => e.data.toolCallId === "tc_orphan",
    );
    expect(hasOrphanResult).toBe(true);
    // ghost should be removed
    const hasGhost = results.some((e) => e.data.toolCallId === "tc_ghost");
    expect(hasGhost).toBe(false);
  });

  it("appendSummary records compact metadata", () => {
    const t = new Transcript(filePath);
    t.appendSummary("Work summary", { fromTurn: 0, toTurn: 5, eventCount: 20 });
    const summaries = t.getEvents("summary");
    expect(summaries).toHaveLength(1);
    expect(summaries[0].data.summary).toBe("Work summary");
    expect(summaries[0].data.compactedRange).toEqual({ fromTurn: 0, toTurn: 5, eventCount: 20 });
  });
});
