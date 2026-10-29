import { describe, expect, test } from "bun:test";
import type { StreamEvent, TranscriptEvent } from "../types.js";
import { outputUserMessage } from "../engine/run-output-user-message.js";
import { compareNativeOutputHistory } from "./output-history-native-comparison.js";

const sid = "owned-session",
  cwd = "/owned";
function fixture() {
  let index = 0;
  const transcript: TranscriptEvent[] = [];
  const events: StreamEvent[] = [];
  const record = (type: TranscriptEvent["type"], data: Record<string, unknown>) => {
    const event = { id: `event-${index++}`, type, timestamp: index, turnNumber: 0, data };
    transcript.push(event);
    return event;
  };
  const emit = (event: StreamEvent) => {
    events.push(event);
    return event;
  };
  const user = (text: string, id = `input-${index}`, injected = false, publish = true) => {
    const event = record("message", {
      role: "user",
      content: text,
      ...(injected ? { injected: true } : { clientMessageId: id }),
    });
    if (publish) emit(outputUserMessage(event.data, sid, cwd));
    return event;
  };
  const text = (value: string) => {
    record("message", { role: "assistant", content: value });
    emit({ type: "text_delta", text: value });
  };
  const boundary = () => record("turn_boundary", { turnNumber: index });
  const done = () => emit({ type: "turn_complete", reason: "completed" });
  const call = (id: string, args: Record<string, unknown>) => ({ id, name: "Read", args });
  const tool = (id: string, args: Record<string, unknown>, blockArgs = args) => {
    record("tool_use", { toolCallId: id, toolName: "Read", args });
    record("message", {
      role: "assistant",
      content: [{ type: "tool_use", id, name: "Read", input: blockArgs }],
    });
  };
  const result = (id: string, value = "result") => {
    record("tool_result", { toolCallId: id, toolName: "Read", result: value });
    emit({ type: "tool_result", result: { id, toolName: "Read", result: value, isError: false } });
  };
  record("session_meta", { sessionId: sid });
  return {
    transcript,
    events,
    record,
    emit,
    user,
    text,
    boundary,
    done,
    tool,
    result,
    call,
    compare: (options = {}) => compareNativeOutputHistory(transcript, events, sid, cwd, options),
  };
}
function retained(events: StreamEvent[], checkpoint?: StreamEvent[]) {
  if (!checkpoint) return;
  let last = -1;
  for (const event of events) {
    const index = checkpoint.indexOf(event);
    expect(index).toBeGreaterThan(last);
    last = index;
  }
}

describe("known native and external history projection proof", () => {
  test("model request audit and multiple native model steps do not masquerade as Run boundaries", () => {
    const f = fixture();
    f.user("question");
    const audit = f.record("model_request_boundary", { version: 1, logicalCallId: "logical" });
    f.record("model_request_attempt", {
      version: 1,
      boundaryEventId: audit.id,
      phase: "before-fetch",
    });
    f.text("first");
    f.boundary();
    f.text("second");
    f.boundary();
    f.done();
    expect(f.compare()).toEqual({
      ok: true,
      comparison: { turns: 2, userInputs: 1, toolCalls: 0, toolResults: 0 },
    });
  });
  test("Goal provider boundaries with suppressed terminals remain separate input scopes", () => {
    const f = fixture();
    f.user("question");
    f.text("one");
    f.boundary();
    f.user("continue privately", "ignored", true);
    f.text("two");
    f.boundary();
    f.done();
    expect(f.compare()).toMatchObject({ ok: true, comparison: { turns: 2, userInputs: 2 } });
    (f.events.find((event) => event.type === "text_delta") as any).text = "changed";
    expect(f.compare()).toEqual({ ok: false, reason: "history_mismatch" });
  });
  test("replays deferred commits and early assistant block flushes without overwriting final args", () => {
    const f = fixture();
    f.user("tools");
    f.emit({ type: "tool_use_start", toolCall: { id: "a", toolName: "Read", args: {} } });
    f.emit({ type: "tool_use_start", toolCall: { id: "b", toolName: "Read", args: {} } });
    f.emit({ type: "tool_use_args_delta", toolCallId: "b", args: { path: "b" } });
    f.record("tool_use", { toolCallId: "b", toolName: "Read", args: { path: "b" } });
    f.record("message", {
      role: "assistant",
      content: [
        { type: "tool_use", id: "a", name: "Read", input: {} },
        { type: "tool_use", id: "b", name: "Read", input: { path: "b" } },
      ],
    });
    f.result("b");
    f.emit({ type: "tool_use_args_delta", toolCallId: "a", args: { path: "a" } });
    f.record("tool_use", { toolCallId: "a", toolName: "Read", args: { path: "a" } });
    f.result("a");
    f.boundary();
    f.done();
    const before = JSON.stringify(f.events);
    expect(f.compare()).toMatchObject({ ok: true, comparison: { toolCalls: 2, toolResults: 2 } });
    expect(JSON.stringify(f.events)).toBe(before);
    (f.transcript.find((event) => event.type === "tool_use")!.data.args as any).path = "unproved";
    expect(f.compare()).toEqual({ ok: false, reason: "history_mismatch" });
  });
  test("early prose commits opening args while a later raw delta stays intact", () => {
    const f = fixture();
    f.user("tool");
    f.emit({ type: "tool_use_start", toolCall: { id: "a", toolName: "Read", args: {} } });
    f.tool("a", {});
    f.text("prose");
    f.emit({ type: "tool_use_args_delta", toolCallId: "a", args: { path: "actual" } });
    f.result("a");
    f.boundary();
    f.done();
    expect(f.compare().ok).toBe(true);
    expect((f.events.find((event) => event.type === "tool_use_args_delta") as any).args).toEqual({
      path: "actual",
    });
  });
  test("inserts only the exact durable external unfinished-tool error", () => {
    const f = fixture();
    f.user("tool");
    f.emit({ type: "tool_use_start", toolCall: { id: "a", toolName: "Read", args: {} } });
    f.tool("a", {});
    f.record("tool_result", {
      toolCallId: "a",
      toolName: "Read",
      error: "External runtime turn ended before this tool returned a result.",
    });
    f.boundary();
    f.done();
    const proof = f.compare();
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    retained(f.events, proof.checkpointEvents);
    expect(proof.checkpointEvents?.filter((event) => !f.events.includes(event))).toEqual([
      {
        type: "tool_result",
        result: {
          id: "a",
          toolName: "Read",
          error: "External runtime turn ended before this tool returned a result.",
          isError: true,
        },
      },
    ]);
    f.transcript.find((event) => event.type === "tool_result")!.data.error =
      "unknown missing result";
    expect(f.compare()).toEqual({ ok: false, reason: "history_mismatch" });
  });
  test("retains stopped markers and canonical errors at their known display anchors", () => {
    const f = fixture();
    f.user("first");
    f.record("turn_stopped", {});
    const second = f.user("second");
    f.record("error", { error: "owned failure" });
    f.text("answer");
    f.boundary();
    f.done();
    const proof = f.compare();
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    retained(f.events, proof.checkpointEvents);
    const checkpoint = proof.checkpointEvents!;
    expect(checkpoint.findIndex((event) => event.type === "turn_complete")).toBeLessThan(
      checkpoint.findIndex(
        (event) =>
          event.type === "session_user_message" &&
          event.clientMessageId === second.data.clientMessageId,
      ),
    );
    expect(checkpoint.findIndex((event) => event.type === "error")).toBeLessThan(
      checkpoint.findIndex((event) => event.type === "text_delta"),
    );
  });
  test("accepts existing external aborted terminal without fabricating a native stop marker", () => {
    const f = fixture();
    f.user("question");
    f.text("partial");
    f.boundary();
    f.emit({ type: "turn_complete", reason: "aborted_streaming" });
    expect(f.compare()).toMatchObject({ ok: true });
  });
  test("only a verified legacy cutoff excludes a closed historical prefix", () => {
    const f = fixture();
    f.user("old");
    f.text("old answer");
    const anchor = f.boundary();
    f.events.length = 0;
    f.user("new");
    f.text("new answer");
    f.boundary();
    f.done();
    expect(f.compare({ legacyBaseThroughEventId: anchor.id })).toMatchObject({
      ok: true,
      comparison: { turns: 2, userInputs: 2 },
    });
    expect(f.compare().ok).toBe(false);
    expect(f.compare({ legacyBaseThroughEventId: "missing" })).toEqual({
      ok: false,
      reason: "unsupported_history",
    });
  });
  test("verified parent anchors keep complete child tool displays separate from parent context", () => {
    const f = fixture();
    f.user("parent");
    f.record("subagent", { agentId: "child", description: "owned task" });
    f.emit({ type: "agent_start", agentId: "child", name: "Helper", description: "owned task" });
    f.emit({
      type: "tool_use_start",
      agentId: "child",
      toolCall: { id: "child-tool", toolName: "Read", args: {} },
    });
    f.emit({
      type: "tool_result",
      agentId: "child",
      result: { id: "child-tool", toolName: "Read", result: "owned result", isError: false },
    });
    f.text("parent answer");
    f.boundary();
    f.done();
    expect(f.compare()).toMatchObject({ ok: true, comparison: { toolCalls: 1, toolResults: 1 } });
    f.events.splice(3, 1);
    expect(f.compare().ok).toBe(false);
  });
  test("unpublished input needs an adjacent matching terminal error receipt", () => {
    const f = fixture();
    f.user("failed request", "failed-input", false, false);
    f.record("error", { error: "owned initialization failure", phase: "initialization" });
    const receipt = f.record("run_result", {
      clientMessageId: "failed-input",
      result: { reason: "model_error", sessionId: sid, text: "ERROR", turnCount: 0 },
    });
    f.user("later request");
    f.text("answer");
    f.boundary();
    f.done();
    const proof = f.compare();
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    retained(f.events, proof.checkpointEvents);
    expect(proof.checkpointEvents?.slice(0, 3).map((event) => event.type)).toEqual([
      "session_user_message",
      "error",
      "turn_complete",
    ]);
    receipt.data.clientMessageId = "different-input";
    expect(f.compare().ok).toBe(false);
  });
  test("a final hidden initialization failure requires the exact persisted terminal status", () => {
    const f = fixture();
    f.user("parent");
    f.text("done");
    f.boundary();
    f.done();
    f.user("private continuation", "unused", true, false);
    f.record("error", { error: "owned init failure", phase: "initialization" });
    expect(f.compare().ok).toBe(false);
    expect(f.compare({ terminalStatus: "active" }).ok).toBe(false);
    const proof = f.compare({ terminalStatus: "model_error" });
    expect(proof.ok).toBe(true);
    if (!proof.ok) return;
    retained(f.events, proof.checkpointEvents);
    expect(
      proof.checkpointEvents
        ?.filter((event) => !f.events.includes(event))
        .map((event) => event.type),
    ).toEqual(["error", "turn_complete"]);
    f.transcript.at(-1)!.data.phase = "unknown";
    expect(f.compare({ terminalStatus: "model_error" }).ok).toBe(false);
  });

  test("a delayed receipt for an old input cannot prove a newer unfinished input", () => {
    const f = fixture();
    f.user("old", "old-input");
    f.text("old answer");
    f.boundary();
    f.done();
    f.user("new", "new-input");
    f.record("run_result", {
      clientMessageId: "old-input",
      result: { reason: "completed", sessionId: sid, text: "old answer", turnCount: 1 },
    });
    f.done();
    expect(f.compare()).toEqual({ ok: false, reason: "unsupported_history" });
  });

  test("unknown user block formats cannot disappear through the display projection", () => {
    const f = fixture();
    f.user("question");
    f.text("answer");
    f.boundary();
    f.done();
    f.transcript[1].data.content = [{ type: "unknown", text: "must remain visible" }];
    expect(f.compare()).toEqual({ ok: false, reason: "unsupported_history" });
  });

  test("unknown, truncated, incomplete, duplicate and mismatched evidence stays blocked", () => {
    for (const mutate of [
      (f: ReturnType<typeof fixture>) => {
        f.record("summary", { summary: "unknown" });
      },
      (f: ReturnType<typeof fixture>) => {
        f.transcript.pop();
      },
      (f: ReturnType<typeof fixture>) => {
        (f.events[1] as any).outputRecovery = "incomplete";
      },
      (f: ReturnType<typeof fixture>) => {
        f.transcript.push(f.transcript[1]);
      },
      (f: ReturnType<typeof fixture>) => {
        (f.events[1] as any).text = "different";
      },
      (f: ReturnType<typeof fixture>) => {
        f.events.push({ type: "unknown" } as any);
      },
    ]) {
      const f = fixture();
      f.user("request");
      f.text("answer");
      f.boundary();
      f.done();
      mutate(f);
      expect(f.compare().ok).toBe(false);
    }
  });
});
