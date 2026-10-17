import { expect, mock, test } from "bun:test";

// These imports serve only TextRenderer; prohibit accidental calls and imports
// of its coupled Core/render-width dependencies. Real chalk is left untouched.
let textHelperCalls = 0;
const forbiddenTextHelper = () => {
  textHelperCalls++;
  throw new Error("Text helper invoked outside this JSON-only fixture");
};
mock.module("@cjhyy/code-shell-core/internal", () => ({
  formatToolArgs: forbiddenTextHelper,
  singleLine: forbiddenTextHelper,
  formatBytes: forbiddenTextHelper,
}));
mock.module("/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/ui/truncate.ts", () => ({
  truncate: forbiddenTextHelper,
}));
const { createRenderer, JsonRenderer, JsonlRenderer, StreamJsonRenderer } = await import(
  "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/tui/src/cli/output/renderer.ts"
);

function capture(action: () => void): string[] {
  const original = process.stdout.write;
  const chunks: string[] = [];
  process.stdout.write = ((chunk: string | Uint8Array) => {
    chunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk).toString("utf8"));
    return true;
  }) as typeof process.stdout.write;
  try {
    action();
  } finally {
    process.stdout.write = original;
  }
  expect(textHelperCalls).toBe(0);
  return chunks;
}
const meta = { sessionId: "owned-session", turnCount: 2 };

test("json factory uses actual class and buffers events until completion", () => {
  const r = createRenderer("json");
  expect(r).toBeInstanceOf(JsonRenderer);
  expect(capture(() => r.onEvent({ type: "text_delta", text: "draft" }))).toEqual([]);
});

test("json nonempty final text is authoritative over earlier ordinary deltas", () => {
  const r = createRenderer("json");
  const chunks = capture(() => {
    r.onEvent({ type: "text_delta", text: "intermediate answer" });
    r.onComplete("final answer", "completed", meta);
  });
  expect(chunks).toHaveLength(1);
  expect(JSON.parse(chunks[0]!)).toEqual({ result: "final answer", reason: "completed", ...meta });
});

test("json empty completion without deltas stays empty", () => {
  const r = createRenderer("json");
  const chunks = capture(() => r.onComplete("", "aborted_streaming", meta));
  expect(JSON.parse(chunks[0]!)).toEqual({ result: "", reason: "aborted_streaming", ...meta });
});

test("json retains ordinary session metadata and Unicode final content", () => {
  const r = createRenderer("json");
  const m = { sessionId: "session-中文-🙂", turnCount: 0 };
  const chunks = capture(() => r.onComplete("你好🙂", "completed", m));
  expect(JSON.parse(chunks[0]!)).toEqual({ result: "你好🙂", reason: "completed", ...m });
  expect(m).toEqual({ sessionId: "session-中文-🙂", turnCount: 0 });
});

test("json ignores ordinary non-text stream frames", () => {
  const r = createRenderer("json");
  const chunks = capture(() => {
    r.onEvent({ type: "stream_request_start", turnNumber: 1, runId: "run-owned" });
    r.onEvent({ type: "tool_result", result: { id: "tc-owned", toolName: "Read", result: "owned data" } });
    r.onEvent({ type: "turn_complete", reason: "completed", text: "terminal frame" });
    r.onComplete("final answer", "completed", meta);
  });
  expect(chunks).toHaveLength(1);
  expect(JSON.parse(chunks[0]!).result).toBe("final answer");
});

test("json escapes ordinary quotes and line breaks in string values", () => {
  const text = 'line 1\nline 2\r\n"quoted"\t\\';
  const chunks = capture(() => createRenderer("json").onComplete(text, "completed", meta));
  expect(chunks[0]!.endsWith("\n")).toBe(true);
  expect(JSON.parse(chunks[0]!).result).toBe(text);
});

test("json preserves a non-completed terminal reason with final content", () => {
  const chunks = capture(() => createRenderer("json").onComplete("partial", "max_turns", meta));
  expect(JSON.parse(chunks[0]!)).toEqual({ result: "partial", reason: "max_turns", ...meta });
});

for (const [format, Class] of [["jsonl", JsonlRenderer], ["stream-json", StreamJsonRenderer]] as const) {
  test(`${format} factory and ordered event framing retain child and cursor identities`, () => {
    const r = createRenderer(format);
    expect(r).toBeInstanceOf(Class);
    const events = [
      { type: "session_started", sessionId: "owned-session", promptTokens: 0, runId: "run-owned", timestamp: 1000 },
      { type: "text_delta", text: "parent\ntext" },
      { type: "text_delta", text: "child\r\ntext", agentId: "child-owned", outputCursor: "cursor-owned" },
      { type: "turn_complete", reason: "completed", text: "final", completionKind: "background_wait", durationMs: 25 },
    ] as const;
    const chunks = capture(() => { for (const e of events) r.onEvent(e); });
    expect(chunks).toHaveLength(events.length);
    expect(chunks.map((s) => JSON.parse(s))).toEqual(events);
    expect(chunks.every((s) => s.endsWith("\n") && s.split("\n").length === 2)).toBe(true);
  });

  test(`${format} final envelope uses ordinary metadata and exactly one newline`, () => {
    const chunks = capture(() => createRenderer(format).onComplete("final", "completed", meta));
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.split("\n")).toHaveLength(2);
    expect(JSON.parse(chunks[0]!)).toEqual({ type: "result", text: "final", reason: "completed", ...meta });
  });

  test(`${format} empty final text remains distinct from prior stream events`, () => {
    const r = createRenderer(format);
    const chunks = capture(() => {
      r.onEvent({ type: "text_delta", text: "intermediate" });
      r.onComplete("", "aborted_streaming", meta);
    });
    expect(chunks).toHaveLength(2);
    expect(JSON.parse(chunks[1]!)).toEqual({ type: "result", text: "", reason: "aborted_streaming", ...meta });
  });

  test(`${format} serialization leaves an ordinary event object unchanged`, () => {
    const r = createRenderer(format);
    const event = { type: "tool_result", result: { id: "tc-owned", toolName: "Read", result: 'text "owned"\nnext' }, agentId: "child-owned" } as const;
    const before = structuredClone(event);
    const chunks = capture(() => r.onEvent(event));
    expect(event).toEqual(before);
    expect(JSON.parse(chunks[0]!)).toEqual(before);
  });
}

test("jsonl and stream-json aliases emit identical bytes for ordinary events and final metadata", () => {
  const output = (format: "jsonl" | "stream-json") => capture(() => {
    const r = createRenderer(format);
    r.onEvent({ type: "error", error: "owned failure\nline" });
    r.onComplete("partial", "model_error", meta);
  });
  expect(output("jsonl")).toEqual(output("stream-json"));
});
