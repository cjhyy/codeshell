import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Transcript, hasCompleteContextToolPairs } from "../session/transcript.js";
import type { ContentBlock, Message } from "../types.js";
import { SessionManager } from "../session/session-manager.js";
import {
  MAX_CONTEXT_HISTORY_READ_CHARS,
  MAX_CONTEXT_NOTE_CHARS,
  SessionContextNotes,
} from "./notes.js";

function seedHistory(transcript: Transcript): void {
  transcript.appendMessage("user", "earlier original request", { clientMessageId: "old" });
  transcript.appendMessage("assistant", `original delivery marker ${"old evidence ".repeat(1000)}`);
  transcript.appendMessage("user", "current user wording must survive exactly", {
    clientMessageId: "current",
  });
}

function appendBatch(transcript: Transcript, id: string, output = "tool completed"): void {
  transcript.appendMessage("assistant", [{ type: "tool_use", id, name: "Example", input: {} }]);
  transcript.appendToolUse("Example", id, {});
  transcript.appendToolResult(id, "Example", output);
}

describe("SessionContextNotes", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "context-notes-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("replaces a prefix within one long turn, preserving current tool pairs and latest user", () => {
    const transcript = new Transcript(join(dir, "transcript.jsonl"));
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    const id = notes.save("Target, decisions, evidence pointers, remaining next step.");
    appendBatch(transcript, "tools-after-note");
    notes.requestRollover();
    const rebuilt = notes.applyRollover();

    expect(rebuilt).toBeDefined();
    expect(JSON.stringify(rebuilt)).toContain("remaining next step");
    expect(JSON.stringify(rebuilt)).toContain("current user wording must survive exactly");
    expect(JSON.stringify(rebuilt)).toContain("tools-after-note");
    expect(JSON.stringify(rebuilt)).not.toContain("original delivery marker");
    expect(hasCompleteContextToolPairs(rebuilt!)).toBe(true);
    expect(transcript.turnNumber).toBe(0);
    expect(transcript.getEvents("context_note")[0]!.id).toBe(id);
    expect(transcript.getEvents("message")).toHaveLength(4);
    expect(transcript.toMessagesWithIndex().liveIndexByClientMessageId.get("current")).toBe(1);
    expect(transcript.toMessagesWithIndex().liveIndexByClientMessageId.has("old")).toBe(false);
    expect(notes.read(notes.search("original delivery marker")[0]!.eventId)?.text).toContain(
      "original delivery marker",
    );
    expect(() => notes.requestRollover()).toThrow("already been used");
    expect(notes.applyRollover()).toBeUndefined();

    transcript.appendMessage("assistant", "after checkpoint response");
    const expected = transcript.toMessages();
    expect(Transcript.loadFromFile(transcript.getFilePath()).toMessages()).toEqual(expected);
    expect(Transcript.loadContextFromFile(transcript.getFilePath(), 2000).toMessages()).toEqual(
      expected,
    );
    expect(Transcript.fromMemoryEvents("fork", transcript.getEvents()).toMessages()).toEqual(
      expected,
    );
    expect(readFileSync(transcript.getFilePath(), "utf8")).toContain("original delivery marker");
  });

  test("notes stay outside the prompt until a checkpoint commits", () => {
    const transcript = Transcript.inMemory("note-only");
    seedHistory(transcript);
    const before = transcript.toMessages();
    const notes = new SessionContextNotes(transcript);
    expect(() => notes.save("too early")).toThrow("boundary");
    notes.markModelBoundary();
    notes.save("hidden saved note");
    expect(transcript.toMessages()).toEqual(before);
    notes.requestRollover();
    expect(transcript.toMessages()).toEqual(before);
    expect(notes.applyRollover()).toBeDefined();
    expect(existsSync(transcript.getFilePath())).toBe(false);
  });

  test("retains new steering verbatim and excludes injected agent directions from latest user", () => {
    const transcript = Transcript.inMemory("steering");
    seedHistory(transcript);
    transcript.appendMessage("user", "agent direction is not a new user authorization", {
      authority: "agent",
    });
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Continue with the agreed task");
    transcript.appendMessage("user", "new real steering", { clientMessageId: "steered" });
    notes.requestRollover();
    const rebuilt = notes.applyRollover();
    expect(rebuilt?.some((message) => message.content === "new real steering")).toBe(true);
    expect(JSON.stringify(rebuilt)).not.toContain(
      "agent direction is not a new user authorization",
    );
    expect(transcript.toMessagesWithIndex().liveIndexByClientMessageId.get("steered")).toBe(1);
  });

  test("keeps latest real user when subsequent agent directions are before the note boundary", () => {
    const transcript = Transcript.inMemory("agent-direction");
    seedHistory(transcript);
    transcript.appendMessage("user", "agent guidance", { authority: "agent" });
    transcript.appendMessage("user", "runtime reminder", { injected: true });
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Agreed task state");
    notes.requestRollover();
    const rebuilt = notes.applyRollover();
    expect(
      rebuilt?.some((message) => message.content === "current user wording must survive exactly"),
    ).toBe(true);
  });

  test("fails open for unfinished batches and consumes the pending request", () => {
    const transcript = Transcript.inMemory("unfinished");
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Task state");
    transcript.appendMessage("assistant", [{ type: "tool_use", id: "pending", name: "Example" }]);
    transcript.appendToolUse("Example", "pending", {});
    notes.requestRollover();
    const before = transcript.toMessages();
    expect(notes.applyRollover()).toBeUndefined();
    expect(transcript.toMessages()).toEqual(before);
    transcript.appendToolResult("pending", "Example", "finished later");
    expect(notes.applyRollover()).toBeUndefined();
    notes.requestRollover();
    expect(notes.applyRollover()).toBeDefined();
  });

  test("rejects a misplaced cursor that splits a tool call from its result", () => {
    const transcript = Transcript.inMemory("split");
    seedHistory(transcript);
    transcript.appendMessage("assistant", [{ type: "tool_use", id: "split", name: "Example" }]);
    transcript.appendToolUse("Example", "split", {});
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Incorrect boundary must not lose tool output");
    transcript.appendToolResult("split", "Example", "late output");
    notes.requestRollover();
    expect(notes.applyRollover()).toBeUndefined();
    expect(JSON.stringify(transcript.toMessages())).toContain("late output");
  });

  test("keeps active summaries when a candidate would grow the current context", () => {
    const transcript = Transcript.inMemory("already-small");
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Large saved state ".repeat(100));
    notes.requestRollover();
    const alreadyCompacted: Message[] = [{ role: "user", content: "short summary" }];
    expect(notes.applyRollover(alreadyCompacted)).toBeUndefined();
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
    expect(notes.applyRollover()).toBeUndefined();
  });

  test("includes reattached run instructions in the final context budget before committing", () => {
    const transcript = Transcript.inMemory("retained-budget");
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Short task state");
    notes.requestRollover();
    const retained: Message[] = [
      {
        role: "user",
        content: "runtime instructions restored after earlier fallback ".repeat(2000),
      },
    ];
    expect(notes.applyRollover(transcript.toMessages(), retained)).toBeUndefined();
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
    expect(notes.applyRollover()).toBeUndefined();
    notes.requestRollover();
    expect(notes.applyRollover()).toBeDefined();
  });

  test("does not resurrect downgraded tool results or already-consumed image payloads", () => {
    const transcript = Transcript.inMemory("budgeted-results");
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Continue from verified evidence");
    appendBatch(transcript, "large", "raw output ".repeat(1000));
    const current = transcript.toMessages();
    const result = (current.at(-1)!.content as ContentBlock[])[0]!;
    result.content = [
      { type: "text", text: "already budgeted output" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: "BASE64_BYTES" } },
    ];
    notes.requestRollover();
    const rebuilt = notes.applyRollover(current);
    expect(JSON.stringify(rebuilt)).toContain("already budgeted output");
    expect(JSON.stringify(rebuilt)).not.toContain("raw output");
    expect(JSON.stringify(rebuilt)).not.toContain("BASE64_BYTES");
    expect(JSON.stringify(rebuilt)).toContain("already provided earlier");
  });

  test("rejects empty/oversized notes and request without a note", () => {
    const transcript = Transcript.inMemory("invalid-notes");
    transcript.appendMessage("user", "task");
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    expect(() => notes.requestRollover()).toThrow("Save a continuation note");
    expect(() => notes.save(" \n ")).toThrow("non-empty");
    expect(() => notes.save("x".repeat(MAX_CONTEXT_NOTE_CHARS + 1))).toThrow("must not exceed");
    expect(transcript.getEvents("context_note")).toHaveLength(0);
  });

  test("does not activate a failed note or checkpoint write and preserves old disk replay", () => {
    for (const failureType of ["context_note", "context_checkpoint"]) {
      const file = join(dir, `${failureType}.jsonl`);
      const transcript = new Transcript(file, (filePath, data, encoding) => {
        if (JSON.parse(data).type === failureType) throw new Error("injected disk failure");
        appendFileSync(filePath, data, encoding);
      });
      seedHistory(transcript);
      const before = transcript.toMessages();
      const notes = new SessionContextNotes(transcript);
      notes.markModelBoundary();
      if (failureType === "context_note") {
        expect(() => notes.save("State")).toThrow("could not be saved");
        expect(transcript.getEvents("context_note")).toHaveLength(0);
      } else {
        notes.save("State");
        notes.requestRollover();
        expect(notes.applyRollover()).toBeUndefined();
        expect(transcript.getEvents("context_note")).toHaveLength(1);
      }
      expect(notes.applyRollover()).toBeUndefined();
      expect(transcript.getEvents("context_checkpoint")).toHaveLength(0);
      expect(transcript.toMessages()).toEqual(before);
      expect(Transcript.loadFromFile(file).toMessages()).toEqual(before);
    }
  });

  test("ignores corrupt checkpoints and can still replay the preceding valid checkpoint", () => {
    const transcript = Transcript.inMemory("corrupt");
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Valid saved state");
    notes.requestRollover();
    const before = notes.applyRollover();
    const checkpoint = structuredClone(transcript.getEvents("context_checkpoint")[0]!);
    checkpoint.data.messages = [{ role: "user", content: "corrupt snapshot" }];
    transcript.append("context_checkpoint", checkpoint.data);
    expect(transcript.toMessages()).toEqual(before);
    transcript.append("context_checkpoint", null as unknown as Record<string, unknown>);
    expect(transcript.toMessages()).toEqual(before);

    const events = transcript.getEvents().filter((event) => event.id !== checkpoint.id);
    const fallback = Transcript.fromMemoryEvents("without-valid-checkpoint", events).toMessages();
    expect(JSON.stringify(fallback)).toContain("original delivery marker");
    expect(JSON.stringify(fallback)).not.toContain("corrupt snapshot");
  });

  test("supports range archives before and after a checkpoint with live client anchors", () => {
    const transcript = Transcript.inMemory("range-archive");
    seedHistory(transcript);
    transcript.appendRangeArchive({
      summary: "prior segment summary ".repeat(500),
      toClientMessageId: "current",
    });
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Consolidated note");
    notes.requestRollover();
    expect(notes.applyRollover()).toBeDefined();
    transcript.appendMessage("assistant", "current reply");
    transcript.appendMessage("user", "next topic", { clientMessageId: "next" });
    transcript.appendRangeArchive({
      summary: "archived current topic",
      fromClientMessageId: "current",
      toClientMessageId: "next",
    });
    const { messages, liveIndexByClientMessageId } = transcript.toMessagesWithIndex();
    expect(JSON.stringify(messages)).toContain("Consolidated note");
    expect(JSON.stringify(messages)).toContain("archived current topic");
    expect(JSON.stringify(messages)).not.toContain("current user wording");
    expect(liveIndexByClientMessageId.get("next")).toBe(2);
    expect(liveIndexByClientMessageId.has("current")).toBe(false);
  });

  test("supports repeated fresh checkpoints without reviving an earlier context", () => {
    const transcript = Transcript.inMemory("repeated");
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("First state");
    notes.requestRollover();
    notes.applyRollover();
    transcript.appendMessage("assistant", "second phase ".repeat(1000));
    notes.markModelBoundary();
    notes.save("Updated state includes first and second phases");
    appendBatch(transcript, "second-batch");
    notes.requestRollover();
    const result = notes.applyRollover();
    expect(transcript.getEvents("context_checkpoint")).toHaveLength(2);
    expect(JSON.stringify(result)).toContain("Updated state");
    expect(JSON.stringify(result)).not.toContain("First state");
    expect(JSON.stringify(result)).not.toContain("original delivery marker");
    expect(JSON.stringify(result)).toContain("second-batch");
  });

  test("normalizes a late duplicate tool result across the checkpoint boundary", () => {
    const transcript = new Transcript(join(dir, "late-result.jsonl"));
    seedHistory(transcript);
    const notes = new SessionContextNotes(transcript);
    notes.markModelBoundary();
    notes.save("Verified progress");
    appendBatch(transcript, "late-call", "first result");
    notes.requestRollover();
    expect(notes.applyRollover()).toBeDefined();
    transcript.appendMessage("assistant", "continued after checkpoint");
    transcript.appendToolResult("late-call", "Example", "real late result");
    transcript.appendToolResult(
      "late-call",
      "unknown",
      undefined,
      "[Tool result missing due to interrupted session]",
    );
    const messages = transcript.toMessages();
    const results = messages.flatMap((message) =>
      Array.isArray(message.content)
        ? message.content.filter((block) => block.type === "tool_result")
        : [],
    );
    expect(results).toHaveLength(1);
    expect(results[0]!.content).toBe("real late result");
    expect(hasCompleteContextToolPairs(messages)).toBe(true);
    expect(Transcript.loadFromFile(transcript.getFilePath()).toMessages()).toEqual(messages);
  });

  test("forks checkpoints with their provenance while keeping retrieval isolated", () => {
    const manager = new SessionManager(dir);
    const source = manager.create("/project", "model", "provider", "notes-parent");
    seedHistory(source.transcript);
    // Forks skip receipts, so they must never be the note's model cursor.
    source.transcript.append("run_result", { clientMessageId: "old-receipt", result: {} });
    const notes = new SessionContextNotes(source.transcript);
    notes.markModelBoundary();
    notes.save("Forkable state");
    notes.requestRollover();
    const expected = notes.applyRollover();
    const child = manager.fork("notes-parent", { targetSessionId: "notes-child" }).bundle;
    expect(child.transcript.toMessages()).toEqual(expected);
    expect(
      new SessionContextNotes(child.transcript).search("original delivery marker"),
    ).toHaveLength(1);
    const parentOnly = source.transcript.appendMessage("user", "parent-only later secret");
    const childNotes = new SessionContextNotes(child.transcript);
    const originalSourceEvent = source.transcript.getEvents("message")[0]!;
    expect(childNotes.read(originalSourceEvent.id)?.text).toBe("earlier original request");
    expect(childNotes.read(parentOnly.id)).toBeUndefined();
    expect(childNotes.search("parent-only later secret")).toEqual([]);
  });

  test("bounds original history reads and search snippets with event-id pagination", () => {
    const transcript = Transcript.inMemory("search");
    const older = transcript.appendMessage("user", "needle " + "x".repeat(20_000));
    const newer = transcript.appendMessage("assistant", "needle newer");
    transcript.appendMessage("user", [
      { type: "image", source: { type: "base64", media_type: "image/png", data: "IMAGE_SECRET" } },
    ]);
    const notes = new SessionContextNotes(transcript);
    const found = notes.search("NEEDLE", 1);
    expect(found).toMatchObject([{ eventId: newer.id, untrusted: true }]);
    expect(notes.search("needle", 10, newer.id)[0]!.eventId).toBe(older.id);
    expect(notes.read(older.id)).toMatchObject({ truncated: true, untrusted: true });
    expect(notes.read(older.id)!.text).toHaveLength(MAX_CONTEXT_HISTORY_READ_CHARS);
    expect(notes.search("needle", 10, newer.id)[0]!.text.length).toBeLessThanOrEqual(600);
    expect(notes.search("IMAGE_SECRET")).toEqual([]);
    expect(() => notes.search("needle", 1, "not-this-session")).toThrow("does not belong");
    expect(notes.read("../../other-session")).toBeUndefined();
  });
});
