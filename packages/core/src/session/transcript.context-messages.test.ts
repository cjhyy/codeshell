import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Transcript } from "./transcript.js";
import {
  contextMessageMark,
  isContextMessageEvent,
  readContextLedgerData,
  readHookReminderData,
} from "./context-messages.js";
import { buildForkTranscript } from "./session-fork.js";
import type { SessionState } from "../types.js";

const ledger = { kind: "snapshot" as const, state: '{"version":1,"sections":{}}' };

describe("context messages in the transcript", () => {
  test("a ledger event is an injected message replayed in place and marked by event id", () => {
    const transcript = Transcript.inMemory("ledger");
    transcript.appendMessage("user", "task");
    const event = transcript.appendMessage("user", "<system-reminder>\nctx\n</system-reminder>", {
      contextLedger: ledger,
    });
    transcript.appendMessage("assistant", "done");

    expect(event.data.injected).toBe(true);
    expect(isContextMessageEvent(event)).toBe(true);
    expect(readContextLedgerData(event)).toEqual(ledger);

    const messages = transcript.toMessages();
    expect(messages).toEqual([
      { role: "user", content: "task" },
      { role: "user", content: "<system-reminder>\nctx\n</system-reminder>" },
      { role: "assistant", content: "done" },
    ]);
    expect(contextMessageMark(messages[1]!)).toEqual({ kind: "ledger", eventId: event.id });
    expect(contextMessageMark(messages[0]!)).toBeUndefined();
    // Marks are metadata only: nothing is added to what a provider would receive.
    expect(Object.keys(messages[1]!)).toEqual(["role", "content"]);
  });

  test("a hook reminder is replayed just before the user message it names", () => {
    const transcript = Transcript.inMemory("reminder");
    transcript.appendMessage("user", "first");
    transcript.appendMessage("assistant", "one");
    const task = transcript.appendMessage("user", "second");
    const reminder = transcript.appendMessage(
      "user",
      "<system-reminder>\nhook\n</system-reminder>",
      {
        hookReminder: { beforeEventId: task.id, sessionStart: ["hook"] },
      },
    );
    transcript.appendMessage("assistant", "two");

    const messages = transcript.toMessages();
    expect(messages.map((message) => message.content)).toEqual([
      "first",
      "one",
      "<system-reminder>\nhook\n</system-reminder>",
      "second",
      "two",
    ]);
    expect(contextMessageMark(messages[2]!)).toEqual({
      kind: "hook-reminder",
      eventId: reminder.id,
      reminder: { beforeEventId: task.id, sessionStart: ["hook"] },
    });
  });

  test("a reminder whose target is missing or later stays where it was written", () => {
    const transcript = Transcript.inMemory("orphan");
    transcript.appendMessage("user", "task");
    transcript.appendMessage("user", "A", { hookReminder: { beforeEventId: "no-such-event" } });
    transcript.appendMessage("assistant", "reply");
    expect(transcript.toMessages().map((message) => message.content)).toEqual([
      "task",
      "A",
      "reply",
    ]);
  });

  test("an archived span takes the reminder of a message inside it, not of its boundaries", () => {
    const transcript = Transcript.inMemory("spans");
    const remind = (id: string, text: string): void => {
      transcript.appendMessage("user", text, { hookReminder: { beforeEventId: id } });
    };
    remind(transcript.appendMessage("user", "m1", { clientMessageId: "c1" }).id, "r1");
    transcript.appendMessage("assistant", "a1");
    remind(transcript.appendMessage("user", "m2", { clientMessageId: "c2" }).id, "r2");
    transcript.appendMessage("assistant", "a2");
    remind(transcript.appendMessage("user", "m3", { clientMessageId: "c3" }).id, "r3");
    remind(transcript.appendMessage("user", "m4", { clientMessageId: "c4" }).id, "r4");
    transcript.appendRangeArchive({
      summary: "S",
      fromClientMessageId: "c2",
      toClientMessageId: "c4",
    });
    expect(transcript.toMessages().map((message) => message.content)).toEqual([
      "r1",
      "m1",
      "a1",
      "r2", // precedes the span-opening message, so it is outside the span
      "S",
      "r4", // precedes the message that closes the span
      "m4",
    ]);
  });

  test("replay from disk yields the same messages and marks", () => {
    const dir = mkdtempSync(join(tmpdir(), "cs-context-messages-"));
    try {
      const file = join(dir, "transcript.jsonl");
      const transcript = new Transcript(file);
      const task = transcript.appendMessage("user", "task");
      transcript.appendMessage("user", "reminder", {
        hookReminder: { beforeEventId: task.id, promptSubmit: ["reminder"] },
      });
      const snapshot = transcript.appendMessage("user", "context", { contextLedger: ledger });
      const reloaded = Transcript.loadFromFile(file).toMessages();
      expect(reloaded).toEqual(transcript.toMessages());
      expect(reloaded.map((message) => message.content)).toEqual(["reminder", "task", "context"]);
      expect(contextMessageMark(reloaded[2]!)).toEqual({ kind: "ledger", eventId: snapshot.id });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("data that is not understood is ignored: the message replays unmarked and in place", () => {
    const transcript = Transcript.inMemory("garbage");
    transcript.appendMessage("user", "task");
    const bad = transcript.append("message", {
      role: "user",
      content: "x",
      injected: true,
      contextLedger: { kind: "mystery", state: 7 },
    });
    const odd = transcript.append("message", {
      role: "user",
      content: "y",
      injected: true,
      hookReminder: "nope",
    });
    expect(readContextLedgerData(bad)).toBeUndefined();
    expect(readHookReminderData(odd)).toBeUndefined();
    // Still context, not conversation, for anything deciding what to show.
    expect(isContextMessageEvent(bad)).toBe(true);
    const messages = transcript.toMessages();
    expect(messages.map((message) => message.content)).toEqual(["task", "x", "y"]);
    expect(messages.every((message) => contextMessageMark(message) === undefined)).toBe(true);
  });

  test("toConversationMessages leaves engine context out", () => {
    const transcript = Transcript.inMemory("conversation");
    const task = transcript.appendMessage("user", "task");
    transcript.appendMessage("user", "reminder", { hookReminder: { beforeEventId: task.id } });
    transcript.appendMessage("user", "context", { contextLedger: ledger });
    transcript.appendMessage("assistant", "reply");
    expect(transcript.toMessages()).toHaveLength(4);
    expect(transcript.toConversationMessages()).toEqual([
      { role: "user", content: "task" },
      { role: "assistant", content: "reply" },
    ]);
  });

  test("a hand-picked context range leaves engine context out", () => {
    const transcript = Transcript.inMemory("range");
    const task = transcript.appendMessage("user", "task");
    transcript.appendMessage("user", "reminder", { hookReminder: { beforeEventId: task.id } });
    transcript.appendMessage("user", "context", { contextLedger: ledger });
    const reply = transcript.appendMessage("assistant", "reply");
    const selected = Transcript.selectContextRange(transcript.getEvents(), {
      fromEventId: task.id,
      toEventId: reply.id,
    });
    expect(selected.messages.map((message) => message.content)).toEqual(["task", "reply"]);
    expect(selected.sourceEventCount).toBe(4);
  });

  test("a fork keeps a reminder in front of its copied user message", () => {
    const transcript = Transcript.inMemory("fork-source");
    const task = transcript.appendMessage("user", "task");
    transcript.appendMessage("user", "reminder", { hookReminder: { beforeEventId: task.id } });
    transcript.appendMessage("assistant", "reply");
    const forked = buildForkTranscript(transcript.getEvents(), {
      sessionId: "fork-target",
      cwd: "/tmp",
      startedAt: 1,
      model: "m",
      provider: "p",
    } as SessionState);
    const copy = Transcript.fromMemoryEvents("fork-target", forked);
    expect(copy.toMessages().map((message) => message.content)).toEqual([
      "reminder",
      "task",
      "reply",
    ]);
  });
});
