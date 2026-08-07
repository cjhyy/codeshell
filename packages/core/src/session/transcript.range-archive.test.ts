import { describe, it, expect, beforeEach, afterEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript } from "./transcript.js";
import type { TranscriptEvent } from "../types.js";

let seq = 0;
function ev(type: TranscriptEvent["type"], data: Record<string, unknown>): TranscriptEvent {
  seq += 1;
  return { id: `e${seq}`, type, timestamp: seq, turnNumber: 0, data };
}

describe("Transcript range_archive", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cs-tr-arch-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  function seed(t: Transcript): void {
    t.appendMessage("user", "话题A第一句", { clientMessageId: "m1" });
    t.appendMessage("assistant", "回A1");
    t.appendMessage("user", "话题A第二句", { clientMessageId: "m2" });
    t.appendMessage("assistant", "回A2");
    t.appendMessage("user", "话题B第一句", { clientMessageId: "m3" });
    t.appendMessage("assistant", "回B1");
  }

  it("replaces the [from, to) span with the summary on replay", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "【归档】话题A的摘要",
      fromClientMessageId: "m1",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });

    const messages = t.toMessages();
    const texts = messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("【归档】话题A的摘要");
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(false);
    expect(texts.some((x) => x.includes("回A2"))).toBe(false);
    // 区间是半开的：to 边界消息本身保留
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
    expect(messages).toHaveLength(3); // 摘要 + m3 + 回B1
  });

  it("an undefined fromClientMessageId archives from the beginning", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "【归档】开头到m3",
      toClientMessageId: "m3",
      segmentId: "seg-open",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("【归档】开头到m3");
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(false);
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(true);
  });

  it("is idempotent on segmentId", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    const first = t.appendRangeArchive({
      summary: "s",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });
    const second = t.appendRangeArchive({
      summary: "s",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });
    expect(first).toBeDefined();
    expect(second).toBeUndefined();
    expect(t.getEvents("range_archive")).toHaveLength(1);
  });

  it("ignores a marker whose toClientMessageId is missing (fails open to full history)", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "坏标记",
      fromClientMessageId: "m1",
      toClientMessageId: "no-such-id",
      segmentId: "seg-bad",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(true);
    expect(texts.some((x) => x === "坏标记")).toBe(false);
  });

  it("ignores a marker whose from comes after to (fails open)", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "乱序标记",
      fromClientMessageId: "m2",
      toClientMessageId: "m1",
      segmentId: "seg-reversed",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(true);
    expect(texts.some((x) => x.includes("话题A第二句"))).toBe(true);
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
    expect(texts.some((x) => x === "乱序标记")).toBe(false);
  });

  it("ignores a degenerate marker where from === to", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendRangeArchive({
      summary: "退化标记",
      fromClientMessageId: "m2",
      toClientMessageId: "m2",
      segmentId: "seg-degenerate",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(true);
    expect(texts.some((x) => x.includes("话题A第二句"))).toBe(true);
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
    expect(texts.some((x) => x === "退化标记")).toBe(false);
  });

  it("survives reload from disk", () => {
    const file = join(dir, "t.jsonl");
    const t = new Transcript(file);
    seed(t);
    t.appendRangeArchive({
      summary: "【归档】话题A的摘要",
      fromClientMessageId: "m1",
      toClientMessageId: "m3",
      segmentId: "seg-1",
    });
    const reloaded = Transcript.loadFromFile(file);
    const texts = reloaded
      .toMessages()
      .map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("【归档】话题A的摘要");
    expect(texts.some((x) => x.includes("话题A第一句"))).toBe(false);
  });

  it("adjacent spans: to of span A === from of span B", () => {
    const t = new Transcript(join(dir, "t.jsonl"));
    seed(t);
    t.appendMessage("user", "话题C第一句", { clientMessageId: "m4" });
    t.appendRangeArchive({
      summary: "A段摘要",
      fromClientMessageId: "m1",
      toClientMessageId: "m3",
      segmentId: "seg-a",
    });
    t.appendRangeArchive({
      summary: "B段摘要",
      fromClientMessageId: "m3",
      toClientMessageId: "m4",
      segmentId: "seg-b",
    });
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("A段摘要");
    expect(texts[1]).toBe("B段摘要");
    expect(texts.some((x) => x.includes("话题B第一句"))).toBe(false);
    expect(texts.some((x) => x.includes("话题C第一句"))).toBe(true);
  });

  it("a duplicate from message (e.g. torn JSONL reload) does not reopen the span and swallow the tail", () => {
    // Same clientMessageId ("m1") appears twice as a message event — this can
    // happen across a torn JSONL write or a double-writer race; appendMessage's
    // in-process dedup does not protect replay from events loaded off disk.
    const events: TranscriptEvent[] = [
      ev("message", { role: "user", content: "话题A第一句", clientMessageId: "m1" }),
      ev("message", { role: "assistant", content: "回A1" }),
      ev("range_archive", { summary: "摘要", fromClientMessageId: "m1", toClientMessageId: "m2" }),
      ev("message", { role: "user", content: "话题A第二句", clientMessageId: "m2" }),
      // Duplicate "m1" message event further down the transcript.
      ev("message", { role: "user", content: "话题A第一句(重复)", clientMessageId: "m1" }),
      ev("message", { role: "assistant", content: "回B1" }),
      ev("message", { role: "user", content: "话题C", clientMessageId: "m3" }),
    ];
    const t = Transcript.fromMemoryEvents("dup-from", events);
    const texts = t.toMessages().map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts.filter((x) => x === "摘要")).toHaveLength(1);
    expect(texts.some((x) => x.includes("话题A第一句(重复)"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
    expect(texts.some((x) => x.includes("话题C"))).toBe(true);
  });

  it("drops an orphaned tool_result whose tool_use fell inside an archived span", () => {
    // tool_use lives inside the archived span; its preferred (real) result
    // was written later and lands outside the span. Without the emitted-id
    // guard this would surface as a tool_result block with no matching
    // tool_use in the replayed messages — an invalid request to the provider.
    const events: TranscriptEvent[] = [
      ev("message", { role: "user", content: "话题A第一句", clientMessageId: "m1" }),
      ev("message", {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-1", name: "Read", input: {} }],
      }),
      ev("tool_use", { toolName: "Read", toolCallId: "call-1", args: {} }),
      // Synthetic interrupted placeholder result, still inside the span.
      ev("tool_result", {
        toolCallId: "call-1",
        toolName: "unknown",
        error: "[Tool result missing due to interrupted session]",
      }),
      ev("range_archive", { summary: "摘要", fromClientMessageId: "m1", toClientMessageId: "m2" }),
      ev("message", { role: "user", content: "话题B", clientMessageId: "m2" }),
      // The real, preferred result arrives AFTER the span closes.
      ev("tool_result", { toolCallId: "call-1", toolName: "Read", result: "file contents" }),
      ev("message", { role: "assistant", content: "回B1" }),
    ];
    const t = Transcript.fromMemoryEvents("orphan-result", events);
    const messages = t.toMessages();
    const texts = messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("摘要");
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        if (block.type === "tool_result") {
          expect(block.tool_use_id).not.toBe("call-1");
        }
      }
    }
    expect(texts.some((x) => x.includes("话题B"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
  });

  it("drops a complete tool_use/tool_result round that lies entirely inside a span", () => {
    const events: TranscriptEvent[] = [
      ev("message", { role: "user", content: "话题A第一句", clientMessageId: "m1" }),
      ev("message", {
        role: "assistant",
        content: [{ type: "tool_use", id: "call-2", name: "Read", input: {} }],
      }),
      ev("tool_use", { toolName: "Read", toolCallId: "call-2", args: {} }),
      ev("tool_result", { toolCallId: "call-2", toolName: "Read", result: "irrelevant" }),
      ev("range_archive", { summary: "摘要", fromClientMessageId: "m1", toClientMessageId: "m2" }),
      ev("message", { role: "user", content: "话题B", clientMessageId: "m2" }),
      ev("message", { role: "assistant", content: "回B1" }),
    ];
    const t = Transcript.fromMemoryEvents("full-round-in-span", events);
    const messages = t.toMessages();
    const texts = messages.map((m) => (typeof m.content === "string" ? m.content : ""));
    expect(texts[0]).toBe("摘要");
    for (const m of messages) {
      if (!Array.isArray(m.content)) continue;
      for (const block of m.content) {
        expect(block.type).not.toBe("tool_use");
        expect(block.type).not.toBe("tool_result");
      }
    }
    expect(texts.some((x) => x.includes("话题B"))).toBe(true);
    expect(texts.some((x) => x.includes("回B1"))).toBe(true);
  });
});
