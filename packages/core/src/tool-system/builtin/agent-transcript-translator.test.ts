import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { asyncAgentRegistry } from "./agent-registry.js";
import { createTranscriptTranslator } from "./agent-transcript-translator.js";

const AGENT_ID = "translator-agent";

beforeEach(() => {
  asyncAgentRegistry.reset();
  asyncAgentRegistry.register({
    agentId: AGENT_ID,
    description: "test agent",
    status: "running",
    startedAt: Date.now(),
    abort: () => {},
    transcript: [],
  });
});
afterEach(() => asyncAgentRegistry.reset());

const transcript = () =>
  (asyncAgentRegistry.get(AGENT_ID)?.transcript ?? []).map((e) => ({
    type: e.type,
    text: e.text,
    toolCallId: e.toolCallId,
  }));

describe("createTranscriptTranslator tombstones", () => {
  it("removes a revoked partial reply and keeps the replacement and earlier turns", () => {
    const translate = createTranscriptTranslator(AGENT_ID);
    translate({ type: "stream_request_start", turnNumber: 1, messageId: "msg-1" });
    translate({ type: "text_delta", text: "first turn" });
    translate({ type: "turn_complete", turnNumber: 1 } as never);

    translate({ type: "stream_request_start", turnNumber: 2, messageId: "msg-2" });
    translate({ type: "text_delta", text: "partial that gets revo" });
    translate({
      type: "tool_use_start",
      toolCall: { id: "call-x", toolName: "Read", args: {} },
    });
    translate({ type: "tombstone", messageId: "msg-2" });
    translate({ type: "tombstone", messageId: "call-x" });
    translate({ type: "stream_request_start", turnNumber: 2, messageId: "msg-2" });
    translate({ type: "text_delta", text: "replacement" });

    expect(transcript()).toEqual([
      { type: "assistant_text", text: "first turn", toolCallId: undefined },
      { type: "assistant_text", text: "replacement", toolCallId: undefined },
    ]);
  });

  it("still seals the streaming reply on turn_complete", () => {
    const translate = createTranscriptTranslator(AGENT_ID);
    translate({ type: "stream_request_start", turnNumber: 1, messageId: "msg-1" });
    translate({ type: "text_delta", text: "done" });
    translate({ type: "turn_complete", turnNumber: 1 } as never);
    expect(asyncAgentRegistry.get(AGENT_ID)?.transcript?.[0]?.streaming).toBe(false);
  });
});
