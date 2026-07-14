import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { Transcript } from "../packages/core/src/session/transcript.js";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
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
    const hasOrphanResult = results.some((e) => e.data.toolCallId === "tc_orphan");
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

  it("appendSummary records context_transfer provenance", () => {
    const t = new Transcript(filePath);
    t.appendSummary("portable", {
      trigger: "context_transfer",
      sourceRange: { sessionId: "source", fromEventId: "a", toEventId: "z" },
      sourceEventCount: 9,
      estimatedTokens: 1500,
      summaryVersion: 1,
      summaryHash: "abc",
    });

    const transfer = t.getEvents("context_transfer")[0];
    expect(transfer?.type).toBe("context_transfer");
    expect(transfer?.data).toEqual({
      summary: "portable",
      sourceRange: { sessionId: "source", fromEventId: "a", toEventId: "z" },
      sourceEventCount: 9,
      estimatedTokens: 1500,
      summaryVersion: 1,
      summaryHash: "abc",
    });
  });

  it("deduplicates message appends with the same clientMessageId", () => {
    const t = new Transcript(filePath);
    const first = t.appendMessage("user", "hello", { clientMessageId: "client-1" });
    const second = t.appendMessage("user", "hello", { clientMessageId: "client-1" });

    expect(second.id).toBe(first.id);
    expect(t.getEvents("message")).toHaveLength(1);
    expect(t.getEvents("message")[0]!.data.clientMessageId).toBe("client-1");
  });

  it("deduplicates message appends with the same clientMessageId after reload", () => {
    const first = new Transcript(filePath);
    first.appendMessage("user", "hello", { clientMessageId: "client-1" });

    const reloaded = Transcript.loadFromFile(filePath);
    const second = reloaded.appendMessage("user", "hello", { clientMessageId: "client-1" });

    expect(second.data.clientMessageId).toBe("client-1");
    expect(reloaded.getEvents("message")).toHaveLength(1);
    expect(readFileSync(filePath, "utf-8").trim().split("\n")).toHaveLength(1);
  });

  it("keeps repeated text when clientMessageId differs", () => {
    const t = new Transcript(filePath);
    t.appendMessage("user", "continue", { clientMessageId: "client-1" });
    t.appendMessage("user", "continue", { clientMessageId: "client-2" });

    expect(t.getEvents("message")).toHaveLength(2);
  });

  it("selects an inclusive context range and filters non-context events", () => {
    const t = new Transcript(filePath);
    t.append("session_meta", { sessionId: "source" });
    const from = t.appendMessage("user", "selected request");
    t.append("goal_progress", { status: "not_met" });
    t.appendMessage("assistant", [
      { type: "tool_use", id: "call-1", name: "Read", input: { file_path: "a.ts" } },
    ]);
    t.appendToolUse("Read", "call-1", { file_path: "a.ts" });
    const to = t.appendToolResult("call-1", "Read", "selected result");
    t.appendMessage("assistant", "outside range");

    const selected = Transcript.selectContextRange(t.getEvents(), {
      fromEventId: from.id,
      toEventId: to.id,
    });

    expect(selected.events.map((event) => event.type)).toEqual([
      "message",
      "message",
      "tool_use",
      "tool_result",
    ]);
    expect(JSON.stringify(selected.messages)).toContain("selected request");
    expect(JSON.stringify(selected.messages)).toContain("selected result");
    expect(JSON.stringify(selected.messages)).not.toContain("outside range");
    expect(selected.sourceEventCount).toBe(5);
  });

  it("rejects reversed, missing, duplicate and tool-incomplete context boundaries", () => {
    const t = new Transcript(filePath);
    const first = t.appendMessage("user", "request");
    const assistant = t.appendMessage("assistant", [
      { type: "tool_use", id: "call-1", name: "Read", input: {} },
    ]);
    const use = t.appendToolUse("Read", "call-1", {});
    const result = t.appendToolResult("call-1", "Read", "ok");

    expect(() =>
      Transcript.selectContextRange(t.getEvents(), {
        fromEventId: result.id,
        toEventId: first.id,
      }),
    ).toThrow(/order/i);
    expect(() =>
      Transcript.selectContextRange(t.getEvents(), {
        fromEventId: "missing",
        toEventId: result.id,
      }),
    ).toThrow(/exactly one/i);
    expect(() =>
      Transcript.selectContextRange(t.getEvents(), {
        fromEventId: first.id,
        toEventId: use.id,
      }),
    ).toThrow(/unfinished tool round/i);
    expect(() =>
      Transcript.selectContextRange(t.getEvents(), {
        fromEventId: use.id,
        toEventId: result.id,
      }),
    ).toThrow(/orphaned|metadata/i);

    const duplicate = { ...assistant, id: first.id };
    expect(() =>
      Transcript.selectContextRange([...t.getEvents(), duplicate], {
        fromEventId: first.id,
        toEventId: result.id,
      }),
    ).toThrow(/exactly one/i);
  });
});
