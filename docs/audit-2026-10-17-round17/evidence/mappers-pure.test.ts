import { expect, test } from "bun:test";
import {
  ccHistoryToEvents,
  roomHistoryToEvents,
  roomMsgToEvent,
} from "/Users/admin/.codex/worktrees/repo-audit-20261016/codeshell/packages/web/src/lib/messageMappers.ts";

// Ordinary RoomManager persisted objects and maintained HistoryMessage objects only.
// No producer/parser/reducer/hooks/UI, transport, transcript, disk, or runtime host imports.
const room = (partial: Record<string, unknown>) => ({ seq: 1, ts: 1700000000000, ...partial });

test("persisted user, assistant and system anchor retain their documented event forms", () => {
  expect(roomMsgToEvent(room({ from: "user", type: "text", text: "review owned sample" }))).toEqual({ type: "user_message", text: "review owned sample" });
  expect(roomMsgToEvent(room({ from: "agent", type: "text", text: "I will inspect it" }))).toEqual({ type: "assistant_text", text: "I will inspect it" });
  expect(roomMsgToEvent(room({ from: "system", type: "room_created", text: "cwd=/owned" }))).toEqual({ type: "_noop" });
});

test("ordinary room user attachment metadata is forwarded without rewriting original text", () => {
  const attachments = [{ name: "owned.png", mime: "image/png", size: 68, path: ".code-shell/uploads/owned.png" }];
  const input = Object.freeze(room({ from: "user", type: "text", text: "inspect this", attachments }));
  const mapped = roomMsgToEvent(input) as any;
  expect(mapped).toEqual({ type: "user_message", text: "inspect this", attachments });
  expect(mapped.attachments).toBe(attachments);
  expect(input.text).toBe("inspect this");
});

test("room tool starts and out-of-order results keep real producer ids and full args", () => {
  const argsA = Object.freeze({ file_path: "/owned/a.ts", offset: 1 });
  const argsB = Object.freeze({ file_path: "/owned/b.ts", offset: 1 });
  const events = roomHistoryToEvents([
    room({ seq: 2, from: "agent", type: "tool", tool: "Read", summary: "a.ts", args: argsA, toolId: "toolu_owned_a" }),
    room({ seq: 3, from: "agent", type: "tool", tool: "Read", summary: "b.ts", args: argsB, toolId: "toolu_owned_b" }),
    room({ seq: 4, from: "agent", type: "tool_result", summary: "B", isError: false, toolId: "toolu_owned_b" }),
    room({ seq: 5, from: "agent", type: "tool_result", summary: "A", isError: false, toolId: "toolu_owned_a" }),
  ]) as any[];
  expect(events.map((e) => e.toolCall?.id ?? e.result?.id)).toEqual(["toolu_owned_a", "toolu_owned_b", "toolu_owned_b", "toolu_owned_a"]);
  expect(events[0].toolCall.args).toBe(argsA);
  expect(events[1].toolCall.args).toBe(argsB);
  expect(events[2].result.result).toBe("B");
  expect(events[3].result.result).toBe("A");
});

test("legacy persisted tool lines keep sequence ids and id-less result event", () => {
  expect(roomMsgToEvent(room({ seq: 7, from: "agent", type: "tool", tool: "Read", summary: "owned.ts" }))).toEqual({ type: "tool_use_start", toolCall: { id: "room-tool-7", toolName: "Read", summary: "owned.ts" } });
  expect(roomMsgToEvent(room({ seq: 8, from: "agent", type: "tool_result", summary: "owned content", isError: true }))).toEqual({ type: "room_tool_result", summary: "owned content", isError: true });
});

test("normal persisted turn, error and process-exit lines preserve mapper contracts", () => {
  expect(roomMsgToEvent(room({ from: "agent", type: "turn_end", reason: "completed" }))).toEqual({ type: "turn_complete", reason: "completed" });
  expect(roomMsgToEvent(room({ from: "system", type: "error", text: "owned diagnostic" }))).toEqual({ type: "error", error: "owned diagnostic" });
  expect(roomMsgToEvent(room({ from: "system", type: "agent_exit", reason: "0" }))).toEqual({ type: "error", error: "agent 退出 (code 0)" });
});

test("room replay preserves prose/tool interleaving and leaves the input unchanged", () => {
  const messages = Object.freeze([
    Object.freeze(room({ seq: 1, from: "user", type: "text", text: "review" })),
    Object.freeze(room({ seq: 2, from: "agent", type: "text", text: "before" })),
    Object.freeze(room({ seq: 3, from: "agent", type: "tool", tool: "Read", summary: "owned.ts", toolId: "owned_read" })),
    Object.freeze(room({ seq: 4, from: "agent", type: "tool_result", summary: "owned", isError: false, toolId: "owned_read" })),
    Object.freeze(room({ seq: 5, from: "agent", type: "text", text: "after" })),
    Object.freeze(room({ seq: 6, from: "agent", type: "turn_end", reason: "completed" })),
  ]);
  const before = JSON.stringify(messages);
  const mapped = roomHistoryToEvents(messages) as any[];
  expect(mapped.map((e) => e.type)).toEqual(["user_message", "assistant_text", "tool_use_start", "tool_result", "assistant_text", "turn_complete"]);
  expect(mapped.filter((e) => e.type === "assistant_text").map((e) => e.text)).toEqual(["before", "after"]);
  expect(JSON.stringify(messages)).toBe(before);
});

test("maintained HistoryMessage role/text/tools projection preserves ordinary prose order and args", () => {
  const args = Object.freeze({ file_path: "/owned/sample.ts", limit: 20 });
  const messages = Object.freeze([
    Object.freeze({ role: "user", text: "review sample" }),
    Object.freeze({ role: "assistant", text: "I will read it", tools: Object.freeze([Object.freeze({ name: "Read", summary: "sample.ts", args })]) }),
    Object.freeze({ role: "assistant", text: "The sample is clear" }),
  ]);
  const before = JSON.stringify(messages);
  const events = ccHistoryToEvents(messages) as any[];
  expect(events.map((e) => e.type)).toEqual(["user_message", "assistant_text", "tool_use_start", "turn_complete", "assistant_text", "turn_complete"]);
  expect(events[0].text).toBe("review sample");
  expect(events[1].text).toBe("I will read it");
  expect(events[2].toolCall.args).toBe(args);
  expect(events[4].text).toBe("The sample is clear");
  expect(JSON.stringify(messages)).toBe(before);
});

test("multiple HistoryMessage tools have distinct deterministic positional snapshot ids", () => {
  const messages = [
    { role: "user", text: "read samples" },
    { role: "assistant", text: "", tools: [{ name: "Read", summary: "a.ts" }, { name: "Read", summary: "b.ts" }] },
    { role: "assistant", text: "done", tools: [{ name: "Read", summary: "c.ts" }] },
  ];
  const events = ccHistoryToEvents(messages) as any[];
  const ids = events.filter((e) => e.type === "tool_use_start").map((e) => e.toolCall.id);
  expect(ids).toEqual(["cc-hist-1-0", "cc-hist-1-1", "cc-hist-2-0"]);
  expect(new Set(ids).size).toBe(3);
  expect(ccHistoryToEvents(messages)).toEqual(events);
});

test("characterization: a snapshot tool start and a later real-id room result carry different ids", () => {
  // The HistoryMessage contract contains no original tool id. Static follower
  // wiring can deliver a snapshot while active; this test does not execute it
  // and makes no reducer, visual, loss, or end-to-end matching assertion.
  const snapshot = ccHistoryToEvents([{ role: "assistant", text: "", tools: [{ name: "Read", summary: "owned.ts", args: { file_path: "/owned/owned.ts" } }] }]) as any[];
  const result = roomMsgToEvent(room({ from: "agent", type: "tool_result", summary: "owned text", isError: false, toolId: "toolu_owned_running" })) as any;
  const liveStart = roomMsgToEvent(room({ from: "agent", type: "tool", tool: "Read", summary: "owned.ts", toolId: "toolu_owned_running" })) as any;
  expect(snapshot[0].toolCall.id).toBe("cc-hist-0-0");
  expect(result.result.id).toBe("toolu_owned_running");
  expect(snapshot[0].toolCall.id).not.toBe(result.result.id);
  expect(liveStart.toolCall.id).toBe(result.result.id);
  expect(snapshot[1]).toEqual({ type: "turn_complete", reason: "completed" });
});
