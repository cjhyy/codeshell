import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../types.js";
import { Transcript } from "./transcript.js";
import { buildForkTranscript } from "./session-fork.js";

const forkState = {
  sessionId: "fork",
  cwd: "/tmp",
  model: "m",
  provider: "p",
  startedAt: 1,
} as never;

/**
 * A checkpoint absorbed the run's prompt: later links name its replayed
 * message as `<checkpointId>:<index>`.
 */
function checkpointFixture(): { transcript: Transcript; link: string } {
  const transcript = Transcript.inMemory("fork-links");
  transcript.appendMessage("user", "old question");
  const covered = transcript.appendMessage("assistant", "old answer").id;
  const note = transcript.appendContextNote("what came before", covered)!;
  const checkpoint = transcript.appendContextCheckpoint({
    version: 1,
    noteId: note.id,
    coveredThroughEventId: covered,
    messages: [
      { role: "user", content: "summary of the earlier conversation" },
      { role: "user", content: "task as typed" },
    ],
    clientMessageIds: [],
  })!;
  const link = `${checkpoint.id}:1`;
  transcript.appendMessage("user", "<system-reminder>hook rules</system-reminder>", {
    hookReminder: { beforeEventId: link, promptSubmit: ["hook rules"] },
  });
  transcript.appendPromptRewrite({ messageEventId: link, content: "task as rewritten" });
  transcript.appendMessage("assistant", "reply");
  return { transcript, link };
}

describe("fork links into a checkpoint", () => {
  test("a fork replays a checkpoint-absorbed rewrite and reminder like its source", () => {
    const { transcript } = checkpointFixture();
    const source = transcript.toMessages();
    // The links are live in the source: the reminder precedes the rewritten task.
    expect(source.map((message) => message.content)).toEqual([
      "summary of the earlier conversation",
      "<system-reminder>hook rules</system-reminder>",
      "task as rewritten",
      "reply",
    ]);
    const forked = buildForkTranscript(transcript.getEvents(), forkState);
    const copy = Transcript.fromMemoryEvents("fork", forked as TranscriptEvent[]);
    expect(copy.toMessages()).toEqual(source);
  });

  test("checkpoint links are rewritten to the copied checkpoint id", () => {
    const { transcript, link } = checkpointFixture();
    const forked = buildForkTranscript(transcript.getEvents(), forkState);
    const checkpoint = forked.find((event) => event.type === "context_checkpoint")!;
    const rewrite = forked.find((event) => event.type === "prompt_rewrite")!;
    const reminder = forked.find((event) => event.data.hookReminder !== undefined)!;
    expect(rewrite.data.messageEventId).toBe(`${checkpoint.id}:1`);
    expect((reminder.data.hookReminder as { beforeEventId: string }).beforeEventId).toBe(
      `${checkpoint.id}:1`,
    );
    expect(rewrite.data.messageEventId).not.toBe(link);
  });

  test("a link that names no copied checkpoint is left as it is", () => {
    const transcript = Transcript.inMemory("fork-links-unknown");
    transcript.appendMessage("user", "task");
    transcript.appendPromptRewrite({ messageEventId: "missing:0", content: "rewritten" });
    const forked = buildForkTranscript(transcript.getEvents(), forkState);
    expect(forked.find((event) => event.type === "prompt_rewrite")!.data.messageEventId).toBe(
      "missing:0",
    );
  });
});
