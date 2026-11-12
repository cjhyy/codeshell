import { describe, expect, it } from "bun:test";

import { contextMessageMark, markContextMessage } from "../session/context-messages.js";
import { Transcript } from "../session/transcript.js";
import type { Message } from "../types.js";
import {
  checkpointMessageEventId,
  persistRemindersBeforeCheckpoint,
  replayEventIdOf,
  withoutCheckpointDuplicates,
} from "./rollover-context.js";

const user = (content: string): Message => ({ role: "user", content });

/** A transcript whose latest events are a note and the checkpoint built on it. */
function checkpointed(messages: Message[], clientMessageIds: [string, number][] = []) {
  const transcript = Transcript.inMemory("rollover-context");
  const first = transcript.appendMessage("user", "old question");
  transcript.appendMessage("assistant", "old answer");
  const task = transcript.appendMessage("user", "current task", { clientMessageId: "client-task" });
  const note = transcript.appendContextNote("carry on", first.id)!;
  const checkpoint = transcript.appendContextCheckpoint({
    version: 1,
    noteId: note.id,
    coveredThroughEventId: first.id,
    messages,
    clientMessageIds,
  })!;
  return { transcript, first, task, checkpoint };
}

describe("engine context across a rollover", () => {
  it("resolves a message a later checkpoint absorbed to its snapshot position", () => {
    const snapshot = [user("<context-note>carry on</context-note>"), user("current task")];
    const byClientId = checkpointed([...snapshot, user("later")], [["client-task", 1]]);
    expect(replayEventIdOf(byClientId.transcript, byClientId.task.id)).toBe(
      checkpointMessageEventId(byClientId.checkpoint.id, 1),
    );
    // No client id recorded: the message is recognised as the snapshot's last.
    const byPosition = checkpointed(snapshot);
    expect(replayEventIdOf(byPosition.transcript, byPosition.task.id)).toBe(
      checkpointMessageEventId(byPosition.checkpoint.id, 1),
    );
  });

  it("keeps the original id when no checkpoint follows or the message cannot be placed", () => {
    const plain = Transcript.inMemory("rollover-context-plain");
    const event = plain.appendMessage("user", "task");
    expect(replayEventIdOf(plain, event.id)).toBe(event.id);
    expect(replayEventIdOf(plain, "unknown-event")).toBe("unknown-event");
    const unplaced = checkpointed([user("note"), user("something else")]);
    expect(replayEventIdOf(unplaced.transcript, unplaced.task.id)).toBe(unplaced.task.id);
    // A message written after the checkpoint is replayed as itself.
    const later = unplaced.transcript.appendMessage("user", "next task");
    expect(replayEventIdOf(unplaced.transcript, later.id)).toBe(later.id);
  });

  it("re-attaches retained reminders in front of the checkpoint, once", () => {
    const { transcript, checkpoint } = checkpointed([user("note"), user("current task")]);
    const head = user("user context");
    const reminder = user("<system-reminder>\nRULES\n</system-reminder>");
    markContextMessage(reminder, {
      kind: "hook-reminder",
      eventId: "old-event",
      reminder: { beforeEventId: "old-target", sessionStart: ["RULES"] },
    });
    const retained = withoutCheckpointDuplicates(
      [head, reminder, user("note")],
      [user("note"), user("current task")],
    );
    expect(retained).toEqual([head, reminder]);

    persistRemindersBeforeCheckpoint(transcript, retained);
    expect(contextMessageMark(head)).toBeUndefined();
    const mark = contextMessageMark(reminder);
    expect(mark).toMatchObject({
      kind: "hook-reminder",
      reminder: {
        beforeEventId: checkpointMessageEventId(checkpoint.id, 0),
        sessionStart: ["RULES"],
      },
    });
    expect(mark?.eventId).not.toBe("old-event");
    const replay = transcript.toMessages();
    expect(replay.map((message) => message.content)).toEqual([
      reminder.content,
      "note",
      "current task",
    ]);
    expect(contextMessageMark(replay[0]!)?.kind).toBe("hook-reminder");
  });
});
