import { describe, it, expect } from "bun:test";
import { foldTranscript } from "./foldTranscript";
import type { FoldItem } from "../../preload/types";

describe("foldTranscript", () => {
  it("builds user + assistant messages", () => {
    const items: FoldItem[] = [
      { kind: "stream", event: { type: "session_started", sessionId: "s1", promptTokens: 0 } },
      { kind: "user", text: "hello" },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } },
      { kind: "stream", event: { type: "text_delta", text: "hi there" } },
      { kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi there" } } },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
    ];
    const state = foldTranscript(items);
    expect(state.sessionId).toBe("s1");
    const kinds = state.messages.map((m) => m.kind);
    expect(kinds).toContain("user");
    expect(kinds).toContain("assistant");
    const assistant = state.messages.find((m) => m.kind === "assistant");
    expect(assistant && (assistant as { text: string }).text).toBe("hi there");
  });

  it("renders a tool call", () => {
    const items: FoldItem[] = [
      { kind: "stream", event: { type: "tool_use_start", toolCall: { id: "tc1", toolName: "Bash", args: { command: "ls" } } } },
      { kind: "stream", event: { type: "tool_result", result: { id: "tc1", toolName: "Bash", result: "out" } } },
    ];
    const state = foldTranscript(items);
    const tool = state.messages.find((m) => m.kind === "tool");
    expect(tool).toBeDefined();
    expect((tool as { toolName: string }).toolName).toBe("Bash");
  });

  it("returns empty state for empty input", () => {
    expect(foldTranscript([]).messages).toEqual([]);
  });

  it("does not stamp replay-time on assistant messages", () => {
    // Replaying a persisted transcript must NOT fabricate createdAt/doneAt
    // from the current clock — the original timestamps aren't in the
    // FoldItem stream, so the only honest value is "absent" (the footer
    // then renders nothing, same as replayed user messages). Stamping
    // Date.now() made old sessions hover-display today's time (e.g. 16:30).
    const items: FoldItem[] = [
      { kind: "user", text: "hello" },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } },
      { kind: "stream", event: { type: "text_delta", text: "hi" } },
      { kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi" } } },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
    ];
    const state = foldTranscript(items);
    const assistant = state.messages.find((m) => m.kind === "assistant") as
      | { createdAt?: number; doneAt?: number }
      | undefined;
    expect(assistant).toBeDefined();
    expect(assistant!.createdAt).toBeUndefined();
    expect(assistant!.doneAt).toBeUndefined();
  });
});
