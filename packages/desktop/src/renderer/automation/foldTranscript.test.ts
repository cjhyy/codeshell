import { describe, it, expect } from "bun:test";
import { foldTranscript } from "./foldTranscript";
import { transcriptToFoldItems } from "../../main/transcript-reader";
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

  it("rebuilds a turn_end stopped marker from a turn_stopped FoldItem (resume un-fold)", () => {
    // Resume bug: the renderer's turn_end is in-memory only, so an interrupted
    // turn folds behind the process-card header on reload. The core transcript
    // now persists a turn_stopped event → reader emits {kind:"turn_stopped"} →
    // foldTranscript rebuilds the turn_end so the turn renders flat again.
    const items: FoldItem[] = [
      { kind: "user", text: "do a long thing" },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 } },
      { kind: "stream", event: { type: "tool_use_start", toolCall: { id: "t1", toolName: "Bash", args: {} } } },
      { kind: "stream", event: { type: "tool_result", result: { id: "t1", toolName: "Bash", result: "x" } } },
      { kind: "turn_stopped" },
    ];
    const state = foldTranscript(items);
    const end = state.messages.find((m) => m.kind === "turn_end");
    expect(end).toBeDefined();
    expect((end as { reason: string }).reason).toBe("stopped");
  });

  it("transcriptToFoldItems maps a turn_stopped transcript event to a turn_stopped FoldItem", () => {
    const jsonl = [
      JSON.stringify({ id: "a", type: "message", timestamp: 1, turnNumber: 0, data: { role: "user", content: "go" } }),
      JSON.stringify({ id: "b", type: "turn_stopped", timestamp: 2, turnNumber: 0, data: {} }),
    ].join("\n");
    const items = transcriptToFoldItems(jsonl);
    expect(items.some((it) => it.kind === "turn_stopped")).toBe(true);
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

  it("stamps tool startedAt/endedAt from the persisted timestamps, NOT replay-time", () => {
    // The bug: tool_use_start/tool_result hard-coded Date.now(), ignoring the
    // replay clock. On replay every tool got "now" — so turnSpan stretched from
    // the real user time to the replay moment, and the card's elapsed grew every
    // time you reopened the session. Tools must use the persisted timestamps.
    const t0 = 1_700_000_000_000;
    const items: FoldItem[] = [
      { kind: "user", text: "fix it", timestamp: t0 },
      { kind: "stream", event: { type: "stream_request_start", turnNumber: 0 }, timestamp: t0 + 1_000 },
      { kind: "stream", event: { type: "tool_use_start", toolCall: { id: "tc1", toolName: "Bash", args: {} } }, timestamp: t0 + 2_000 },
      { kind: "stream", event: { type: "tool_result", result: { id: "tc1", toolName: "Bash", result: "ok" } }, timestamp: t0 + 5_000 },
      { kind: "stream", event: { type: "assistant_message", message: { role: "assistant", content: "done" } }, timestamp: t0 + 6_000 },
      { kind: "stream", event: { type: "turn_complete", reason: "completed" }, timestamp: t0 + 6_000 },
    ];
    const state = foldTranscript(items);
    const tool = state.messages.find((m) => m.kind === "tool") as
      | { startedAt: number; endedAt?: number; durationMs?: number }
      | undefined;
    expect(tool!.startedAt).toBe(t0 + 2_000);
    expect(tool!.endedAt).toBe(t0 + 5_000);
    expect(tool!.durationMs).toBe(3_000);
    // And the stamp must be in the persisted past, never near the replay clock.
    expect(tool!.startedAt).toBeLessThan(t0 + 10_000);
  });

  it("puts the files_changed card at the turn END, not sandwiched before the closing summary", () => {
    // Real-transcript shape: a `turn_boundary turnNumber=N` marks the START of
    // turn N and is written BEFORE that turn's content. The LAST turn's closing
    // summary text therefore lands after its turn_complete — which used to pin
    // the files_changed card BEFORE the summary ("夹在两段文字中间"). The reader
    // appends a closing turn_complete at EOF so the card moves to the real end.
    const jsonl = [
      { type: "message", turnNumber: 0, data: { role: "user", content: "完成修复" } },
      { type: "turn_boundary", turnNumber: 28, data: { turnNumber: 28 } },
      { type: "message", turnNumber: 28, data: { role: "assistant", content: [{ type: "text", text: "验证完成，更新任务状态。" }, { type: "tool_use", id: "e1", name: "Edit", input: {} }] } },
      { type: "tool_use", turnNumber: 28, data: { toolCallId: "e1", toolName: "Edit", args: { file_path: "renderer.ts", old_string: "a", new_string: "b" } } },
      { type: "tool_result", turnNumber: 28, data: { toolCallId: "e1", toolName: "Edit", result: "Successfully edited" } },
      { type: "turn_boundary", turnNumber: 29, data: { turnNumber: 29 } },
      { type: "message", turnNumber: 29, data: { role: "assistant", content: "已完成，按 TDD 做了。" } },
    ].map((e, i) => JSON.stringify({ id: `e${i}`, timestamp: 1000 + i, ...e })).join("\n");
    const state = foldTranscript(transcriptToFoldItems(jsonl));
    const kinds = state.messages.map((m) => m.kind);
    const cardIdx = kinds.indexOf("files_changed");
    const lastAssistantIdx = kinds.lastIndexOf("assistant");
    expect(cardIdx).toBeGreaterThan(-1);
    // The card must come AFTER the final summary assistant, not before it.
    expect(cardIdx).toBeGreaterThan(lastAssistantIdx);
    expect(state.messages.filter((m) => m.kind === "files_changed")).toHaveLength(1);
  });

  it("seals an orphaned sub-agent (agent_start, no agent_end) so the card isn't stuck 'working'", () => {
    // Regression (session s-mq0xsmes-e17c5a11, agent 676UNZFU): a backgrounded
    // sub-agent whose worker died mid-run leaves an agent_start with no
    // agent_end in the transcript. Replay must not render it as a perpetual
    // spinner — seal it as done-with-interrupted.
    const items: FoldItem[] = [
      { kind: "user", text: "do a big task" },
      { kind: "stream", event: { type: "agent_start", agentId: "676UNZFU", description: "long task" } },
      { kind: "stream", event: { type: "text_delta", text: "partial work", agentId: "676UNZFU" } },
      // ...worker died here. No agent_end ever persisted.
    ];
    const state = foldTranscript(items);
    const agent = state.messages.find((m) => m.kind === "agent") as
      | { done: boolean; error?: string; text?: string }
      | undefined;
    expect(agent).toBeDefined();
    expect(agent!.done).toBe(true); // not stuck working
    expect(agent!.error).toBeTruthy(); // shows an interrupted note
    expect(state.activeAgents).toEqual({}); // nothing left "running"
  });

  it("does NOT touch a sub-agent that completed normally (agent_start + agent_end)", () => {
    const items: FoldItem[] = [
      { kind: "stream", event: { type: "agent_start", agentId: "ok1", description: "task" } },
      { kind: "stream", event: { type: "agent_end", agentId: "ok1", description: "task", text: "result" } },
    ];
    const state = foldTranscript(items);
    const agent = state.messages.find((m) => m.kind === "agent") as
      | { done: boolean; error?: string; text?: string }
      | undefined;
    expect(agent!.done).toBe(true);
    expect(agent!.error).toBeUndefined(); // clean completion, no interrupted note
    expect(agent!.text).toBe("result");
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
