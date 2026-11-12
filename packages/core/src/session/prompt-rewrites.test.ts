import { describe, expect, test } from "bun:test";
import type { TranscriptEvent } from "../types.js";
import { Transcript } from "./transcript.js";
import { buildForkTranscript } from "./session-fork.js";

function rewriteFixture(): { transcript: Transcript; messageId: string } {
  const transcript = Transcript.inMemory("prompt-rewrites");
  const messageId = transcript.appendMessage("user", "typed by the user").id;
  transcript.appendPromptRewrite({ messageEventId: messageId, content: "rewritten by a hook" });
  transcript.appendMessage("assistant", "reply");
  return { transcript, messageId };
}

describe("prompt_rewrite events", () => {
  test("model replay uses the rewrite; the message event keeps the original", () => {
    const { transcript, messageId } = rewriteFixture();
    expect(transcript.toMessages()).toEqual([
      { role: "user", content: "rewritten by a hook" },
      { role: "assistant", content: "reply" },
    ]);
    const event = transcript.getEvents("message").find((e) => e.id === messageId)!;
    expect(event.data.content).toBe("typed by the user");
    expect(Transcript.eventsToMessages(transcript.getEvents())[0]!.content).toBe(
      "rewritten by a hook",
    );
  });

  test("malformed rewrites and rewrites of non-user messages are ignored", () => {
    const transcript = Transcript.inMemory("prompt-rewrites-malformed");
    const user = transcript.appendMessage("user", "original").id;
    const assistant = transcript.appendMessage("assistant", "answer").id;
    transcript.append("prompt_rewrite", { messageEventId: user, content: 42 });
    transcript.append("prompt_rewrite", { content: "no target" });
    transcript.append("prompt_rewrite", { messageEventId: assistant, content: "not a prompt" });
    expect(transcript.toMessages()).toEqual([
      { role: "user", content: "original" },
      { role: "assistant", content: "answer" },
    ]);
  });

  test("a fork keeps the rewrite pointed at its own copy of the message", () => {
    const { transcript } = rewriteFixture();
    const forked = buildForkTranscript(transcript.getEvents(), {
      sessionId: "fork",
      cwd: "/tmp",
      model: "m",
      provider: "p",
      startedAt: 1,
    } as never);
    const copy = Transcript.fromMemoryEvents("fork", forked as TranscriptEvent[]);
    expect(copy.toMessages()[0]).toEqual({ role: "user", content: "rewritten by a hook" });
  });
});
