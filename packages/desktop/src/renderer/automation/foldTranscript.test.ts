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

  it("stamps the ORIGINAL persisted timestamps so elapsed is real", () => {
    // The FoldItems carry the real wall-clock each event was persisted at.
    // Replay must reflect those (asked-at / answered-at), NOT the current
    // clock and NOT blank — blank read as "0s elapsed" after a refresh.
    const asked = 1_700_000_000_000;
    const answered = asked + 4_000; // 4s later
    const items: FoldItem[] = [
      { kind: "user", text: "hello", timestamp: asked },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 }, timestamp: asked },
      { kind: "stream", event: { type: "text_delta", text: "hi" }, timestamp: answered },
      { kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi" } }, timestamp: answered },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" }, timestamp: answered },
    ];
    const state = foldTranscript(items);
    const user = state.messages.find((m) => m.kind === "user") as { createdAt?: number };
    const assistant = state.messages.find((m) => m.kind === "assistant") as
      | { createdAt?: number; doneAt?: number }
      | undefined;
    expect(user.createdAt).toBe(asked);
    expect(assistant!.doneAt).toBe(answered);
    // Elapsed = answer time − ask time = the real 4s, not 0.
    expect(assistant!.doneAt! - user.createdAt!).toBe(4_000);
  });

  it("leaves timestamps absent for legacy items that carry none", () => {
    // Transcripts written before timestamps were threaded through have no
    // per-item timestamp. We must NOT fabricate the replay-time onto them
    // (that made old sessions hover-display today's clock, e.g. "16:30").
    const items: FoldItem[] = [
      { kind: "user", text: "hello" },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } },
      { kind: "stream", event: { type: "text_delta", text: "hi" } },
      { kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "hi" } } },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" } },
    ];
    const state = foldTranscript(items);
    const user = state.messages.find((m) => m.kind === "user") as { createdAt?: number };
    const assistant = state.messages.find((m) => m.kind === "assistant") as
      | { createdAt?: number; doneAt?: number }
      | undefined;
    expect(user.createdAt).toBeUndefined();
    expect(assistant!.createdAt).toBeUndefined();
    expect(assistant!.doneAt).toBeUndefined();
  });
});
