import { test, expect } from "bun:test";
import { foldTranscript } from "../../../packages/desktop/src/renderer/automation/foldTranscript";
import { mergeHistoryWindows } from "../../../packages/desktop/src/renderer/app/mergeHistoryWindows";
import type { Message } from "../../../packages/desktop/src/renderer/types";

function snapshot(messages: Message[]) {
  return { ...foldTranscript([]), messages };
}

test("round 1: durable window prefix and cached interruption stay in their turns", () => {
  const user = (id: string, intent: string): Message => ({ id, kind: "user", text: "continue", clientMessageId: intent });
  const disk = snapshot([user("d-one", "one"), user("d-two", "two"), { id: "d-answer", kind: "assistant", text: "second answer", done: true }]);
  const saved = snapshot([
    user("prefix", "old"),
    user("s-one", "one"),
    { id: "interrupted", kind: "assistant", text: "partial first answer", done: false },
    user("s-two", "two"),
    { id: "s-answer", kind: "assistant", text: "second answer", done: true },
  ]);
  const merged = mergeHistoryWindows(disk, saved);
  expect(merged.messages.map(m => m.id)).toEqual(["prefix", "d-one", "interrupted", "d-two", "d-answer"]);
  console.log(JSON.stringify({ observation: "durable-prefix-interrupted-reply", messageIds: merged.messages.map(m => m.id) }));
});

test("round 1: unrelated repeated legacy text cannot import a cached prefix", () => {
  const disk = foldTranscript([{ kind: "user", text: "continue", timestamp: 9 }]);
  const saved = foldTranscript([{ kind: "user", text: "old", timestamp: 1 }, { kind: "user", text: "continue", timestamp: 2 }]);
  const merged = mergeHistoryWindows(disk, saved);
  expect(merged.messages).toHaveLength(1);
  expect(merged.messages[0]).toMatchObject({ text: "continue", createdAt: 9 });
});
